import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisterableModule } from "../registry/types.js";
import { createDatabaseClientFromEnv } from "../modules/jarvis_git_bridge/db/database.js";
import { loadInitialMigrationSql } from "../modules/jarvis_git_bridge/db/migrations.js";
import { runJarvisGitBridgeMigrations } from "../modules/jarvis_git_bridge/db/repositories.js";
import { AppConfigRepository, runConfigStoreMigrations, ScriptEnvRepository, ScriptRegistryRepository } from "../config/store.js";
import { getGitBridgeEnvConfig } from "../config/env.js";
import { JarvisGitBridgeError, asSafeError } from "../modules/jarvis_git_bridge/services/errors.js";
import { ScriptRunnerError, asScriptRunnerError } from "../modules/script_runner/services/errors.js";

type StepName =
  | "resolve_config"
  | "connect_db"
  | "connectivity_query"
  | "git_bridge_migration_asset"
  | "git_bridge_migrations"
  | "config_store_migrations"
  | "app_config_read"
  | "script_registry_read"
  | "script_env_read";

function toSuccessPayload(data: Record<string, unknown>): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{
      type: "text",
      text: JSON.stringify(data),
    }],
  };
}

function buildRecommendations(errorCode: string): Array<string> {
  switch (errorCode) {
    case "DATABASE_URL_MISSING":
      return [
        "Define DATABASE_URL or jarvis_tools_PG_URL/jarvis_tools_PG_DB/jarvis_tools_PG_USER/jarvis_tools_PG_PASSWORD.",
        "Restart the MCP server after updating the environment.",
      ];
    case "PG_MODULE_MISSING":
      return [
        "Install the PostgreSQL driver package 'pg' in the runtime environment.",
        "If you use another driver name, set JARVIS_GIT_BRIDGE_PG_MODULE or jarvis_tools_GIT_BRIDGE_PG_MODULE.",
      ];
    default:
      return [
        "Check database reachability from the MCP runtime container/process.",
        "Check PostgreSQL credentials and permissions.",
        "Inspect the detailed error.debug fields from this autotest.",
      ];
  }
}

function toFailurePayload(
  error: unknown,
  failedStep: StepName,
  checks: Record<string, unknown>,
  configSnapshot: Record<string, unknown>,
): {
  content: Array<{ type: "text"; text: string }>;
} {
  const safeError = error instanceof JarvisGitBridgeError
    ? error
    : error instanceof ScriptRunnerError
      ? asScriptRunnerError(error)
      : asSafeError(error);

  const errorDetails = error instanceof Error
    ? {
        name: error.name,
        raw_message: error.message,
      }
    : {
        raw_message: String(error),
      };

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        ok: false,
        status: "KO",
        failed_step: failedStep,
        checks,
        config: configSnapshot,
        error: {
          code: safeError.code,
          message: safeError.safeMessage,
          debug: errorDetails,
        },
        recommendations: buildRecommendations(safeError.code),
      }),
    }],
  };
}

const jarvisAutotestDbModule: RegisterableModule = {
  type: "tool",
  name: "jarvis_autotest_db",
  description: "Run a database connectivity/config-store autotest and return a JSON report.",
  register(server: McpServer) {
    server.tool(
      "jarvis_autotest_db",
      "Run a database connectivity/config-store autotest and return a JSON report.",
      {},
      async () => {
        let db: Awaited<ReturnType<typeof createDatabaseClientFromEnv>> | undefined;
        let failedStep: StepName = "resolve_config";

        const gitBridgeConfig = getGitBridgeEnvConfig();
        const configSnapshot = {
          connection_string_present: Boolean(gitBridgeConfig.database.connectionString),
          connection_string_source: process.env.DATABASE_URL
            ? "DATABASE_URL"
            : process.env.jarvis_tools_DATABASE_URL
              ? "jarvis_tools_DATABASE_URL"
              : process.env.jarvis_tools_PG_URL
                ? "jarvis_tools_PG_*"
                : "missing",
          pg_module_name: gitBridgeConfig.database.pgModuleName,
          env_presence: {
            DATABASE_URL: Boolean(process.env.DATABASE_URL),
            jarvis_tools_DATABASE_URL: Boolean(process.env.jarvis_tools_DATABASE_URL),
            jarvis_tools_PG_URL: Boolean(process.env.jarvis_tools_PG_URL),
            jarvis_tools_PG_DB: Boolean(process.env.jarvis_tools_PG_DB),
            jarvis_tools_PG_USER: Boolean(process.env.jarvis_tools_PG_USER),
            jarvis_tools_PG_PASSWORD: Boolean(process.env.jarvis_tools_PG_PASSWORD),
          },
        };

        const checks: Record<string, unknown> = {
          resolve_config_ok: false,
          connect_db_ok: false,
          connectivity_query_ok: false,
          git_bridge_migration_asset_ok: false,
          git_bridge_migrations_ok: false,
          config_store_migrations_ok: false,
          app_config_read_ok: false,
          script_registry_read_ok: false,
          script_env_read_ok: false,
        };

        try {
          checks.resolve_config_ok = configSnapshot.connection_string_present;
          failedStep = "connect_db";
          db = await createDatabaseClientFromEnv();
          checks.connect_db_ok = true;

          failedStep = "connectivity_query";
          const connectivityRows = await db.query<Array<{ ok: number; now_utc: string; current_database: string | null }>[number]>(
            "SELECT 1 AS ok, NOW()::text AS now_utc, current_database()::text AS current_database"
          );
          checks.connectivity_query_ok = connectivityRows[0]?.ok === 1;

          failedStep = "git_bridge_migration_asset";
          const gitBridgeMigrationSql = await loadInitialMigrationSql();
          checks.git_bridge_migration_asset_ok = gitBridgeMigrationSql.trim().length > 0;

          failedStep = "git_bridge_migrations";
          await runJarvisGitBridgeMigrations(db);
          checks.git_bridge_migrations_ok = true;

          failedStep = "config_store_migrations";
          await runConfigStoreMigrations(db);
          checks.config_store_migrations_ok = true;

          const appConfigRepository = new AppConfigRepository(db);
          const scriptRegistryRepository = new ScriptRegistryRepository(db);
          const scriptEnvRepository = new ScriptEnvRepository(db);

          failedStep = "app_config_read";
          const appConfigValues = await appConfigRepository.getMany(["server.transport", "server.port", "server.cors_origin"]);
          checks.app_config_read_ok = true;

          failedStep = "script_registry_read";
          const registry = await scriptRegistryRepository.listActive();
          checks.script_registry_read_ok = true;

          failedStep = "script_env_read";
          const storedScriptEnv = await scriptEnvRepository.listByScript("proxmox-CTDEV.sh");
          checks.script_env_read_ok = true;

          return toSuccessPayload({
            ok: true,
            status: "OK",
            checks,
            config: configSnapshot,
            database: {
              now_utc: connectivityRows[0]?.now_utc ?? null,
              current_database: connectivityRows[0]?.current_database ?? null,
            },
            summary: {
              app_config_keys_read: Object.keys(appConfigValues),
              active_script_count: Object.keys(registry).length,
              proxmox_env_keys_found: Object.keys(storedScriptEnv),
            },
          });
        } catch (error: unknown) {
          return toFailurePayload(error, failedStep, checks, configSnapshot);
        } finally {
          if (db !== undefined) {
            await db.close();
          }
        }
      }
    );
  },
};

export default jarvisAutotestDbModule;