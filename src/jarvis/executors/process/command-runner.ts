import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type CommandRequest = {
  command: string;
  args: Array<string>;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

export type CommandResult = {
  stdout: string;
  stderr: string;
};

export type CommandRunner = (request: CommandRequest) => Promise<CommandResult>;

export function createExecFileCommandRunner(params?: {
  defaultTimeoutMs?: number;
  defaultMaxBuffer?: number;
}): CommandRunner {
  const defaultTimeoutMs = params?.defaultTimeoutMs;
  const defaultMaxBuffer = params?.defaultMaxBuffer ?? 8 * 1024 * 1024;

  return async (request) => {
    const result = await execFileAsync(request.command, request.args, {
      cwd: request.cwd,
      env: request.env,
      timeout: request.timeoutMs ?? defaultTimeoutMs,
      maxBuffer: defaultMaxBuffer,
    });

    return {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  };
}
