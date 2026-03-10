import assert from "node:assert";
import { describe, it } from "node:test";
import {
  gitMirrorRepoInputSchema,
  gitRegisterProviderInputSchema,
  gitStoreSecretInputSchema,
} from "../src/modules/jarvis_git_bridge/types/schemas.ts";

describe("jarvis_git_bridge input validation", () => {
  it("accepts valid provider registration input", () => {
    const result = gitRegisterProviderInputSchema.safeParse({
      name: "home-gitea",
      provider_type: "gitea",
      base_url: "https://gitea.local",
      owner_default: "jarvis",
      auth_type: "pat",
      secret_ref: "gitea_pat",
    });

    assert.strictEqual(result.success, true);
  });

  it("rejects invalid secret type", () => {
    const result = gitStoreSecretInputSchema.safeParse({
      secret_name: "x",
      secret_type: "token",
      secret_value: "abc",
    });

    assert.strictEqual(result.success, false);
  });

  it("rejects invalid mirror mode", () => {
    const result = gitMirrorRepoInputSchema.safeParse({
      source_provider: "gitea",
      source_repo: "home/repo",
      target_provider: "github",
      target_repo: "home/repo",
      mode: "full",
      create_if_missing: true,
    });

    assert.strictEqual(result.success, false);
  });
});
