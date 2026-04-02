import path from "node:path";
import { config as loadDotenv } from "dotenv";
import type { ScriptDefinition, ScriptEnvDefinition, ScriptRegistry } from "../modules/script_runner/types/domain.js";

loadDotenv();

export type TransportMode = "stdio" | "http";

type ScriptRegistryInput = Record<string, {
  name?: string;
  file_name?: string;
  version?: string;
  required_env?: Array<InputScriptEnvDefinition>;
  description?: string;
}>;

type InputScriptEnvDefinition = string | {
  name?: string;
  required?: boolean;
  secret?: boolean;
  description?: string;
};

export const SERVER_NAME = "mcp-server-starter";
export const SERVER_VERSION = "1.0.4";

const DEFAULT_APPROVED_SCRIPTS: ScriptRegistry = {
  "proxmox-diagnose.sh": {
    name: "proxmox-diagnose.sh",
    file_name: "proxmox-diagnose.sh",
    version: "1.0.4",
    required_env: [],
    description: "Diagnostic et orchestration Proxmox via SSH avec inventaire CT/LXC, creation de CT, lecture d'etat, execution dans CT et operations de cycle de vie.",
  },
  "jarvis_sync_build_redeploy.sh": {
    name: "jarvis_sync_build_redeploy.sh",
    file_name: "jarvis_sync_build_redeploy.sh",
    version: "1.3.7",
    required_env: [
      {
        name: "jarvis_tools_GITHUB_TOKEN",
        required: false,
        secret: true,
        description: "GitHub token used for sync and mirror phases.",
      },
      {
        name: "jarvis_tools_GITEA_TOKEN",
        required: false,
        secret: true,
        description: "Gitea token used for mirror phase.",
      },
      {
        name: "JARVIS_LOCAL_REPO",
        required: false,
        secret: false,
        description: "Local repository path used by install, build and deploy phases.",
      },
      {
        name: "JARVIS_TOOLS_WEBHOOK_URL",
        required: false,
        secret: true,
        description: "Portainer webhook URL used for webhook or restart phases.",
      },
      {
        name: "jarvis_tools_PORTAINER_URL",
        required: false,
        secret: false,
        description: "Portainer base URL used for direct stack redeploy.",
      },
      {
        name: "jarvis_tools_PORTAINER_USER",
        required: false,
        secret: false,
        description: "Portainer username used for direct stack redeploy.",
      },
      {
        name: "jarvis_tools_PORTAINER_PASSWORD",
        required: false,
        secret: true,
        description: "Portainer password used for direct stack redeploy.",
      },
      {
        name: "PORTAINER_ENDPOINT_ID",
        required: false,
        secret: false,
        description: "Portainer endpoint id for the jarvis-tools stack redeploy.",
      },
      {
        name: "JARVIS_TOOLS_STACK_ID",
        required: false,
        secret: false,
        description: "Portainer stack id for the jarvis-tools redeploy.",
      },
      {
        name: "JARVIS_MCPO_CONTAINER_NAME",
        required: false,
        secret: false,
        description: "MCPO container name when restart strategy is docker.",
      },
      {
        name: "JARVIS_srv_SSH",
        required: false,
        secret: false,
        description: "SSH host and port for deploy target.",
      },
      {
        name: "JARVIS_srv_USER",
        required: false,
        secret: false,
        description: "SSH user for deploy target.",
      },
      {
        name: "JARVIS_SSH_KEY_PATH",
        required: false,
        secret: false,
        description: "Optional SSH private key path for deploy target authentication.",
      },
      {
        name: "JARVIS_srv_PSWD",
        required: false,
        secret: true,
        description: "Optional SSH password used when sshpass authentication is preferred.",
      },
    ],
    description: "Synchronize source, build locally, deploy web code and scripts, mirror refs, trigger webhook, and restart MCPO.",
  },
};

const DEFAULT_SCRIPT_RUNNER_SENSITIVE_ENV_NAMES = [
  "PROXMOX_PASSWORD",
  "NPM_SECRET",
  "jarvis_tools_GITHUB_TOKEN",
  "jarvis_tools_GITEA_TOKEN",
  "jarvis_tools_PORTAINER_PASSWORD",
  "JARVIS_TOOLS_WEBHOOK_URL",
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
    version: typeof input.version === "string" && input.version.trim().length > 0 ? input.version.trim() : undefined,
    required_env: Array.isArray(input.required_env) ? normalizeScriptEnvDefinitions(input.required_env) : [],
    description: typeof input.description === "string" && input.description.trim().length > 0
      ? input.description.trim()
      : undefined,
  };
}

function normalizeScriptEnvDefinitions(input: Array<InputScriptEnvDefinition | ScriptEnvDefinition>): Array<ScriptEnvDefinition> {
  const mapped: Array<ScriptEnvDefinition | null> = input.map((entry) => {
      if (typeof entry === "string") {
        const trimmed = entry.trim();
        return trimmed.length > 0 ? trimmed : null;
      }

      if (typeof entry !== "object" || entry === null) {
        return null;
      }

      const name = typeof entry.name === "string" ? entry.name.trim() : "";
      if (name.length === 0) {
        return null;
      }

      return {
        name,
        required: entry.required === undefined ? true : entry.required === true,
        secret: entry.secret === true,
        description: typeof entry.description === "string" && entry.description.trim().length > 0
          ? entry.description.trim()
          : undefined,
      };
    });

  return mapped.filter((entry): entry is ScriptEnvDefinition => entry !== null);
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
      firstNonEmptyValue(
        "JARVIS_SCRIPT_RUNNER_SCRIPTS_ROOT",
        "jarvis_tools_SCRIPT_RUNNER_SCRIPTS_ROOT",
        "JARVIS_SCRIPTS_ROOT",
        "jarvis_tools_SCRIPTS_ROOT",
      )
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
