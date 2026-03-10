import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { JarvisGitBridgeError } from "./errors.js";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 120_000;

export type GitCommandResult = {
  stdout: string;
  stderr: string;
};

type ExecFailure = {
  message?: string;
  stderr?: string;
};

export function classifyGitFailure(stderr: string, message: string): JarvisGitBridgeError {
  const combined = `${stderr}\n${message}`.toLowerCase();

  if (combined.includes("authentication failed") || combined.includes("not authorized")) {
    return new JarvisGitBridgeError("AUTH_ERROR", "Authentication failed");
  }

  if (
    combined.includes("repository not found")
    || combined.includes("does not appear to be a git repository")
    || combined.includes("not found")
  ) {
    return new JarvisGitBridgeError("REPO_NOT_FOUND", "Repository not found");
  }

  if (combined.includes("could not resolve host") || combined.includes("failed to connect")) {
    return new JarvisGitBridgeError("NETWORK_ERROR", "Cannot reach remote provider");
  }

  return new JarvisGitBridgeError("GIT_COMMAND_FAILED", "Git command failed");
}

export async function runGitCommand(params: {
  cwd: string;
  args: Array<string>;
  extraEnv?: Record<string, string>;
}): Promise<GitCommandResult> {
  const env = {
    ...process.env,
    ...(params.extraEnv ?? {}),
  };

  try {
    const { stdout, stderr } = await execFileAsync("git", params.args, {
      cwd: params.cwd,
      env,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });

    return {
      stdout: stdout.toString(),
      stderr: stderr.toString(),
    };
  } catch (error: unknown) {
    const failure = error as ExecFailure;
    const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
    const message = typeof failure.message === "string" ? failure.message : "Git command failed";
    throw classifyGitFailure(stderr, message);
  }
}

