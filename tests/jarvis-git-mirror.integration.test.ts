import assert from "node:assert";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { GitService } from "../src/modules/jarvis_git_bridge/services/git-service.ts";
import {
  createBareRepository,
  makeProviderRow,
  seedRepository,
  withTempDirectory,
} from "./helpers/git-fixtures.ts";

describe("jarvis_git_bridge mirror integration", () => {
  it("mirrors refs from source to target", async () => {
    await withTempDirectory(async (root) => {
      const giteaRoot = path.join(root, "remote-a");
      const githubRoot = path.join(root, "remote-b");
      const sourceBare = path.join(giteaRoot, "jarvis", "source-repo.git");
      const targetBare = path.join(githubRoot, "jarvis", "target-repo.git");

      await createBareRepository(sourceBare);
      await createBareRepository(targetBare);
      await seedRepository(sourceBare);

      const service = new GitService();
      const sourceProvider = makeProviderRow({
        id: 1,
        name: "local-gitea",
        baseUrl: pathToFileURL(giteaRoot).toString().replace(/\/$/g, ""),
        ownerDefault: "jarvis",
      });
      const targetProvider = makeProviderRow({
        id: 2,
        name: "local-github",
        baseUrl: pathToFileURL(githubRoot).toString().replace(/\/$/g, ""),
        ownerDefault: "jarvis",
      });

      const result = await service.mirrorRepository({
        source: { provider: sourceProvider, secretValue: "dummy" },
        sourceRepo: "source-repo",
        target: { provider: targetProvider, secretValue: "dummy" },
        targetRepo: "target-repo",
        mode: "refs",
        createIfMissing: false,
      });

      assert.strictEqual(result.ok, true);
      assert(result.branches_pushed >= 1);
      assert(result.tags_pushed >= 1);
    });
  });
});
