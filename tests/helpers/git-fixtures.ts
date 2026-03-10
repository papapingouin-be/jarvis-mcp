import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);

export async function withTempDirectory<TValue>(fn: (dir: string) => Promise<TValue>): Promise<TValue> {
  const directory = await mkdtemp(path.join(tmpdir(), "jarvis-git-bridge-tests-"));

  try {
    return await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runGit(cwd: string, args: Array<string>): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
    },
  });

  return stdout.toString();
}

export async function createBareRepository(repoPath: string): Promise<void> {
  await mkdir(path.dirname(repoPath), { recursive: true });
  await runGit(path.dirname(repoPath), ["init", "--bare", path.basename(repoPath)]);
}

export async function seedRepository(barePath: string): Promise<void> {
  const worktree = `${barePath}-work`;
  await mkdir(path.dirname(worktree), { recursive: true });
  await runGit(path.dirname(worktree), ["init", path.basename(worktree)]);
  await runGit(worktree, ["config", "user.email", "jarvis@example.local"]);
  await runGit(worktree, ["config", "user.name", "Jarvis Test"]);
  await runGit(worktree, ["checkout", "-b", "main"]);

  await writeFile(path.join(worktree, "README.md"), "initial\n", "utf8");
  await runGit(worktree, ["add", "README.md"]);
  await runGit(worktree, ["commit", "-m", "init"]);
  await runGit(worktree, ["tag", "v1.0.0"]);
  await runGit(worktree, ["branch", "develop"]);
  await runGit(worktree, ["remote", "add", "origin", pathToFileURL(barePath).toString()]);
  await runGit(worktree, ["push", "origin", "main", "develop", "--tags"]);

  await rm(worktree, { recursive: true, force: true });
}

export async function listRefs(repoPath: string): Promise<string> {
  return runGit(repoPath, ["show-ref", "--heads", "--tags"]);
}

export function makeProviderRow(params: {
  id: number;
  name: string;
  baseUrl: string;
  ownerDefault: string;
}): {
  id: number;
  name: string;
  provider_type: "gitea";
  base_url: string;
  owner_default: string;
  auth_type: "basic";
  secret_ref: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
} {
  const now = new Date().toISOString();

  return {
    id: params.id,
    name: params.name,
    provider_type: "gitea",
    base_url: params.baseUrl,
    owner_default: params.ownerDefault,
    auth_type: "basic",
    secret_ref: `sec-${params.id}`,
    is_active: true,
    created_at: now,
    updated_at: now,
  };
}
