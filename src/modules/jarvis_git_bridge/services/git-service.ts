import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import { runGitCommand } from "./git-command.js";
import { buildRemoteUrl, normalizeRepoName, sanitizeRemoteUrl } from "./git-url.js";
import { JarvisGitBridgeError } from "./errors.js";
import type { GitProviderRow } from "../types/domain.js";
import type { GitMirrorModeSchema } from "../types/type-tags.js";

type ProviderWithSecret = {
  provider: GitProviderRow;
  secretValue: string;
};

type RefMap = Map<string, string>;

type CompareResult = {
  ok: boolean;
  source_only_refs: Array<string>;
  target_only_refs: Array<string>;
  divergent_refs: Array<string>;
  summary: string;
};

type MirrorResult = {
  ok: boolean;
  mode: GitMirrorModeSchema;
  source: string;
  target: string;
  summary: string;
  branches_pushed: number;
  tags_pushed: number;
  warnings: Array<string>;
};

function parseLsRemoteOutput(output: string): RefMap {
  const map: RefMap = new Map();
  const lines = output.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);

  for (const line of lines) {
    const [hash, ref] = line.split(/\s+/);
    if (typeof hash === "string" && typeof ref === "string") {
      map.set(ref, hash);
    }
  }

  return map;
}

function buildGitAuthArgs(provider: GitProviderRow, secretValue: string): Array<string> {
  if (provider.auth_type === "ssh_key") {
    throw new JarvisGitBridgeError("SSH_NOT_IMPLEMENTED", "SSH key authentication is not implemented yet");
  }

  const username = provider.auth_type === "pat" && provider.provider_type === "github"
    ? "x-access-token"
    : provider.owner_default;
  const value = Buffer.from(`${username}:${secretValue}`, "utf8").toString("base64");

  return ["-c", `http.extraHeader=AUTHORIZATION: Basic ${value}`];
}

function splitRepo(input: string): { owner: string | null; name: string } {
  const normalized = input.trim().replace(/^\/+|\/+$/g, "");
  const parts = normalized.split("/").filter((part) => part.length > 0);

  if (parts.length === 1) {
    const first = parts[0];
    if (typeof first !== "string") {
      throw new JarvisGitBridgeError("INVALID_REPO", "Repository format is invalid");
    }

    return { owner: null, name: first };
  }

  const name = parts[parts.length - 1];
  const owner = parts[parts.length - 2];
  if (typeof name !== "string" || typeof owner !== "string") {
    throw new JarvisGitBridgeError("INVALID_REPO", "Repository format is invalid");
  }

  return { owner, name };
}

function buildApiHeaders(provider: GitProviderRow, secretValue: string): Headers {
  const headers = new Headers();
  headers.set("Content-Type", "application/json");

  if (provider.auth_type === "ssh_key") {
    throw new JarvisGitBridgeError("SSH_NOT_IMPLEMENTED", "SSH key authentication is not implemented yet");
  }

  if (provider.auth_type === "basic") {
    const token = Buffer.from(`${provider.owner_default}:${secretValue}`, "utf8").toString("base64");
    headers.set("Authorization", `Basic ${token}`);
    return headers;
  }

  if (provider.provider_type === "github") {
    headers.set("Authorization", `Bearer ${secretValue}`);
    headers.set("X-GitHub-Api-Version", "2022-11-28");
  } else {
    headers.set("Authorization", `token ${secretValue}`);
  }

  return headers;
}

async function withTempGitDir<TValue>(fn: (tempDir: string) => Promise<TValue>): Promise<TValue> {
  const base = await mkdtemp(path.join(tmpdir(), "jarvis-git-bridge-"));

  try {
    return await fn(base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

async function listRemoteRefs(providerSecret: ProviderWithSecret, remoteUrl: string): Promise<RefMap> {
  const authArgs = buildGitAuthArgs(providerSecret.provider, providerSecret.secretValue);
  const result = await runGitCommand({
    cwd: process.cwd(),
    args: [...authArgs, "ls-remote", "--heads", "--tags", remoteUrl],
  });

  return parseLsRemoteOutput(result.stdout);
}

function computeCompare(sourceRefs: RefMap, targetRefs: RefMap): CompareResult {
  const sourceOnly: Array<string> = [];
  const targetOnly: Array<string> = [];
  const divergent: Array<string> = [];

  for (const [ref, hash] of sourceRefs.entries()) {
    if (!targetRefs.has(ref)) {
      sourceOnly.push(ref);
      continue;
    }

    const targetHash = targetRefs.get(ref);
    if (targetHash !== hash) {
      divergent.push(ref);
    }
  }

  for (const ref of targetRefs.keys()) {
    if (!sourceRefs.has(ref)) {
      targetOnly.push(ref);
    }
  }

  return {
    ok: true,
    source_only_refs: sourceOnly.sort(),
    target_only_refs: targetOnly.sort(),
    divergent_refs: divergent.sort(),
    summary: `source_only=${String(sourceOnly.length)}, target_only=${String(targetOnly.length)}, divergent=${String(divergent.length)}`,
  };
}

async function countRefs(localMirrorPath: string): Promise<{ branches: number; tags: number }> {
  const branchOutput = await runGitCommand({
    cwd: localMirrorPath,
    args: ["for-each-ref", "--format=%(refname)", "refs/heads"],
  });
  const tagOutput = await runGitCommand({
    cwd: localMirrorPath,
    args: ["for-each-ref", "--format=%(refname)", "refs/tags"],
  });

  const branches = branchOutput.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0).length;
  const tags = tagOutput.stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0).length;

  return { branches, tags };
}

async function createRemoteRepository(providerSecret: ProviderWithSecret, repoName: string): Promise<void> {
  const provider = providerSecret.provider;
  const headers = buildApiHeaders(provider, providerSecret.secretValue);
  const { owner, name } = splitRepo(repoName);

  const endpoint = provider.provider_type === "github"
    ? `${provider.base_url.replace(/\/+$/g, "")}/user/repos`
    : `${provider.base_url.replace(/\/+$/g, "")}/api/v1/user/repos`;

  if (owner !== null && owner !== provider.owner_default && provider.provider_type === "github") {
    throw new JarvisGitBridgeError(
      "REPO_CREATE_FAILED",
      "Repository creation only supports provider owner_default"
    );
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ name, private: true }),
  });

  if (response.status === 401 || response.status === 403) {
    throw new JarvisGitBridgeError("AUTH_ERROR", "Authentication failed");
  }

  if (response.status === 409 || response.status === 422) {
    return;
  }

  if (!response.ok) {
    throw new JarvisGitBridgeError("REPO_CREATE_FAILED", "Failed to create destination repository");
  }
}

export class GitService {
  async testConnection(providerSecret: ProviderWithSecret): Promise<{ ok: boolean; testSummary: string }> {
    if (providerSecret.provider.auth_type === "ssh_key") {
      return {
        ok: false,
        testSummary: "SSH key authentication is not implemented yet",
      };
    }

    const endpoint = providerSecret.provider.provider_type === "github"
      ? `${providerSecret.provider.base_url.replace(/\/+$/g, "")}/user`
      : `${providerSecret.provider.base_url.replace(/\/+$/g, "")}/api/v1/user`;

    const response = await fetch(endpoint, {
      method: "GET",
      headers: buildApiHeaders(providerSecret.provider, providerSecret.secretValue),
    });

    if (response.status === 401 || response.status === 403) {
      return { ok: false, testSummary: "Authentication failed" };
    }

    if (!response.ok) {
      return { ok: false, testSummary: `HTTP ${String(response.status)} during provider test` };
    }

    return {
      ok: true,
      testSummary: "Connection successful",
    };
  }

  async compareRefs(params: {
    source: ProviderWithSecret;
    sourceRepo: string;
    target: ProviderWithSecret;
    targetRepo: string;
  }): Promise<CompareResult> {
    const sourceRepoPath = normalizeRepoName(params.source.provider.owner_default, params.sourceRepo);
    const targetRepoPath = normalizeRepoName(params.target.provider.owner_default, params.targetRepo);
    const sourceRemote = buildRemoteUrl(params.source.provider.base_url, params.source.provider.owner_default, sourceRepoPath);
    const targetRemote = buildRemoteUrl(params.target.provider.base_url, params.target.provider.owner_default, targetRepoPath);

    const sourceRefs = await listRemoteRefs(params.source, sourceRemote);
    const targetRefs = await listRemoteRefs(params.target, targetRemote);
    return computeCompare(sourceRefs, targetRefs);
  }

  async mirrorRepository(params: {
    source: ProviderWithSecret;
    sourceRepo: string;
    target: ProviderWithSecret;
    targetRepo: string;
    mode: GitMirrorModeSchema;
    createIfMissing: boolean;
  }): Promise<MirrorResult> {
    const sourceRepoPath = normalizeRepoName(params.source.provider.owner_default, params.sourceRepo);
    const targetRepoPath = normalizeRepoName(params.target.provider.owner_default, params.targetRepo);
    const sourceRemote = buildRemoteUrl(params.source.provider.base_url, params.source.provider.owner_default, sourceRepoPath);
    const targetRemote = buildRemoteUrl(params.target.provider.base_url, params.target.provider.owner_default, targetRepoPath);

    if (params.createIfMissing) {
      try {
        await listRemoteRefs(params.target, targetRemote);
      } catch (error: unknown) {
        if (error instanceof JarvisGitBridgeError && error.code === "REPO_NOT_FOUND") {
          await createRemoteRepository(params.target, targetRepoPath);
        } else {
          throw error;
        }
      }
    }

    const warnings: Array<string> = [];
    const compare = await this.compareRefs({
      source: params.source,
      sourceRepo: sourceRepoPath,
      target: params.target,
      targetRepo: targetRepoPath,
    });

    if (compare.divergent_refs.length > 0 || compare.target_only_refs.length > 0) {
      warnings.push("Destination contains divergent refs that may be overwritten");
    }

    const counts = await withTempGitDir(async (tempDir) => {
      const mirrorPath = path.join(tempDir, "mirror.git");
      const sourceAuthArgs = buildGitAuthArgs(params.source.provider, params.source.secretValue);
      const targetAuthArgs = buildGitAuthArgs(params.target.provider, params.target.secretValue);

      await runGitCommand({
        cwd: tempDir,
        args: [...sourceAuthArgs, "clone", "--mirror", sourceRemote, mirrorPath],
      });

      await runGitCommand({
        cwd: mirrorPath,
        args: ["remote", "set-url", "--push", "origin", targetRemote],
      });

      if (params.mode === "mirror") {
        await runGitCommand({
          cwd: mirrorPath,
          args: [...targetAuthArgs, "push", "--mirror", "origin"],
        });
      } else {
        await runGitCommand({
          cwd: mirrorPath,
          args: [...targetAuthArgs, "push", "--prune", "origin", "refs/heads/*:refs/heads/*"],
        });
        await runGitCommand({
          cwd: mirrorPath,
          args: [...targetAuthArgs, "push", "--tags", "origin"],
        });
      }

      return countRefs(mirrorPath);
    });

    return {
      ok: true,
      mode: params.mode,
      source: sanitizeRemoteUrl(sourceRemote),
      target: sanitizeRemoteUrl(targetRemote),
      summary: `Mirrored ${String(counts.branches)} branches and ${String(counts.tags)} tags`,
      branches_pushed: counts.branches,
      tags_pushed: counts.tags,
      warnings,
    };
  }
}

