import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { ApprovedScriptRegistry } from "./script-registry.js";
import { ScriptRunnerError } from "./errors.js";
import type { JarvisRunScriptInput } from "../types/schemas.js";
import type { ScriptRunSuccess } from "../types/domain.js";

const execFileAsync = promisify(execFile);
const SCRIPT_TIMEOUT_MS = 120_000;

type ExecResult = {
  stdout: string;
  stderr: string;
};

type ExecRunner = (filePath: string, args: Array<string>, env: NodeJS.ProcessEnv) => Promise<ExecResult>;

type ExecError = {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
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

export class ScriptRunnerService {
  private readonly scriptsRoot: string;
  private readonly registry: ApprovedScriptRegistry;
  private readonly execRunner: ExecRunner;

  constructor(params?: {
    scriptsRoot?: string;
    registry?: ApprovedScriptRegistry;
    execRunner?: ExecRunner;
  }) {
    this.scriptsRoot = params?.scriptsRoot ?? path.resolve(process.cwd(), "tools", "scripts");
    this.registry = params?.registry ?? new ApprovedScriptRegistry();
    this.execRunner = params?.execRunner ?? defaultExecRunner;
  }

  async run(input: JarvisRunScriptInput): Promise<ScriptRunSuccess> {
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

    const args = buildScriptArgs(input);

    try {
      const execution = await this.execRunner(scriptPath, args, process.env);
      const parsed = parseScriptJsonOutput(execution.stdout);

      return {
        ok: true,
        script_name: script.name,
        phase: input.phase,
        result: parsed,
      };
    } catch (error: unknown) {
      if (error instanceof ScriptRunnerError) {
        throw error;
      }

      const execError = error as ExecError;
      const stdout = toExecResult(execError.stdout ?? "", execError.stderr ?? "").stdout;
      if (stdout.trim().length > 0) {
        try {
          const parsed = parseScriptJsonOutput(stdout);
          const summary = parsed.summary;
          if (typeof summary === "string" && summary.trim().length > 0) {
            throw new ScriptRunnerError("SCRIPT_EXECUTION_FAILED", summary.trim());
          }
        } catch {
        }
      }

      throw new ScriptRunnerError("SCRIPT_EXECUTION_FAILED", "Script execution failed");
    }
  }
}
