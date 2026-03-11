import { access } from "node:fs/promises";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { ApprovedScriptRegistry } from "./script-registry.js";
import { ScriptRunnerError } from "./errors.js";
import type { JarvisRunScriptInput } from "../types/schemas.js";
import type { ScriptRunSuccess } from "../types/domain.js";

const execFileAsync = promisify(execFile);
const SCRIPT_TIMEOUT_MS = 120_000;
const TRACE_MAX_LINES = 500;
const JOB_TTL_MS = 60 * 60 * 1000;
const SENSITIVE_ENV_NAMES = [
  "PROXMOX_PASSWORD",
  "PROXMOX_API_TOKEN_SECRET",
  "PROXMOX_API_TOKEN_ID",
  "NPM_SECRET",
];

type ExecResult = {
  stdout: string;
  stderr: string;
};

type ExecRunner = (filePath: string, args: Array<string>, env: NodeJS.ProcessEnv) => Promise<ExecResult>;
type SpawnRunner = (filePath: string, args: Array<string>, env: NodeJS.ProcessEnv) => ChildProcess;

type ExecError = {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};

type PreparedExecution = {
  scriptName: string;
  scriptPath: string;
  args: Array<string>;
  phase: "collect" | "execute";
  verbose: boolean;
};

type ScriptJobStatus = "running" | "completed" | "failed";

type ScriptJobRecord = {
  job_id: string;
  script_name: string;
  phase: "collect" | "execute";
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

function sanitizeLogLine(line: string): string {
  let result = line;

  for (const envName of SENSITIVE_ENV_NAMES) {
    const rawValue = process.env[envName]?.trim();
    if (typeof rawValue === "string" && rawValue.length >= 3) {
      result = result.split(rawValue).join("***");
    }
  }

  result = result.replace(/(password|token|secret)=([^\s]+)/gi, "$1=***");
  return result;
}

function buildTraceLines(stderr: string): Array<string> {
  return stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(sanitizeLogLine)
    .slice(0, TRACE_MAX_LINES);
}

function buildResultWithTrace(parsed: Record<string, unknown>, stderr: string, verbose: boolean): Record<string, unknown> {
  if (!verbose) {
    return parsed;
  }

  return {
    ...parsed,
    trace: buildTraceLines(stderr),
    live_logs_supported: true,
  };
}

function toScriptExecutionError(stdout: string, stderr: string): ScriptRunnerError {
  const trace = buildTraceLines(stderr);

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

export class ScriptRunnerService {
  private readonly scriptsRoot: string;
  private readonly registry: ApprovedScriptRegistry;
  private readonly execRunner: ExecRunner;
  private readonly spawnRunner: SpawnRunner;
  private readonly jobs: Map<string, ScriptJobRecord>;

  constructor(params?: {
    scriptsRoot?: string;
    registry?: ApprovedScriptRegistry;
    execRunner?: ExecRunner;
    spawnRunner?: SpawnRunner;
  }) {
    this.scriptsRoot = params?.scriptsRoot ?? path.resolve(process.cwd(), "tools", "scripts");
    this.registry = params?.registry ?? new ApprovedScriptRegistry();
    this.execRunner = params?.execRunner ?? defaultExecRunner;
    this.spawnRunner = params?.spawnRunner ?? defaultSpawnRunner;
    this.jobs = new Map();
  }

  private async prepareExecution(input: JarvisRunScriptInput): Promise<PreparedExecution> {
    if (input.phase === "execute" && input.confirmed !== true) {
      throw new ScriptRunnerError("CONFIRMATION_REQUIRED", "Execution requires confirmed=true");
    }

    const script = this.registry.get(input.script_name);
    const scriptPath = path.join(this.scriptsRoot, script.file_name);
    await access(scriptPath);

    const missingEnv = script.required_env.filter((name) => {
      const value = process.env[name]?.trim();
      return typeof value !== "string" || value.length === 0;
    });

    if (missingEnv.length > 0) {
      throw new ScriptRunnerError(
        "MISSING_ENV",
        `Missing required environment variables: ${missingEnv.join(", ")}`
      );
    }

    return {
      scriptName: script.name,
      scriptPath,
      args: buildScriptArgs(input),
      phase: input.phase,
      verbose: input.verbose !== false,
    };
  }

  async run(input: JarvisRunScriptInput): Promise<ScriptRunSuccess> {
    const prepared = await this.prepareExecution(input);

    try {
      const execution = await this.execRunner(prepared.scriptPath, prepared.args, process.env);
      const parsed = parseScriptJsonOutput(execution.stdout);

      return {
        ok: true,
        script_name: prepared.scriptName,
        phase: prepared.phase,
        result: buildResultWithTrace(parsed, execution.stderr, prepared.verbose),
      };
    } catch (error: unknown) {
      if (error instanceof ScriptRunnerError) {
        throw error;
      }

      const execError = error as ExecError;
      const execution = toExecResult(execError.stdout ?? "", execError.stderr ?? "");
      throw toScriptExecutionError(execution.stdout, execution.stderr);
    }
  }

  async startAsyncJob(input: JarvisRunScriptInput): Promise<{ job_id: string; status: "running" }> {
    const prepared = await this.prepareExecution(input);
    this.cleanupExpiredJobs();

    const jobId = randomUUID();
    const now = new Date().toISOString();
    const job: ScriptJobRecord = {
      job_id: jobId,
      script_name: prepared.scriptName,
      phase: prepared.phase,
      status: "running",
      created_at: now,
      started_at: now,
      logs: [],
    };
    this.jobs.set(jobId, job);

    let child: ChildProcess;
    try {
      child = this.spawnRunner(prepared.scriptPath, prepared.args, process.env);
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
          job.logs.push(sanitizeLogLine(rawLine));
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
        job.logs.push(sanitizeLogLine(tail));
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

      const error = toScriptExecutionError(stdoutBuffer, job.logs.join("\n"));
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
