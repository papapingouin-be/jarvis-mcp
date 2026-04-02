import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { parse as parseDotenv } from "dotenv";
import { loadScriptEnvValues } from "./service.js";
import { ScriptRunnerError } from "../modules/script_runner/services/errors.js";

const execFileAsync = promisify(execFile);

const SCRIPT_CONFIG_NAME = "jarvis_sync_build_redeploy.sh";
const EXECUTION_TIMEOUT_MS = 15 * 60 * 1000;

const EXECUTION_MODES = [
  "all",
  "sync",
  "install",
  "build",
  "deploy-web",
  "deploy-scripts",
  "mirror",
  "webhook",
  "restart",
] as const;

const METADATA_MODES = [
  "self-doc",
  "registry-doc",
  "list-services",
  "describe-service",
  "validate-service-input",
] as const;

export type JarvisSyncMode = typeof EXECUTION_MODES[number] | typeof METADATA_MODES[number];

type StepStatus = "ok" | "failed";

type StepResult = {
  step: string;
  status: StepStatus;
  message: string;
};

type CommandResult = {
  stdout: string;
  stderr: string;
};

type CommandRunner = (params: {
  command: string;
  args: Array<string>;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}) => Promise<CommandResult>;

type FetchRunner = typeof fetch;

type CommandSpec = {
  command: string;
  args: Array<string>;
  cwd?: string;
  sensitive?: boolean;
};

type ResolvedConfig = {
  envFile: string | null;
  envSource: string;
  env: NodeJS.ProcessEnv;
  branch: string;
  localRepo: string;
  githubToken: string;
  giteaToken: string;
  githubRepoUrl: string;
  giteaRepoUrl: string;
  githubRemoteName: string;
  npmInstallCmd: string;
  npmBuildCmd: string;
  npmFallbackInstallCmd: string;
  npmAllowFallbackInstall: boolean;
  stopOnLockMismatch: boolean;
  webCodeLocalSubdir: string;
  webRemotePath: string;
  webRemoteDelete: boolean;
  webRsyncExcludes: Array<string>;
  scriptSourceLocalSubdir: string;
  scriptRemotePath: string;
  scriptRemoteDelete: boolean;
  scriptDirMode: string;
  scriptFileMode: string;
  webhookUrl: string;
  mcpoContainerName: string;
  portainerUseStackWebhook: boolean;
  restartStrategy: "webhook" | "portainer-webhook" | "docker";
  useSudo: boolean;
  sshHostPort: string;
  sshUser: string;
  sshPassword?: string;
  sshKeyPath?: string;
  sshAuthMode: "sshpass" | "keyfile" | "agent_or_default_key";
};

type ExecuteInput = {
  mode: typeof EXECUTION_MODES[number];
  confirmed: boolean;
  dry_run: boolean;
  env_file?: string;
};

type MetadataInput = {
  mode: typeof METADATA_MODES[number];
  dry_run: boolean;
  env_file?: string;
  service?: typeof EXECUTION_MODES[number];
};

function requireConfigValue(value: string, envName: string): string {
  const trimmed = value.trim();
  if (trimmed.length > 0) {
    return trimmed;
  }

  throw new ScriptRunnerError("MISSING_ENV", `Missing required environment variable: ${envName}`);
}

function maskSecrets(input: string, env: NodeJS.ProcessEnv): string {
  let result = input;
  const secretNames = [
    "jarvis_tools_GITHUB_TOKEN",
    "jarvis_tools_GITEA_TOKEN",
    "JARVIS_TOOLS_WEBHOOK_URL",
    "JARVIS_srv_PSWD",
  ];

  for (const name of secretNames) {
    const value = env[name]?.trim();
    if (typeof value === "string" && value.length > 0) {
      result = result.split(value).join("***");
    }
  }

  return result.replace(/(token|password|secret)=([^\s]+)/gi, "$1=***");
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function firstNonEmpty(source: NodeJS.ProcessEnv, ...names: Array<string>): string | undefined {
  for (const name of names) {
    const value = source[name]?.trim();
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function toCommandString(spec: CommandSpec): string {
  return [spec.command, ...spec.args].join(" ");
}

function getExecutionSequence(mode: typeof EXECUTION_MODES[number]): Array<typeof EXECUTION_MODES[number]> {
  if (mode === "all") {
    return [...EXECUTION_MODES].filter((entry) => entry !== "all");
  }

  return [mode];
}

function buildServiceCatalog(): Array<Record<string, unknown>> {
  return [...EXECUTION_MODES].map((mode) => ({
    name: mode,
    phase: "execute",
    confirmed_required: true,
    description: describeExecutionMode(mode),
  }));
}

function describeExecutionMode(mode: typeof EXECUTION_MODES[number]): string {
  switch (mode) {
    case "all":
      return "Run the full workflow: sync, install, build, deploy web, deploy scripts, mirror, webhook, restart.";
    case "sync":
      return "Synchronize the local repository from GitHub.";
    case "install":
      return "Install npm dependencies in the local repository.";
    case "build":
      return "Build the local repository.";
    case "deploy-web":
      return "Deploy config-web assets to the remote host over rsync/SSH.";
    case "deploy-scripts":
      return "Deploy runtime scripts to the remote scripts directory and normalize permissions.";
    case "mirror":
      return "Mirror refs from GitHub to Gitea without using the legacy helper script.";
    case "webhook":
      return "Trigger the Portainer webhook.";
    case "restart":
      return "Restart the runtime using the configured restart strategy.";
  }
}

async function defaultCommandRunner(params: {
  command: string;
  args: Array<string>;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<CommandResult> {
  const result = await execFileAsync(params.command, params.args, {
    cwd: params.cwd,
    env: params.env,
    timeout: params.timeoutMs ?? EXECUTION_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });

  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

async function readOptionalEnvFile(envFile?: string): Promise<{
  envFile: string | null;
  envSource: string;
  envValues: Record<string, string>;
}> {
  if (typeof envFile !== "string" || envFile.trim().length === 0) {
    return {
      envFile: null,
      envSource: "process-env+db-config",
      envValues: {},
    };
  }

  const resolved = path.resolve(envFile);
  const raw = await readFile(resolved, "utf8");
  return {
    envFile: resolved,
    envSource: resolved,
    envValues: parseDotenv(raw),
  };
}

async function resolveConfig(envFile?: string): Promise<ResolvedConfig> {
  const dbValues = await loadScriptEnvValues(SCRIPT_CONFIG_NAME);
  const fileData = await readOptionalEnvFile(envFile);
  const mergedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...fileData.envValues,
    ...dbValues,
  };

  const githubToken = firstNonEmpty(mergedEnv, "jarvis_tools_GITHUB_TOKEN") ?? "";
  const giteaToken = firstNonEmpty(mergedEnv, "jarvis_tools_GITEA_TOKEN") ?? "";
  const localRepo = firstNonEmpty(mergedEnv, "JARVIS_LOCAL_REPO") ?? "";
  const sshHostPort = firstNonEmpty(mergedEnv, "JARVIS_srv_SSH") ?? "";
  const sshUser = firstNonEmpty(mergedEnv, "JARVIS_srv_USER") ?? "";
  const webhookUrl = firstNonEmpty(mergedEnv, "JARVIS_TOOLS_WEBHOOK_URL") ?? "";

  const sshPassword = firstNonEmpty(mergedEnv, "JARVIS_srv_PSWD");
  const sshKeyPath = firstNonEmpty(mergedEnv, "JARVIS_SSH_KEY_PATH");
  const sshAuthMode: ResolvedConfig["sshAuthMode"] = sshPassword
    ? "sshpass"
    : sshKeyPath
      ? "keyfile"
      : "agent_or_default_key";

  return {
    envFile: fileData.envFile,
    envSource: fileData.envSource,
    env: mergedEnv,
    branch: firstNonEmpty(mergedEnv, "JARVIS_BRANCH") ?? "main",
    localRepo,
    githubToken,
    giteaToken,
    githubRepoUrl: firstNonEmpty(mergedEnv, "GITHUB_REPO_URL")
      ?? (githubToken.length > 0 ? `https://${githubToken}@github.com/papapingouin-be/jarvis-mcp.git` : ""),
    giteaRepoUrl: firstNonEmpty(mergedEnv, "GITEA_REPO_URL")
      ?? (giteaToken.length > 0
        ? `https://${giteaToken}@webgit.jarvis.papapingouinbe.duckdns.org/jarvisadmin/jarvis-mcp-tools.git`
        : ""),
    githubRemoteName: firstNonEmpty(mergedEnv, "GITHUB_REMOTE_NAME") ?? "github-src",
    npmInstallCmd: firstNonEmpty(mergedEnv, "NPM_INSTALL_CMD") ?? "npm ci",
    npmBuildCmd: firstNonEmpty(mergedEnv, "NPM_BUILD_CMD") ?? "npm run build",
    npmFallbackInstallCmd: firstNonEmpty(mergedEnv, "NPM_FALLBACK_INSTALL_CMD") ?? "npm install",
    npmAllowFallbackInstall: parseBoolean(firstNonEmpty(mergedEnv, "NPM_ALLOW_FALLBACK_INSTALL"), false),
    stopOnLockMismatch: parseBoolean(firstNonEmpty(mergedEnv, "STOP_ON_LOCK_MISMATCH"), true),
    webCodeLocalSubdir: firstNonEmpty(mergedEnv, "WEB_CODE_LOCAL_SUBDIR") ?? "jarvis-config-web",
    webRemotePath: firstNonEmpty(mergedEnv, "WEB_REMOTE_PATH") ?? "/opt/jarvis/config-web",
    webRemoteDelete: parseBoolean(firstNonEmpty(mergedEnv, "WEB_REMOTE_DELETE"), true),
    webRsyncExcludes: (firstNonEmpty(mergedEnv, "WEB_RSYNC_EXCLUDES") ?? "data/scripts/")
      .split(";")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
    scriptSourceLocalSubdir: firstNonEmpty(mergedEnv, "SCRIPT_SOURCE_LOCAL_SUBDIR") ?? "tools/scripts",
    scriptRemotePath: firstNonEmpty(mergedEnv, "SCRIPT_REMOTE_PATH") ?? "/opt/jarvis/shared/scripts",
    scriptRemoteDelete: parseBoolean(firstNonEmpty(mergedEnv, "SCRIPT_REMOTE_DELETE"), true),
    scriptDirMode: firstNonEmpty(mergedEnv, "SCRIPT_DIR_MODE") ?? "755",
    scriptFileMode: firstNonEmpty(mergedEnv, "SCRIPT_FILE_MODE") ?? "644",
    webhookUrl,
    mcpoContainerName: firstNonEmpty(mergedEnv, "JARVIS_MCPO_CONTAINER_NAME") ?? "jarvis_mcpo",
    portainerUseStackWebhook: parseBoolean(firstNonEmpty(mergedEnv, "PORTAINER_USE_STACK_WEBHOOK"), true),
    restartStrategy: (firstNonEmpty(mergedEnv, "RESTART_STRATEGY") ?? "docker") as ResolvedConfig["restartStrategy"],
    useSudo: parseBoolean(firstNonEmpty(mergedEnv, "USE_SUDO"), true),
    sshHostPort,
    sshUser,
    sshPassword,
    sshKeyPath,
    sshAuthMode,
  };
}

async function runShellCommand(
  runner: CommandRunner,
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<CommandResult> {
  return runner({
    command: "bash",
    args: ["-lc", command],
    cwd,
    env,
  });
}

function buildSshCommand(config: ResolvedConfig, remoteCommand: string): CommandSpec {
  const [host, port = "22"] = config.sshHostPort.split(":");
  const sshArgs = [
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-p",
    port,
  ];

  if (config.sshAuthMode === "keyfile" && config.sshKeyPath) {
    sshArgs.push("-i", config.sshKeyPath);
  }

  sshArgs.push(`${config.sshUser}@${host}`, remoteCommand);

  if (config.sshAuthMode === "sshpass" && config.sshPassword) {
    return {
      command: "sshpass",
      args: ["-e", "ssh", ...sshArgs],
      sensitive: true,
    };
  }

  return {
    command: "ssh",
    args: sshArgs,
  };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildRsyncCommand(
  config: ResolvedConfig,
  sourcePath: string,
  remotePath: string,
  shouldDelete: boolean,
  excludes: Array<string> = []
): CommandSpec {
  const [host, port = "22"] = config.sshHostPort.split(":");
  const rsyncArgs = ["-avz"];
  if (shouldDelete) {
    rsyncArgs.push("--delete");
  }
  for (const exclude of excludes) {
    rsyncArgs.push("--exclude", exclude);
  }

  let sshTransport = `ssh -p ${port} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
  if (config.sshAuthMode === "keyfile" && config.sshKeyPath) {
    sshTransport = `ssh -i ${config.sshKeyPath} -p ${port} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
  }

  rsyncArgs.push("-e", sshTransport, `${sourcePath}/`, `${config.sshUser}@${host}:${remotePath}/`);

  if (config.sshAuthMode === "sshpass") {
    return {
      command: "sshpass",
      args: ["-e", "rsync", ...rsyncArgs],
      sensitive: true,
    };
  }

  return {
    command: "rsync",
    args: rsyncArgs,
  };
}

async function executeCommand(
  runner: CommandRunner,
  spec: CommandSpec,
  env: NodeJS.ProcessEnv,
  trace: Array<string>,
  dryRun: boolean
): Promise<void> {
  const display = spec.sensitive ? "[sensitive command redacted]" : maskSecrets(toCommandString(spec), env);
  trace.push(display);

  if (dryRun) {
    return;
  }

  const result = await runner({
    command: spec.command,
    args: spec.args,
    cwd: spec.cwd,
    env: {
      ...env,
      ...(spec.command === "sshpass" ? { SSHPASS: env.JARVIS_srv_PSWD ?? "" } : {}),
    },
  });

  const stderr = result.stderr.trim();
  if (stderr.length > 0) {
    for (const line of stderr.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        trace.push(maskSecrets(trimmed, env));
      }
    }
  }
}

async function mirrorRefs(
  runner: CommandRunner,
  config: ResolvedConfig,
  trace: Array<string>,
  dryRun: boolean
): Promise<{ branches_pushed: number; tags_pushed: number }> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "jarvis-sync-mirror-"));
  const mirrorPath = path.join(tempDir, "mirror.git");

  try {
    await executeCommand(runner, {
      command: "git",
      args: ["clone", "--mirror", config.githubRepoUrl, mirrorPath],
    }, config.env, trace, dryRun);

    await executeCommand(runner, {
      command: "git",
      args: ["fetch", "--prune", "origin"],
      cwd: mirrorPath,
    }, config.env, trace, dryRun);

    await executeCommand(runner, {
      command: "git",
      args: ["push", "--prune", config.giteaRepoUrl, "+refs/heads/*:refs/heads/*"],
      cwd: mirrorPath,
      sensitive: true,
    }, config.env, trace, dryRun);

    await executeCommand(runner, {
      command: "git",
      args: ["push", "--prune", config.giteaRepoUrl, "+refs/tags/*:refs/tags/*"],
      cwd: mirrorPath,
      sensitive: true,
    }, config.env, trace, dryRun);

    if (dryRun) {
      return { branches_pushed: 0, tags_pushed: 0 };
    }

    const branches = await runner({
      command: "git",
      args: ["for-each-ref", "--format=%(refname)", "refs/heads"],
      cwd: mirrorPath,
      env: config.env,
    });
    const tags = await runner({
      command: "git",
      args: ["for-each-ref", "--format=%(refname)", "refs/tags"],
      cwd: mirrorPath,
      env: config.env,
    });

    return {
      branches_pushed: branches.stdout.split("\n").filter((line) => line.trim().length > 0).length,
      tags_pushed: tags.stdout.split("\n").filter((line) => line.trim().length > 0).length,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export class JarvisSyncBuildRedeployService {
  constructor(
    private readonly commandRunner: CommandRunner = defaultCommandRunner,
    private readonly fetchRunner: FetchRunner = fetch,
  ) {}

  async collect(input: MetadataInput): Promise<Record<string, unknown>> {
    const sequence = input.mode === "validate-service-input" || input.mode === "describe-service"
      ? (input.service ? getExecutionSequence(input.service) : [])
      : [];

    if (input.mode === "self-doc") {
      return {
        ok: true,
        mode: "self-doc",
        summary: "Jarvis sync/build/redeploy workflow self-documentation",
        services: buildServiceCatalog(),
        supported_modes: [...METADATA_MODES, ...EXECUTION_MODES],
        accepted_phase_values: ["collect", "execute"],
      };
    }

    if (input.mode === "registry-doc") {
      return {
        ok: true,
        mode: "registry-doc",
        script_name: SCRIPT_CONFIG_NAME,
        description: describeExecutionMode("all"),
        services: buildServiceCatalog(),
      };
    }

    if (input.mode === "list-services") {
      return {
        ok: true,
        mode: "list-services",
        services: buildServiceCatalog(),
      };
    }

    if (input.mode === "describe-service") {
      if (!input.service) {
        throw new ScriptRunnerError("SCRIPT_ENV_INVALID", "service is required for describe-service");
      }

      return {
        ok: true,
        mode: "describe-service",
        service: input.service,
        sequence,
        description: describeExecutionMode(input.service),
        confirmed_required: true,
      };
    }

    if (!input.service) {
      throw new ScriptRunnerError("SCRIPT_ENV_INVALID", "service is required for validate-service-input");
    }

    try {
      const config = await resolveConfig(input.env_file);
      if (input.service === "all" || input.service === "sync" || input.service === "install" || input.service === "build") {
        requireConfigValue(config.localRepo, "JARVIS_LOCAL_REPO");
      }
      if (input.service === "all" || input.service === "deploy-web" || input.service === "deploy-scripts") {
        requireConfigValue(config.localRepo, "JARVIS_LOCAL_REPO");
        requireConfigValue(config.sshHostPort, "JARVIS_srv_SSH");
        requireConfigValue(config.sshUser, "JARVIS_srv_USER");
      }
      if (input.service === "all" || input.service === "mirror") {
        requireConfigValue(config.githubRepoUrl, "GITHUB_REPO_URL");
        requireConfigValue(config.giteaRepoUrl, "GITEA_REPO_URL");
      }
      if (input.service === "all" || input.service === "webhook") {
        requireConfigValue(config.webhookUrl, "JARVIS_TOOLS_WEBHOOK_URL");
      }
      if ((input.service === "all" || input.service === "restart") && config.restartStrategy === "docker") {
        requireConfigValue(config.mcpoContainerName, "JARVIS_MCPO_CONTAINER_NAME");
      }
      return {
        ok: true,
        mode: "validate-service-input",
        service: input.service,
        ready: true,
        dry_run: input.dry_run,
        env_source: config.envSource,
        sequence,
        summary: "Service input and environment look ready.",
      };
    } catch (error: unknown) {
      const safeError = error instanceof ScriptRunnerError
        ? error
        : new ScriptRunnerError("SCRIPT_RUNNER_INTERNAL", "Internal script runner error");
      return {
        ok: false,
        mode: "validate-service-input",
        service: input.service,
        ready: false,
        dry_run: input.dry_run,
        sequence,
        summary: safeError.safeMessage,
      };
    }
  }

  async execute(input: ExecuteInput): Promise<Record<string, unknown>> {
    if (!input.dry_run && input.confirmed !== true) {
      throw new ScriptRunnerError("CONFIRMATION_REQUIRED", "Execution requires confirmed=true unless dry_run=true");
    }

    const config = await resolveConfig(input.env_file);
    const trace: Array<string> = [];
    const steps: Array<StepResult> = [];
    const sequence = getExecutionSequence(input.mode);

    const runStep = async (step: string, work: () => Promise<string>): Promise<void> => {
      try {
        const message = await work();
        steps.push({ step, status: "ok", message });
      } catch (error: unknown) {
        const safeError = error instanceof ScriptRunnerError
          ? error
          : new ScriptRunnerError("SCRIPT_EXECUTION_FAILED", error instanceof Error ? error.message : "Workflow step failed");
        steps.push({ step, status: "failed", message: safeError.safeMessage });
        throw safeError;
      }
    };

    for (const step of sequence) {
      if (step === "sync") {
        await runStep("sync", async () => {
          requireConfigValue(config.localRepo, "JARVIS_LOCAL_REPO");
          requireConfigValue(config.githubRepoUrl, "GITHUB_REPO_URL");
          await executeCommand(this.commandRunner, {
            command: "git",
            args: ["remote", "remove", config.githubRemoteName],
            cwd: config.localRepo,
          }, config.env, trace, true);
          if (!input.dry_run) {
            try {
              await this.commandRunner({
                command: "git",
                args: ["remote", "remove", config.githubRemoteName],
                cwd: config.localRepo,
                env: config.env,
              });
            } catch {
            }
          }

          await executeCommand(this.commandRunner, {
            command: "git",
            args: ["remote", "add", config.githubRemoteName, config.githubRepoUrl],
            cwd: config.localRepo,
            sensitive: true,
          }, config.env, trace, input.dry_run);
          await executeCommand(this.commandRunner, {
            command: "git",
            args: [
              "fetch",
              "--prune",
              "--prune-tags",
              config.githubRemoteName,
              `+refs/heads/*:refs/remotes/${config.githubRemoteName}/*`,
              "--tags",
            ],
            cwd: config.localRepo,
          }, config.env, trace, input.dry_run);
          await executeCommand(this.commandRunner, {
            command: "git",
            args: ["checkout", "-B", config.branch, `${config.githubRemoteName}/${config.branch}`],
            cwd: config.localRepo,
          }, config.env, trace, input.dry_run);
          await executeCommand(this.commandRunner, {
            command: "git",
            args: ["reset", "--hard", `${config.githubRemoteName}/${config.branch}`],
            cwd: config.localRepo,
          }, config.env, trace, input.dry_run);
          await executeCommand(this.commandRunner, {
            command: "git",
            args: ["clean", "-fd"],
            cwd: config.localRepo,
          }, config.env, trace, input.dry_run);
          return "Synchronisation GitHub -> local OK";
        });
        continue;
      }

      if (step === "install") {
        await runStep("install", async () => {
          requireConfigValue(config.localRepo, "JARVIS_LOCAL_REPO");
          if (input.dry_run) {
            trace.push(config.npmInstallCmd);
            return "Installation dependances simulee";
          }

          try {
            await runShellCommand(this.commandRunner, config.npmInstallCmd, config.localRepo, config.env);
            return "Installation dependances OK";
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "npm install failed";
            const lockMismatch = message.includes("package-lock.json");
            if (!lockMismatch || !config.npmAllowFallbackInstall) {
              throw new ScriptRunnerError("SCRIPT_EXECUTION_FAILED", "Echec installation npm");
            }

            await runShellCommand(this.commandRunner, config.npmFallbackInstallCmd, config.localRepo, config.env);
            return "Installation fallback OK";
          }
        });
        continue;
      }

      if (step === "build") {
        await runStep("build", async () => {
          requireConfigValue(config.localRepo, "JARVIS_LOCAL_REPO");
          if (input.dry_run) {
            trace.push(config.npmBuildCmd);
            return "Build simule";
          }

          await runShellCommand(this.commandRunner, config.npmBuildCmd, config.localRepo, config.env);
          return "Build OK";
        });
        continue;
      }

      if (step === "deploy-web" || step === "deploy-scripts") {
        await runStep(step, async () => {
          requireConfigValue(config.localRepo, "JARVIS_LOCAL_REPO");
          requireConfigValue(config.sshHostPort, "JARVIS_srv_SSH");
          requireConfigValue(config.sshUser, "JARVIS_srv_USER");
          const sourcePath = path.join(
            config.localRepo,
            step === "deploy-web" ? config.webCodeLocalSubdir : config.scriptSourceLocalSubdir,
          );
          const remotePath = step === "deploy-web" ? config.webRemotePath : config.scriptRemotePath;
          const shouldDelete = step === "deploy-web" ? config.webRemoteDelete : config.scriptRemoteDelete;
          const excludes = step === "deploy-web" ? config.webRsyncExcludes : [];

          await executeCommand(this.commandRunner, buildSshCommand(config, `mkdir -p '${remotePath}'`), config.env, trace, input.dry_run);
          await executeCommand(this.commandRunner, buildRsyncCommand(config, sourcePath, remotePath, shouldDelete, excludes), config.env, trace, input.dry_run);

          if (step === "deploy-scripts") {
            await executeCommand(
              this.commandRunner,
              buildSshCommand(config, `find '${remotePath}' -type d -exec chmod ${config.scriptDirMode} {} +`),
              config.env,
              trace,
              input.dry_run,
            );
            await executeCommand(
              this.commandRunner,
              buildSshCommand(config, `find '${remotePath}' -type f -exec chmod ${config.scriptFileMode} {} +`),
              config.env,
              trace,
              input.dry_run,
            );
          }

          return step === "deploy-web" ? "Deploiement web OK" : "Deploiement scripts OK";
        });
        continue;
      }

      if (step === "mirror") {
        await runStep("mirror", async () => {
          requireConfigValue(config.githubRepoUrl, "GITHUB_REPO_URL");
          requireConfigValue(config.giteaRepoUrl, "GITEA_REPO_URL");
          const counts = await mirrorRefs(this.commandRunner, config, trace, input.dry_run);
          return input.dry_run
            ? "Mirror GitHub -> Gitea simule"
            : `Mirror GitHub -> Gitea OK (${String(counts.branches_pushed)} branches, ${String(counts.tags_pushed)} tags)`;
        });
        continue;
      }

      if (step === "webhook") {
        await runStep("webhook", async () => {
          requireConfigValue(config.webhookUrl, "JARVIS_TOOLS_WEBHOOK_URL");
          if (!config.portainerUseStackWebhook) {
            throw new ScriptRunnerError("SCRIPT_EXECUTION_FAILED", "PORTAINER_USE_STACK_WEBHOOK must be enabled");
          }

          trace.push("POST [redacted webhook]");
          if (input.dry_run) {
            return "Webhook simule";
          }

          const response = await this.fetchRunner(config.webhookUrl, {
            method: "POST",
          });

          if (![200, 204].includes(response.status)) {
            throw new ScriptRunnerError("SCRIPT_EXECUTION_FAILED", `Webhook failed with HTTP ${String(response.status)}`);
          }

          return "Webhook Portainer OK";
        });
        continue;
      }

      if (step === "restart") {
        await runStep("restart", async () => {
          if (config.restartStrategy === "webhook" || config.restartStrategy === "portainer-webhook") {
            requireConfigValue(config.webhookUrl, "JARVIS_TOOLS_WEBHOOK_URL");
            trace.push("restart via webhook");
            if (input.dry_run) {
              return "Restart webhook simule";
            }

            const response = await this.fetchRunner(config.webhookUrl, { method: "POST" });
            if (![200, 204].includes(response.status)) {
              throw new ScriptRunnerError("SCRIPT_EXECUTION_FAILED", `Restart webhook failed with HTTP ${String(response.status)}`);
            }

            return "Redemarrage runtime via webhook OK";
          }

          requireConfigValue(config.mcpoContainerName, "JARVIS_MCPO_CONTAINER_NAME");
          const remoteDockerBase = config.useSudo
            ? (config.sshAuthMode === "sshpass" && config.sshPassword
              ? `printf '%s\\n' ${shellQuote(config.sshPassword)} | sudo -S -p '' docker`
              : "sudo docker")
            : "docker";
          await executeCommand(
            this.commandRunner,
            buildSshCommand(
              config,
              `${remoteDockerBase} ps -a --format '{{.Names}}' | grep -Fxq ${shellQuote(config.mcpoContainerName)}`,
            ),
            config.env,
            trace,
            input.dry_run,
          );
          await executeCommand(
            this.commandRunner,
            buildSshCommand(config, `${remoteDockerBase} restart ${shellQuote(config.mcpoContainerName)}`),
            config.env,
            trace,
            input.dry_run,
          );
          return "Redemarrage MCPO OK";
        });
      }
    }

    return {
      ok: true,
      mode: input.mode,
      dry_run: input.dry_run,
      env_source: config.envSource,
      env_file: config.envFile,
      sequence,
      summary: `Workflow ${input.mode} completed`,
      result: {
        run_id: `jarvis_sync_${Date.now()}`,
        phase: input.mode,
        dry_run: input.dry_run,
        ssh_auth_mode: config.sshAuthMode,
        steps,
      },
      trace,
    };
  }
}
