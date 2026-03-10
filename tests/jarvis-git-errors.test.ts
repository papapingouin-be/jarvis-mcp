import assert from "node:assert";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { classifyGitFailure } from "../src/modules/jarvis_git_bridge/services/git-command.ts";
import { JarvisGitBridgeError } from "../src/modules/jarvis_git_bridge/services/errors.ts";
import { GitService } from "../src/modules/jarvis_git_bridge/services/git-service.ts";
import {
  createBareRepository,
  makeProviderRow,
  seedRepository,
  withTempDirectory,
} from "./helpers/git-fixtures.ts";

describe("jarvis_git_bridge major errors", () => {
  it("classifies authentication errors", () => {
    const error = classifyGitFailure("fatal: Authentication failed", "git failed");
    assert(error instanceof JarvisGitBridgeError);
    assert.strictEqual(error.code, "AUTH_ERROR");
  });

  it("raises REPO_NOT_FOUND when source repo is missing", async () => {
    await withTempDirectory(async (root) => {
      const base = pathToFileURL(path.join(root, "missing-root")).toString().replace(/\/$/g, "");
      const provider = makeProviderRow({ id: 1, name: "missing", baseUrl: base, ownerDefault: "jarvis" });
      const targetProvider = makeProviderRow({ id: 2, name: "missing2", baseUrl: base, ownerDefault: "jarvis" });
      const service = new GitService();

      await assert.rejects(
        async () => service.mirrorRepository({
          source: { provider, secretValue: "dummy" },
          sourceRepo: "nope",
          target: { provider: targetProvider, secretValue: "dummy" },
          targetRepo: "nope2",
          mode: "refs",
          createIfMissing: false,
        }),
        (error: unknown) => error instanceof JarvisGitBridgeError && error.code === "REPO_NOT_FOUND"
      );
    });
  });

  it("raises REPO_NOT_FOUND when target repo is missing during compare", async () => {
    await withTempDirectory(async (root) => {
      const sourceRoot = path.join(root, "source");
      const sourceBare = path.join(sourceRoot, "jarvis", "repo-a.git");
      await createBareRepository(sourceBare);
      await seedRepository(sourceBare);

      const sourceProvider = makeProviderRow({
        id: 1,
        name: "source",
        baseUrl: pathToFileURL(sourceRoot).toString().replace(/\/$/g, ""),
        ownerDefault: "jarvis",
      });
      const missingTargetProvider = makeProviderRow({
        id: 2,
        name: "target",
        baseUrl: pathToFileURL(path.join(root, "target-missing")).toString().replace(/\/$/g, ""),
        ownerDefault: "jarvis",
      });

      const service = new GitService();

      await assert.rejects(
        async () => service.compareRefs({
          source: { provider: sourceProvider, secretValue: "dummy" },
          sourceRepo: "repo-a",
          target: { provider: missingTargetProvider, secretValue: "dummy" },
          targetRepo: "repo-b",
        }),
        (error: unknown) => error instanceof JarvisGitBridgeError && error.code === "REPO_NOT_FOUND"
      );
    });
  });

  it("raises REPO_CREATE_FAILED when destination creation cannot be done", async () => {
    await withTempDirectory(async (root) => {
      const sourceRoot = path.join(root, "source");
      const sourceBare = path.join(sourceRoot, "jarvis", "repo-a.git");
      await createBareRepository(sourceBare);
      await seedRepository(sourceBare);

      const sourceProvider = makeProviderRow({
        id: 1,
        name: "source",
        baseUrl: pathToFileURL(sourceRoot).toString().replace(/\/$/g, ""),
        ownerDefault: "jarvis",
      });

      const now = new Date().toISOString();
      const githubProvider = {
        id: 2,
        name: "github-target",
        provider_type: "github" as const,
        base_url: pathToFileURL(path.join(root, "target-missing")).toString().replace(/\/$/g, ""),
        owner_default: "jarvis",
        auth_type: "pat" as const,
        secret_ref: "sec-2",
        is_active: true,
        created_at: now,
        updated_at: now,
      };

      const service = new GitService();

      await assert.rejects(
        async () => service.mirrorRepository({
          source: { provider: sourceProvider, secretValue: "dummy" },
          sourceRepo: "repo-a",
          target: { provider: githubProvider, secretValue: "dummy" },
          targetRepo: "another-owner/repo-b",
          mode: "refs",
          createIfMissing: true,
        }),
        (error: unknown) => error instanceof JarvisGitBridgeError && error.code === "REPO_CREATE_FAILED"
      );
    });
  });

  it("reports divergence warning before sync", async () => {
    await withTempDirectory(async (root) => {
      const sourceRoot = path.join(root, "source");
      const targetRoot = path.join(root, "target");
      const sourceBare = path.join(sourceRoot, "jarvis", "repo-a.git");
      const targetBare = path.join(targetRoot, "jarvis", "repo-b.git");

      await createBareRepository(sourceBare);
      await createBareRepository(targetBare);
      await seedRepository(sourceBare);
      await seedRepository(targetBare);

      const service = new GitService();
      const sourceProvider = makeProviderRow({
        id: 1,
        name: "source",
        baseUrl: pathToFileURL(sourceRoot).toString().replace(/\/$/g, ""),
        ownerDefault: "jarvis",
      });
      const targetProvider = makeProviderRow({
        id: 2,
        name: "target",
        baseUrl: pathToFileURL(targetRoot).toString().replace(/\/$/g, ""),
        ownerDefault: "jarvis",
      });

      const result = await service.mirrorRepository({
        source: { provider: sourceProvider, secretValue: "dummy" },
        sourceRepo: "repo-a",
        target: { provider: targetProvider, secretValue: "dummy" },
        targetRepo: "repo-b",
        mode: "refs",
        createIfMissing: false,
      });

      assert.strictEqual(result.ok, true);
      assert(result.warnings.length >= 1);
    });
  });
});
