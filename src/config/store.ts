import type { DatabaseClient } from "../modules/jarvis_git_bridge/db/database.js";
import type { ScriptDefinition, ScriptRegistry } from "../modules/script_runner/types/domain.js";

type AppConfigRow = {
  config_key: string;
  config_value: unknown;
};

type ScriptRegistryRow = {
  script_name: string;
  file_name: string;
  required_env_json: unknown;
};

function parseStringArray(input: unknown): Array<string> {
  if (Array.isArray(input)) {
    return input
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }

  if (typeof input === "string") {
    try {
      return parseStringArray(JSON.parse(input) as unknown);
    } catch {
      return [];
    }
  }

  return [];
}

function toScriptDefinition(row: ScriptRegistryRow): ScriptDefinition {
  return {
    name: row.script_name,
    file_name: row.file_name,
    required_env: parseStringArray(row.required_env_json),
  };
}

export async function runConfigStoreMigrations(db: DatabaseClient): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS jarvis_app_config (
      config_key VARCHAR(255) PRIMARY KEY,
      config_value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS jarvis_script_registry (
      script_name VARCHAR(128) PRIMARY KEY,
      file_name VARCHAR(255) NOT NULL,
      required_env_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_jarvis_script_registry_active
    ON jarvis_script_registry(is_active, script_name)
  `);
}

export class AppConfigRepository {
  private readonly db: DatabaseClient;

  constructor(db: DatabaseClient) {
    this.db = db;
  }

  async getMany(keys: Array<string>): Promise<Record<string, unknown>> {
    if (keys.length === 0) {
      return {};
    }

    const rows = await this.db.query<AppConfigRow>(
      `
      SELECT config_key, config_value
      FROM jarvis_app_config
      WHERE config_key = ANY($1::text[])
      `,
      [keys]
    );

    return Object.fromEntries(rows.map((row) => [row.config_key, row.config_value]));
  }

  async upsert(key: string, value: unknown): Promise<void> {
    await this.db.query(
      `
      INSERT INTO jarvis_app_config (config_key, config_value, updated_at)
      VALUES ($1, $2::jsonb, NOW())
      ON CONFLICT (config_key)
      DO UPDATE SET
        config_value = EXCLUDED.config_value,
        updated_at = NOW()
      `,
      [key, JSON.stringify(value)]
    );
  }
}

export class ScriptRegistryRepository {
  private readonly db: DatabaseClient;

  constructor(db: DatabaseClient) {
    this.db = db;
  }

  async listActive(): Promise<ScriptRegistry> {
    const rows = await this.db.query<ScriptRegistryRow>(
      `
      SELECT script_name, file_name, required_env_json
      FROM jarvis_script_registry
      WHERE is_active = TRUE
      ORDER BY script_name ASC
      `
    );

    return Object.fromEntries(
      rows.map((row) => {
        const definition = toScriptDefinition(row);
        return [definition.name, definition];
      })
    );
  }

  async seedDefaultsIfEmpty(defaults: ScriptRegistry): Promise<void> {
    const rows = await this.db.query<{ count: number | string }>(
      "SELECT COUNT(*) AS count FROM jarvis_script_registry WHERE is_active = TRUE"
    );
    const activeCount = Number(rows[0]?.count ?? 0);

    if (activeCount > 0) {
      return;
    }

    for (const definition of Object.values(defaults)) {
      await this.db.query(
        `
        INSERT INTO jarvis_script_registry (script_name, file_name, required_env_json, is_active, updated_at)
        VALUES ($1, $2, $3::jsonb, TRUE, NOW())
        ON CONFLICT (script_name)
        DO UPDATE SET
          file_name = EXCLUDED.file_name,
          required_env_json = EXCLUDED.required_env_json,
          is_active = TRUE,
          updated_at = NOW()
        `,
        [definition.name, definition.file_name, JSON.stringify(definition.required_env)]
      );
    }
  }
}
