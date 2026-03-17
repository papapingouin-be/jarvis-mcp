import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisterableModule } from "../registry/types.js";
import { createDatabaseClientFromEnv } from "../modules/jarvis_git_bridge/db/database.js";
import { runJarvisGitBridgeMigrations } from "../modules/jarvis_git_bridge/db/repositories.js";
import { AppConfigRepository, runConfigStoreMigrations, ScriptEnvRepository, ScriptRegistryRepository } from "../config/store.js";
import { getGitBridgeEnvConfig } from "../config/env.js";
import { JarvisGitBridgeError, asSafeError } from "../modules/jarvis_git_bridge/services/errors.js";
import { ScriptRunnerError, asScriptRunnerError } from "../modules/script_runner/services/errors.js";

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

function toFailurePayload(error: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  const safeError = error instanceof JarvisGitBridgeError
    ? error
    : error instanceof ScriptRunnerError
      ? asScriptRunnerError(error)
      : asSafeError(error);

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        ok: false,
        status: "KO",
        checks: {
          connection_string_present: Boolean(getGitBridgeEnvConfig().database.connectionString),
        },
        error: {
          code: safeError.code,
          message: safeError.safeMessage,
        },
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

        try {
          const gitBridgeConfig = getGitBridgeEnvConfig();
          db = await createDatabaseClientFromEnv();

          const connectivityRows = await db.query<Array<{ ok: number; now_utc: string }>[number]>(
            "SELECT 1 AS ok, NOW()::text AS now_utc"
          );

          await runJarvisGitBridgeMigrations(db);
          await runConfigStoreMigrations(db);

          const appConfigRepository = new AppConfigRepository(db);
          const scriptRegistryRepository = new ScriptRegistryRepository(db);
          const scriptEnvRepository = new ScriptEnvRepository(db);

          const appConfigValues = await appConfigRepository.getMany(["server.transport", "server.port", "server.cors_origin"]);
          const registry = await scriptRegistryRepository.listActive();
          const storedScriptEnv = await scriptEnvRepository.listByScript("proxmox-CTDEV.sh");

          return toSuccessPayload({
            ok: true,
            status: "OK",
            checks: {
              connection_string_present: Boolean(gitBridgeConfig.database.connectionString),
              pg_module_name: gitBridgeConfig.database.pgModuleName,
              connectivity_query_ok: connectivityRows[0]?.ok === 1,
              config_store_migrations_ok: true,
              app_config_read_ok: true,
              script_registry_read_ok: true,
              script_env_read_ok: true,
            },
            database: {
              now_utc: connectivityRows[0]?.now_utc ?? null,
            },
            summary: {
              app_config_keys_read: Object.keys(appConfigValues),
              active_script_count: Object.keys(registry).length,
              proxmox_env_keys_found: Object.keys(storedScriptEnv),
            },
          });
        } catch (error: unknown) {
          return toFailurePayload(error);
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