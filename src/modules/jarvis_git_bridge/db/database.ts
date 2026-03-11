import { JarvisGitBridgeError } from "../services/errors.js";
import { getGitBridgeEnvConfig } from "../../../config/env.js";

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

function resolveDatabaseConnectionString(): string {
  const config = getGitBridgeEnvConfig();
  if (config.database.connectionString !== undefined) {
    return config.database.connectionString;
  }

  throw new JarvisGitBridgeError(
    "DATABASE_URL_MISSING",
    "DATABASE_URL is required (or jarvis_tools_PG_URL/jarvis_tools_PG_DB/jarvis_tools_PG_USER/jarvis_tools_PG_PASSWORD)"
  );
}

async function loadPgModule(): Promise<PgModule> {
  const { pgModuleName } = getGitBridgeEnvConfig().database;

  try {
    return await import(pgModuleName) as PgModule;
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
