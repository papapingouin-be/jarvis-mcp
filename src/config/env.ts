import path from "node:path";
import { config as loadDotenv } from "dotenv";
import type { ScriptDefinition, ScriptRegistry } from "../modules/script_runner/types/domain.js";

loadDotenv();

export type TransportMode = "stdio" | "http";

type ScriptRegistryInput = Record<string, {
  name?: string;
  file_name?: string;
  required_env?: Array<string>;
  description?: string;
}>;

export const SERVER_NAME = "mcp-server-starter";
export const SERVER_VERSION = "1.0.3";

const DEFAULT_APPROVED_SCRIPTS: ScriptRegistry = {
  "proxmox-CTDEV.sh": {
    name: "proxmox-CTDEV.sh",
    file_name: "proxmox-CTDEV.sh",
    required_env: [
      "PROXMOX_HOST",
      "PROXMOX_WEB",
      "PROXMOX_SSH_PORT",
      "PROXMOX_USER",
      "PROXMOX_PASSWORD",
      "PROXMOX_API_TOKEN_ID",
      "PROXMOX_API_TOKEN_SECRET",
    ],
    description: "Collecte les templates/CT Proxmox puis cree et demarre un conteneur CT de developpement.",
  },
  "proxmox-diagnose.sh": {
    name: "proxmox-diagnose.sh",
    file_name: "proxmox-diagnose.sh",
    required_env: [],
    description: "Diagnostic et orchestration Proxmox via SSH, avec modes collect, preflight et gestion CT.",
  },
};

const DEFAULT_SCRIPT_RUNNER_SENSITIVE_ENV_NAMES = [
  "PROXMOX_PASSWORD",
  "PROXMOX_API_TOKEN_SECRET",
  "PROXMOX_API_TOKEN_ID",
  "NPM_SECRET",
];

const DEFAULT_DIAGNOSE_ENV_VARS = [
  "STARTER_TRANSPORT",
  "PORT",
  "CORS_ORIGIN",
  "DATABASE_URL",
  "MASTER_KEY_FILE",
  "MASTER_KEY",
  "NPM_URL",
  "NPM_IDENTITY",
  "NPM_SECRET",
];

function firstNonEmptyValue(...names: Array<string>): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function toScriptDefinition(name: string, input: ScriptDefinition | ScriptRegistryInput[string]): ScriptDefinition {
  return {
    name: input.name ?? name,
    file_name: input.file_name ?? name,
    required_env: Array.isArray(input.required_env) ? [...input.required_env] : [],
    description: typeof input.description === "string" && input.description.trim().length > 0
      ? input.description.trim()
      : undefined,
  };
}

function cloneScriptRegistry(registry: ScriptRegistry): ScriptRegistry {
  return Object.fromEntries(
    Object.entries(registry).map(([name, definition]) => [name, toScriptDefinition(name, definition)])
  );
}

function parseScriptRegistryJson(raw: string): ScriptRegistry {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("JARVIS_APPROVED_SCRIPTS_JSON must be valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("JARVIS_APPROVED_SCRIPTS_JSON must be an object keyed by script name");
  }

  return Object.fromEntries(
    Object.entries(parsed as ScriptRegistryInput).map(([name, definition]) => [name, toScriptDefinition(name, definition)])
  );
}

function parseStringList(raw: string | undefined, fallback: Array<string>): Array<string> {
  if (raw === undefined) {
    return [...fallback];
  }

  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

export function getServerEnvConfig(): {
  transportMode: TransportMode;
  port: number;
  corsOrigin: string;
  diagnoseEnvVars: Array<string>;
  logFilePath: string;
  verboseMode: boolean;
  recentEventLimit: number;
} {
  const rawTransportMode = firstNonEmptyValue("STARTER_TRANSPORT");
  const transportMode = rawTransportMode === "http" ? "http" : "stdio";

  return {
    transportMode,
    port: parsePort(firstNonEmptyValue("PORT"), 3000),
    corsOrigin: firstNonEmptyValue("CORS_ORIGIN") ?? "*",
    diagnoseEnvVars: parseStringList(firstNonEmptyValue("JARVIS_DIAGNOSE_ENV_VARS"), DEFAULT_DIAGNOSE_ENV_VARS),
    logFilePath: path.resolve(firstNonEmptyValue("JARVIS_LOG_FILE") ?? path.join(process.cwd(), "logs", "mcp-server.log")),
    verboseMode: parseBoolean(firstNonEmptyValue("JARVIS_VERBOSE_MODE"), false),
    recentEventLimit: parsePort(firstNonEmptyValue("JARVIS_RECENT_EVENT_LIMIT"), 200),
  };
}

export function getDefaultApprovedScripts(): ScriptRegistry {
  return cloneScriptRegistry(DEFAULT_APPROVED_SCRIPTS);
}

export function getScriptRunnerEnvConfig(): {
  scriptsRoot: string;
  approvedScripts: ScriptRegistry;
  sensitiveEnvNames: Array<string>;
} {
  const approvedScriptsJson = firstNonEmptyValue("JARVIS_APPROVED_SCRIPTS_JSON", "jarvis_tools_APPROVED_SCRIPTS_JSON");
  const approvedScripts = approvedScriptsJson === undefined
    ? getDefaultApprovedScripts()
    : parseScriptRegistryJson(approvedScriptsJson);

  return {
    scriptsRoot: path.resolve(
      firstNonEmptyValue("JARVIS_SCRIPT_RUNNER_SCRIPTS_ROOT", "jarvis_tools_SCRIPT_RUNNER_SCRIPTS_ROOT")
        ?? path.join(process.cwd(), "tools", "scripts")
    ),
    approvedScripts,
    sensitiveEnvNames: parseStringList(
      firstNonEmptyValue("JARVIS_SCRIPT_RUNNER_SENSITIVE_ENV_NAMES", "jarvis_tools_SCRIPT_RUNNER_SENSITIVE_ENV_NAMES"),
      DEFAULT_SCRIPT_RUNNER_SENSITIVE_ENV_NAMES
    ),
  };
}

export function getGitBridgeEnvConfig(): {
  database: {
    connectionString?: string;
    pgModuleName: string;
  };
  masterKey: {
    keyFile?: string;
    inlineKey?: string;
  };
} {
  const directDatabaseUrl = firstNonEmptyValue("DATABASE_URL", "jarvis_tools_DATABASE_URL");
  const hostPort = firstNonEmptyValue("jarvis_tools_PG_URL");
  const database = firstNonEmptyValue("jarvis_tools_PG_DB");
  const user = firstNonEmptyValue("jarvis_tools_PG_USER");
  const password = firstNonEmptyValue("jarvis_tools_PG_PASSWORD");

  let connectionString = directDatabaseUrl;
  if (connectionString === undefined && hostPort && database && user && password) {
    const encodedUser = encodeURIComponent(user);
    const encodedPassword = encodeURIComponent(password);

    connectionString = hostPort.startsWith("postgres://") || hostPort.startsWith("postgresql://")
      ? `${hostPort.replace(/\/+$/g, "")}/${database}`
      : `postgresql://${encodedUser}:${encodedPassword}@${hostPort}/${database}`;
  }

  return {
    database: {
      connectionString,
      pgModuleName: firstNonEmptyValue("JARVIS_GIT_BRIDGE_PG_MODULE", "jarvis_tools_GIT_BRIDGE_PG_MODULE") ?? "pg",
    },
    masterKey: {
      keyFile: firstNonEmptyValue("MASTER_KEY_FILE", "jarvis_tools_MASTER_KEY_FILE"),
      inlineKey: firstNonEmptyValue("MASTER_KEY", "jarvis_tools_MASTER_KEY"),
    },
  };
}
