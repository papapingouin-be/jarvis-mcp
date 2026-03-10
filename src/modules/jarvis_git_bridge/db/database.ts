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

async function loadPgModule(): Promise<PgModule> {
  const moduleName = process.env.JARVIS_GIT_BRIDGE_PG_MODULE?.trim() || "pg";

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
  const connectionString = process.env.DATABASE_URL?.trim();
  if (typeof connectionString !== "string" || connectionString.length === 0) {
    throw new JarvisGitBridgeError("DATABASE_URL_MISSING", "DATABASE_URL is required");
  }

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
