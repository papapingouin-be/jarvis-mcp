import { JarvisGitBridgeError } from "../services/errors.js";

export type QueryResultRow = Record<string, unknown>;

type PgPoolClient = {
  query: (sql: string, params?: Array<unknown>) => Promise<{ rows: Array<QueryResultRow> }>;
  end?: () => Promise<void>;
};

export type DatabaseClient = {
  query: <TRow extends QueryResultRow>(sql: string, params?: Array<unknown>) => Promise<Array<TRow>>;
  close: () => Promise<void>;
};

type PgModule = {
  Pool: new (config: { connectionString: string }) => PgPoolClient;
};

function buildDatabaseUrlFromJarvisTools(): string | null {
  const hostPort = process.env.jarvis_tools_PG_URL?.trim();
  const database = process.env.jarvis_tools_PG_DB?.trim();
  const user = process.env.jarvis_tools_PG_USER?.trim();
  const password = process.env.jarvis_tools_PG_PASSWORD?.trim();

  if (!hostPort || !database || !user || !password) {
    return null;
  }

  const encodedUser = encodeURIComponent(user);
  const encodedPassword = encodeURIComponent(password);

  if (hostPort.startsWith("postgres://") || hostPort.startsWith("postgresql://")) {
    return `${hostPort.replace(/\/+$/g, "")}/${database}`;
  }

  return `postgresql://${encodedUser}:${encodedPassword}@${hostPort}/${database}`;
}

function resolveDatabaseConnectionString(): string {
  const direct = process.env.DATABASE_URL?.trim();
  if (direct) {
    return direct;
  }

  const jarvisToolsDirect = process.env.jarvis_tools_DATABASE_URL?.trim();
  if (jarvisToolsDirect) {
    return jarvisToolsDirect;
  }

  const fromParts = buildDatabaseUrlFromJarvisTools();
  if (fromParts) {
    return fromParts;
  }

  throw new JarvisGitBridgeError(
    "DATABASE_URL_MISSING",
    "DATABASE_URL is required (or jarvis_tools_PG_URL/jarvis_tools_PG_DB/jarvis_tools_PG_USER/jarvis_tools_PG_PASSWORD)"
  );
}

async function loadPgModule(): Promise<PgModule> {
  const moduleName = process.env.JARVIS_GIT_BRIDGE_PG_MODULE?.trim()
    || process.env.jarvis_tools_GIT_BRIDGE_PG_MODULE?.trim()
    || "pg";

  try {
    return await import(moduleName) as PgModule;
  } catch {
    throw new JarvisGitBridgeError(
      "PG_MODULE_MISSING",
      "PostgreSQL driver is required. Install pg and set DATABASE_URL"
    );
  }
}

export async function createDatabaseClientFromEnv(): Promise<DatabaseClient> {
  const connectionString = resolveDatabaseConnectionString();
  const pgModule = await loadPgModule();
  const pool = new pgModule.Pool({ connectionString });

  return {
    async query<TRow extends QueryResultRow>(sql: string, params: Array<unknown> = []): Promise<Array<TRow>> {
      const result = await pool.query(sql, params);
      return result.rows as Array<TRow>;
    },
    async close(): Promise<void> {
      if (typeof pool.end === "function") {
        await pool.end();
      }
    },
  };
}
