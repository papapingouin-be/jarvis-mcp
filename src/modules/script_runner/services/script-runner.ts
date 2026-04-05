import { access } from "node:fs/promises";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { loadScriptEnvValues } from "../../../config/service.js";
import { ConfiguredScriptRegistry, type ScriptRegistryProvider } from "./script-registry.js";
import { ScriptRunnerError } from "./errors.js";
import type { JarvisRunScriptInput } from "../types/schemas.js";
import type { ScriptDefinition, ScriptEnvDefinition, ScriptRunSuccess } from "../types/domain.js";
import { getScriptRunnerEnvConfig } from "../../../config/env.js";

const execFileAsync = promisify(execFile);
const SCRIPT_TIMEOUT_MS = 120_000;
const TRACE_MAX_LINES = 500;
const JOB_TTL_MS = 60 * 60 * 1000;

type ExecResult = {
  stdout: string;
  stderr: string;
};

type ExecRunner = (filePath: string, args: Array<string>, env: NodeJS.ProcessEnv) => Promise<ExecResult>;
type SpawnRunner = (filePath: string, args: Array<string>, env: NodeJS.ProcessEnv) => ChildProcess;
type ScriptEnvResolver = (scriptName: string) => Promise<Record<string, string>>;
type ScriptPhase = JarvisRunScriptInput["phase"];

type ExecError = {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};

type PreparedExecution = {
  script: ScriptDefinition;
  scriptPath: string;
  args: Array<string>;
  phase: ScriptPhase;
  verbose: boolean;
  env: NodeJS.ProcessEnv;
};

type ScriptJobStatus = "running" | "completed" | "failed";

type ScriptJobRecord = {
  job_id: string;
  script_name: string;
  phase: ScriptPhase;
  status: ScriptJobStatus;
  created_at: string;
  started_at: string;
  ended_at?: string;
  logs: Array<string>;
  result?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
};

type ScriptJobProgress = {
  current: number;
  total: number;
  percent: number;
  label: string | null;
  state: "running" | "ok" | "failed" | "unknown";
  line: string;
};

function toExecResult(stdout: string | Buffer, stderr: string | Buffer): ExecResult {
  return {
    stdout: typeof stdout === "string" ? stdout : stdout.toString("utf8"),
    stderr: typeof stderr === "string" ? stderr : stderr.toString("utf8"),
  };
}

async function defaultExecRunner(filePath: string, args: Array<string>, env: NodeJS.ProcessEnv): Promise<ExecResult> {
  const result = await execFileAsync(filePath, args, {
    env,
    timeout: SCRIPT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });

  return toExecResult(result.stdout, result.stderr);
}

function defaultSpawnRunner(filePath: string, args: Array<string>, env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(filePath, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseScriptJsonOutput(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    throw new ScriptRunnerError("SCRIPT_EMPTY_OUTPUT", "Script did not return JSON output");
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("invalid payload");
    }

    return parsed as Record<string, unknown>;
  } catch {
    throw new ScriptRunnerError("SCRIPT_INVALID_OUTPUT", "Script output is not valid JSON");
  }
}

function buildScriptArgs(input: JarvisRunScriptInput): Array<string> {
  const args: Array<string> = [
    "--phase",
    input.phase,
    "--confirmed",
    input.confirmed === true ? "true" : "false",
  ];

  if (input.params !== undefined) {
    for (const [key, value] of Object.entries(input.params)) {
      args.push("--param", `${key}=${String(value)}`);
    }
  }

  return args;
}

function sanitizeLogLine(
  line: string,
  sensitiveEnvNames: Array<string>,
  env: NodeJS.ProcessEnv
): string {
  let result = line;

  for (const envName of sensitiveEnvNames) {
    const rawValue = env[envName]?.trim();
    if (typeof rawValue === "string" && rawValue.length >= 3) {
      result = result.split(rawValue).join("***");
    }
  }

  result = result.replace(/(password|token|secret)=([^\s]+)/gi, "$1=***");
  return result;
}

function buildTraceLines(
  stderr: string,
  sensitiveEnvNames: Array<string>,
  env: NodeJS.ProcessEnv
): Array<string> {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => sanitizeLogLine(line, sensitiveEnvNames, env))
    .slice(0, TRACE_MAX_LINES);
}

function buildResultWithTrace(
  parsed: Record<string, unknown>,
  stderr: string,
  verbose: boolean,
  sensitiveEnvNames: Array<string>,
  env: NodeJS.ProcessEnv,
): Record<string, unknown> {
  if (!verbose) {
    return parsed;
  }

  return {
    ...parsed,
    trace: buildTraceLines(stderr, sensitiveEnvNames, env),
    live_logs_supported: true,
  };
}

function extractProgressFromLogs(logs: Array<string>): ScriptJobProgress | null {
  const progressPattern = /STEP\s+(\d+)\/(\d+)\s+(START|OK|FAIL):\s*(.+)$/i;

  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const line = logs[index] ?? "";
    const match = line.match(progressPattern);
    if (!match) {
      continue;
    }

    const current = Number.parseInt(match[1] ?? "", 10);
    const total = Number.parseInt(match[2] ?? "", 10);
    if (!Number.isFinite(current) || !Number.isFinite(total) || current <= 0 || total <= 0) {
      continue;
    }

    const rawState = (match[3] ?? "").toUpperCase();
    const label = (match[4] ?? "").trim() || null;
    const percent = Math.max(0, Math.min(100, Math.round((current / total) * 100)));
    const state =
      rawState === "START"
        ? "running"
        : rawState === "OK"
          ? "ok"
          : rawState === "FAIL"
            ? "failed"
            : "unknown";

    return {
      current,
      total,
      percent,
      label,
      state,
      line,
    };
  }

  return null;
}

function toScriptExecutionError(
  stdout: string,
  stderr: string,
  sensitiveEnvNames: Array<string>,
  env: NodeJS.ProcessEnv,
): ScriptRunnerError {
  const trace = buildTraceLines(stderr, sensitiveEnvNames, env);

  if (stdout.trim().length > 0) {
    try {
      const parsed = parseScriptJsonOutput(stdout);
      const summary = parsed.summary;
      if (typeof summary === "string" && summary.trim().length > 0) {
        return new ScriptRunnerError("SCRIPT_EXECUTION_FAILED", summary.trim(), {
          trace,
          live_logs_supported: true,
        });
      }
    } catch {
    }
  }

  return new ScriptRunnerError("SCRIPT_EXECUTION_FAILED", "Script execution failed", {
    trace,
    live_logs_supported: true,
  });
}

function resolveScriptPath(scriptsRoot: string, fileName: string): string {
  const trimmed = fileName.trim();
  if (trimmed.length === 0) {
    throw new ScriptRunnerError("SCRIPT_PATH_INVALID", "Script file path is empty");
  }

  if (path.isAbsolute(trimmed)) {
    throw new ScriptRunnerError("SCRIPT_PATH_INVALID", "Absolute script paths are not allowed");
  }

  const normalizedRelative = path.normalize(trimmed).replace(/[\\/]+/g, path.sep);
  if (normalizedRelative.startsWith(`..${path.sep}`) || normalizedRelative === "..") {
    throw new ScriptRunnerError("SCRIPT_PATH_INVALID", "Parent directory traversal is not allowed");
  }

  const absoluteRoot = path.resolve(scriptsRoot);
  const resolvedPath = path.resolve(absoluteRoot, normalizedRelative);
  const relativeBack = path.relative(absoluteRoot, resolvedPath);

  if (relativeBack.startsWith("..") || path.isAbsolute(relativeBack)) {
    throw new ScriptRunnerError("SCRIPT_PATH_INVALID", "Script path escapes the scripts root");
  }

  return resolvedPath;
}

function toScriptSummary(script: ScriptDefinition): Record<string, unknown> {
  return {
    name: script.name,
    file_name: script.file_name,
    version: script.version ?? null,
    description: script.description ?? null,
    required_env: script.required_env,
  };
}

function isRequiredEnvDefinition(definition: ScriptEnvDefinition): boolean {
  return typeof definition === "string" || definition.required !== false;
}

function getEnvName(definition: ScriptEnvDefinition): string {
  return typeof definition === "string" ? definition : definition.name;
}

export class ScriptRunnerService {
  private readonly scriptsRoot: string;
  private readonly registry: ScriptRegistryProvider;
  private readonly execRunner: ExecRunner;
  private readonly spawnRunner: SpawnRunner;
  private readonly jobs: Map<string, ScriptJobRecord>;
  private readonly sensitiveEnvNames: Array<string>;
  private readonly scriptEnvResolver: ScriptEnvResolver;

  constructor(params?: {
    scriptsRoot?: string;
    registry?: ScriptRegistryProvider;
    execRunner?: ExecRunner;
    spawnRunner?: SpawnRunner;
    sensitiveEnvNames?: Array<string>;
    scriptEnvResolver?: ScriptEnvResolver;
  }) {
    const envConfig = getScriptRunnerEnvConfig();
    this.scriptsRoot = params?.scriptsRoot ?? envConfig.scriptsRoot;
    this.registry = params?.registry ?? new ConfiguredScriptRegistry(envConfig.approvedScripts);
    this.execRunner = params?.execRunner ?? defaultExecRunner;
    this.spawnRunner = params?.spawnRunner ?? defaultSpawnRunner;
    this.jobs = new Map();
    this.sensitiveEnvNames = params?.sensitiveEnvNames ?? envConfig.sensitiveEnvNames;
    this.scriptEnvResolver = params?.scriptEnvResolver ?? loadScriptEnvValues;
  }

  async listScripts(): Promise<{ ok: true; scripts: Array<Record<string, unknown>> }> {
    const scripts = await this.registry.list();
    return {
      ok: true,
      scripts: scripts.map(toScriptSummary),
    };
  }

  async describeScript(scriptName: string): Promise<{ ok: true; script: Record<string, unknown> }> {
    const script = await this.registry.get(scriptName);
    return {
      ok: true,
      script: toScriptSummary(script),
    };
  }

  private async buildExecutionEnv(script: ScriptDefinition): Promise<NodeJS.ProcessEnv> {
    const storedEnv = await this.scriptEnvResolver(script.name);
    return {
      ...process.env,
      ...storedEnv,
    };
  }

  private async prepareExecution(input: JarvisRunScriptInput): Promise<PreparedExecution> {
    if (input.phase === "execute" && input.confirmed !== true) {
      throw new ScriptRunnerError("CONFIRMATION_REQUIRED", "Execution requires confirmed=true");
    }

    const script = await this.registry.get(input.script_name);
    const scriptPath = resolveScriptPath(this.scriptsRoot, script.file_name);
    await access(scriptPath);

    const executionEnv = await this.buildExecutionEnv(script);
    const missingEnv = script.required_env
      .filter((definition) => isRequiredEnvDefinition(definition))
      .map((definition) => getEnvName(definition))
      .filter((name) => {
        const value = executionEnv[name]?.trim();
        return typeof value !== "string" || value.length === 0;
      });

    if (missingEnv.length > 0) {
      throw new ScriptRunnerError(
        "MISSING_ENV",
        `Missing required environment variables: ${missingEnv.join(", ")}`
      );
    }

    return {
      script,
      scriptPath,
      args: buildScriptArgs(input),
      phase: input.phase,
      verbose: input.verbose !== false,
      env: executionEnv,
    };
  }

  async run(input: JarvisRunScriptInput): Promise<ScriptRunSuccess> {
    const prepared = await this.prepareExecution(input);

    try {
      const execution = await this.execRunner(prepared.scriptPath, prepared.args, prepared.env);
      const parsed = parseScriptJsonOutput(execution.stdout);

      return {
        ok: true,
        script_name: prepared.script.name,
        phase: prepared.phase,
        result: buildResultWithTrace(parsed, execution.stderr, prepared.verbose, this.sensitiveEnvNames, prepared.env),
      };
    } catch (error: unknown) {
      if (error instanceof ScriptRunnerError) {
        throw error;
      }

      const execError = error as ExecError;
      const execution = toExecResult(execError.stdout ?? "", execError.stderr ?? "");
      throw toScriptExecutionError(execution.stdout, execution.stderr, this.sensitiveEnvNames, prepared.env);
    }
  }

  async startAsyncJob(input: JarvisRunScriptInput): Promise<{ job_id: string; status: "running" }> {
    const prepared = await this.prepareExecution(input);
    this.cleanupExpiredJobs();

    const jobId = randomUUID();
    const now = new Date().toISOString();
    const job: ScriptJobRecord = {
      job_id: jobId,
      script_name: prepared.script.name,
      phase: prepared.phase,
      status: "running",
      created_at: now,
      started_at: now,
      logs: [],
    };
    this.jobs.set(jobId, job);

    let child: ChildProcess;
    try {
      child = this.spawnRunner(prepared.scriptPath, prepared.args, prepared.env);
    } catch {
      job.status = "failed";
      job.ended_at = new Date().toISOString();
      job.error = {
        code: "SCRIPT_EXECUTION_FAILED",
        message: "Script execution failed",
      };

      return {
        job_id: jobId,
        status: "running",
      };
    }

    let stdoutBuffer = "";
    let stderrBuffer = "";

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdoutBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderrBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");

      while (true) {
        const newlineIndex = stderrBuffer.indexOf("\n");
        if (newlineIndex < 0) {
          break;
        }

        const rawLine = stderrBuffer.slice(0, newlineIndex).trim();
        stderrBuffer = stderrBuffer.slice(newlineIndex + 1);

        if (rawLine.length > 0 && job.logs.length < TRACE_MAX_LINES) {
          job.logs.push(sanitizeLogLine(rawLine, this.sensitiveEnvNames, prepared.env));
        }
      }
    });

    child.on("error", () => {
      if (job.status !== "running") {
        return;
      }

      job.status = "failed";
      job.ended_at = new Date().toISOString();
      job.error = {
        code: "SCRIPT_EXECUTION_FAILED",
        message: "Script execution failed",
      };
    });

    child.on("close", (code) => {
      if (job.status !== "running") {
        return;
      }

      const endedAt = new Date().toISOString();

      const tail = stderrBuffer.trim();
      if (tail.length > 0 && job.logs.length < TRACE_MAX_LINES) {
        job.logs.push(sanitizeLogLine(tail, this.sensitiveEnvNames, prepared.env));
      }

      if (code === 0) {
        try {
          const parsed = parseScriptJsonOutput(stdoutBuffer);
          job.status = "completed";
          job.result = prepared.verbose
            ? { ...parsed, live_logs_supported: true }
            : parsed;
          job.ended_at = endedAt;
          return;
        } catch {
        }
      }

      const error = toScriptExecutionError(stdoutBuffer, job.logs.join("\n"), this.sensitiveEnvNames, prepared.env);
      job.status = "failed";
      job.error = {
        code: error.code,
        message: error.safeMessage,
      };
      job.ended_at = endedAt;
    });

    setTimeout(() => {
      if (job.status === "running") {
        child.kill("SIGTERM");
        job.status = "failed";
        job.ended_at = new Date().toISOString();
        job.error = {
          code: "SCRIPT_TIMEOUT",
          message: "Script execution timed out",
        };
      }
    }, SCRIPT_TIMEOUT_MS);

    return {
      job_id: jobId,
      status: "running",
    };
  }

  getAsyncJob(params: { job_id: string; offset?: number; limit?: number }): {
    ok: true;
    job: Record<string, unknown>;
  } {
    this.cleanupExpiredJobs();

    const job = this.jobs.get(params.job_id);
    if (job === undefined) {
      throw new ScriptRunnerError("JOB_NOT_FOUND", "Script job not found");
    }

    const offset = Math.max(0, params.offset ?? 0);
    const limit = Math.min(500, Math.max(1, params.limit ?? 100));
    const logs = job.logs.slice(offset, offset + limit);

    return {
      ok: true,
      job: {
        job_id: job.job_id,
        script_name: job.script_name,
        phase: job.phase,
        status: job.status,
        created_at: job.created_at,
        started_at: job.started_at,
        ended_at: job.ended_at,
        logs,
        progress: extractProgressFromLogs(job.logs),
        next_offset: offset + logs.length,
        completed: job.status !== "running",
        result: job.result ?? null,
        error: job.error ?? null,
      },
    };
  }

  private cleanupExpiredJobs(): void {
    const nowMs = Date.now();

    for (const [jobId, job] of this.jobs.entries()) {
      if (job.status === "running") {
        continue;
      }

      const endedAtMs = Date.parse(job.ended_at ?? job.created_at);
      if (!Number.isNaN(endedAtMs) && nowMs - endedAtMs > JOB_TTL_MS) {
        this.jobs.delete(jobId);
      }
    }
  }
}
