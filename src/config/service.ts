import { createDatabaseClientFromEnv } from "../modules/jarvis_git_bridge/db/database.js";
import { runJarvisGitBridgeMigrations } from "../modules/jarvis_git_bridge/db/repositories.js";
import { ScriptRunnerError } from "../modules/script_runner/services/errors.js";
import type { ScriptDefinition, ScriptRegistry } from "../modules/script_runner/types/domain.js";
import { getScriptRunnerEnvConfig, getServerEnvConfig, type TransportMode } from "./env.js";
import {
  AppConfigRepository,
  runConfigStoreMigrations,
  ScriptEnvRepository,
  ScriptRegistryRepository,
} from "./store.js";

type ServerConfigOverride = {
  transportMode?: TransportMode;
  port?: number;
  corsOrigin?: string;
};

type ScriptEnvEntry = {
  name: string;
  value: string | null;
  is_set: boolean;
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
    scriptEnv: ScriptEnvRepository;
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
        scriptEnv: new ScriptEnvRepository(db),
      });
    } finally {
      await db.close();
    }
  } catch {
    return null;
  }
}

async function withRequiredConfigDatabase<TValue>(
  work: (repositories: {
    appConfig: AppConfigRepository;
    scriptRegistry: ScriptRegistryRepository;
    scriptEnv: ScriptEnvRepository;
  }) => Promise<TValue>
): Promise<TValue> {
  let db: Awaited<ReturnType<typeof createDatabaseClientFromEnv>> | undefined;

  try {
    db = await createDatabaseClientFromEnv();
    await runJarvisGitBridgeMigrations(db);
    await runConfigStoreMigrations(db);

    return await work({
      appConfig: new AppConfigRepository(db),
      scriptRegistry: new ScriptRegistryRepository(db),
      scriptEnv: new ScriptEnvRepository(db),
    });
  } catch (error: unknown) {
    if (error instanceof ScriptRunnerError) {
      throw error;
    }

    throw new ScriptRunnerError(
      "SCRIPT_CONFIG_STORE_UNAVAILABLE",
      "Database-backed script configuration is unavailable"
    );
  } finally {
    if (db !== undefined) {
      await db.close();
    }
  }
}

async function loadValidatedScriptDefinition(scriptName: string): Promise<ScriptDefinition> {
  const registry = await loadConfiguredScriptRegistry();
  const script = registry[scriptName];

  if (script === undefined) {
    throw new ScriptRunnerError("SCRIPT_NOT_ALLOWED", "Script is not in the approved allowlist");
  }

  return script;
}

function normalizeScriptEnvInput(
  definition: ScriptDefinition,
  values: Record<string, string>
): Record<string, string> {
  const allowedNames = new Set(definition.required_env);
  const normalizedEntries = Object.entries(values).map(([key, value]) => [key.trim(), value.trim()] as const);
  const invalidKeys = normalizedEntries
    .map(([key]) => key)
    .filter((key) => key.length === 0 || !allowedNames.has(key));

  if (invalidKeys.length > 0) {
    throw new ScriptRunnerError(
      "SCRIPT_ENV_INVALID",
      `Unsupported script configuration keys: ${invalidKeys.join(", ")}`
    );
  }

  const emptyKeys = normalizedEntries
    .filter(([, value]) => value.length === 0)
    .map(([key]) => key);

  if (emptyKeys.length > 0) {
    throw new ScriptRunnerError(
      "SCRIPT_ENV_INVALID",
      `Script configuration values must be non-empty: ${emptyKeys.join(", ")}`
    );
  }

  return Object.fromEntries(normalizedEntries);
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

export async function loadScriptEnvValues(scriptName: string): Promise<Record<string, string>> {
  const stored = await withOptionalConfigDatabase<Record<string, string>>(async ({ scriptEnv }) => {
    return scriptEnv.listByScript(scriptName);
  });

  return stored ?? {};
}

export async function describeScriptEnv(scriptName: string): Promise<{
  ok: true;
  script_name: string;
  required_env: Array<ScriptEnvEntry>;
}> {
  const definition = await loadValidatedScriptDefinition(scriptName);
  const storedValues = await loadScriptEnvValues(scriptName);

  return {
    ok: true,
    script_name: definition.name,
    required_env: definition.required_env.map((name) => ({
      name,
      value: storedValues[name] ?? null,
      is_set: typeof storedValues[name] === "string",
    })),
  };
}

export async function saveScriptEnvValues(scriptName: string, values: Record<string, string>): Promise<{
  ok: true;
  script_name: string;
  saved_count: number;
  saved_values: Record<string, string>;
}> {
  const definition = await loadValidatedScriptDefinition(scriptName);
  const normalizedValues = normalizeScriptEnvInput(definition, values);

  await withRequiredConfigDatabase(async ({ scriptRegistry, scriptEnv }) => {
    const envConfig = getScriptRunnerEnvConfig();
    await scriptRegistry.seedDefaultsIfEmpty(envConfig.approvedScripts);
    await scriptEnv.upsertMany(definition.name, normalizedValues);
  });

  return {
    ok: true,
    script_name: definition.name,
    saved_count: Object.keys(normalizedValues).length,
    saved_values: normalizedValues,
  };
}
