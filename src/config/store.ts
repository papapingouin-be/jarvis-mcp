import type { DatabaseClient } from "../modules/jarvis_git_bridge/db/database.js";
import type { ScriptDefinition, ScriptEnvDefinition, ScriptRegistry } from "../modules/script_runner/types/domain.js";

type AppConfigRow = {
  config_key: string;
  config_value: unknown;
};

type ScriptRegistryRow = {
  script_name: string;
  file_name: string;
  required_env_json: unknown;
  description: unknown;
};

type ScriptEnvValueRow = {
  script_name: string;
  env_name: string;
  env_value: unknown;
};

function parseScriptEnvDefinitions(input: unknown): Array<ScriptEnvDefinition> {
  if (Array.isArray(input)) {
    return input
      .map((value) => {
        if (typeof value === "string") {
          const trimmed = value.trim();
          return trimmed.length > 0 ? trimmed : null;
        }

        if (typeof value !== "object" || value === null) {
          return null;
        }

        const name = typeof value.name === "string" ? value.name.trim() : "";
        if (name.length === 0) {
          return null;
        }

        return {
          name,
          required: value.required === undefined ? true : value.required === true,
          secret: value.secret === true,
          description: typeof value.description === "string" && value.description.trim().length > 0
            ? value.description.trim()
            : undefined,
        } satisfies Exclude<ScriptEnvDefinition, string>;
      })
      .filter((value): value is ScriptEnvDefinition => value !== null);
  }

  if (typeof input === "string") {
    try {
      return parseScriptEnvDefinitions(JSON.parse(input) as unknown);
    } catch {
      return [];
    }
  }

  return [];
}

function toOptionalString(input: unknown): string | undefined {
  if (typeof input !== "string") {
    return undefined;
  }

  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toScriptDefinition(row: ScriptRegistryRow): ScriptDefinition {
  return {
    name: row.script_name,
    file_name: row.file_name,
    required_env: parseScriptEnvDefinitions(row.required_env_json),
    description: toOptionalString(row.description),
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
      description TEXT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await db.query("ALTER TABLE jarvis_script_registry ADD COLUMN IF NOT EXISTS description TEXT NULL");

  await db.query(`
    CREATE TABLE IF NOT EXISTS jarvis_script_env_values (
      script_name VARCHAR(128) NOT NULL,
      env_name VARCHAR(255) NOT NULL,
      env_value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (script_name, env_name)
    )
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_jarvis_script_registry_active
    ON jarvis_script_registry(is_active, script_name)
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_jarvis_script_env_values_script
    ON jarvis_script_env_values(script_name, env_name)
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
      SELECT script_name, file_name, required_env_json, description
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
        INSERT INTO jarvis_script_registry (script_name, file_name, required_env_json, description, is_active, updated_at)
        VALUES ($1, $2, $3::jsonb, $4, TRUE, NOW())
        ON CONFLICT (script_name)
        DO UPDATE SET
          file_name = EXCLUDED.file_name,
          required_env_json = EXCLUDED.required_env_json,
          description = EXCLUDED.description,
          is_active = TRUE,
          updated_at = NOW()
        `,
        [definition.name, definition.file_name, JSON.stringify(definition.required_env), definition.description ?? null]
      );
    }
  }
}

export class ScriptEnvRepository {
  private readonly db: DatabaseClient;

  constructor(db: DatabaseClient) {
    this.db = db;
  }

  async listByScript(scriptName: string): Promise<Record<string, string>> {
    const rows = await this.db.query<ScriptEnvValueRow>(
      `
      SELECT script_name, env_name, env_value
      FROM jarvis_script_env_values
      WHERE script_name = $1
      ORDER BY env_name ASC
      `,
      [scriptName]
    );

    return Object.fromEntries(
      rows
        .map((row) => {
          const envName = toOptionalString(row.env_name);
          const envValue = toOptionalString(row.env_value);
          return envName === undefined || envValue === undefined ? null : [envName, envValue];
        })
        .filter((entry): entry is [string, string] => entry !== null)
    );
  }

  async upsertMany(scriptName: string, values: Record<string, string>): Promise<void> {
    for (const [envName, envValue] of Object.entries(values)) {
      await this.db.query(
        `
        INSERT INTO jarvis_script_env_values (script_name, env_name, env_value, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (script_name, env_name)
        DO UPDATE SET
          env_value = EXCLUDED.env_value,
          updated_at = NOW()
        `,
        [scriptName, envName, envValue]
      );
    }
  }
}
