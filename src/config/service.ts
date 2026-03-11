import { createDatabaseClientFromEnv } from "../modules/jarvis_git_bridge/db/database.js";
import { runJarvisGitBridgeMigrations } from "../modules/jarvis_git_bridge/db/repositories.js";
import type { ScriptRegistry } from "../modules/script_runner/types/domain.js";
import { getScriptRunnerEnvConfig, getServerEnvConfig, type TransportMode } from "./env.js";
import { AppConfigRepository, runConfigStoreMigrations, ScriptRegistryRepository } from "./store.js";

type ServerConfigOverride = {
  transportMode?: TransportMode;
  port?: number;
  corsOrigin?: string;
};

function isTransportMode(value: unknown): value is TransportMode {
  return value === "stdio" || value === "http";
}

function toPositiveInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

async function withOptionalConfigDatabase<TValue>(
  work: (repositories: {
    appConfig: AppConfigRepository;
    scriptRegistry: ScriptRegistryRepository;
  }) => Promise<TValue>
): Promise<TValue | null> {
  try {
    const db = await createDatabaseClientFromEnv();

    try {
      await runJarvisGitBridgeMigrations(db);
      await runConfigStoreMigrations(db);

      return await work({
        appConfig: new AppConfigRepository(db),
        scriptRegistry: new ScriptRegistryRepository(db),
      });
    } finally {
      await db.close();
    }
  } catch {
    return null;
  }
}

export async function loadServerConfig(): Promise<ReturnType<typeof getServerEnvConfig>> {
  const envConfig = getServerEnvConfig();
  const stored = await withOptionalConfigDatabase<ServerConfigOverride>(async ({ appConfig }) => {
    const values = await appConfig.getMany([
      "server.transport",
      "server.port",
      "server.cors_origin",
    ]);

    return {
      transportMode: isTransportMode(values["server.transport"]) ? values["server.transport"] : undefined,
      port: toPositiveInteger(values["server.port"]),
      corsOrigin: typeof values["server.cors_origin"] === "string" ? values["server.cors_origin"] : undefined,
    };
  });

  if (stored === null) {
    return envConfig;
  }

  return {
    ...envConfig,
    transportMode: stored.transportMode ?? envConfig.transportMode,
    port: stored.port ?? envConfig.port,
    corsOrigin: stored.corsOrigin ?? envConfig.corsOrigin,
  };
}

export async function loadConfiguredScriptRegistry(): Promise<ScriptRegistry> {
  const envConfig = getScriptRunnerEnvConfig();
  const stored = await withOptionalConfigDatabase<ScriptRegistry>(async ({ scriptRegistry }) => {
    await scriptRegistry.seedDefaultsIfEmpty(envConfig.approvedScripts);
    return scriptRegistry.listActive();
  });

  if (stored === null || Object.keys(stored).length === 0) {
    return envConfig.approvedScripts;
  }

  return stored;
}
