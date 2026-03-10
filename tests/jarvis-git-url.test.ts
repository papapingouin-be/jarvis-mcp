import assert from "node:assert";
import { describe, it } from "node:test";
import { buildRemoteUrl, sanitizeRemoteUrl } from "../src/modules/jarvis_git_bridge/services/git-url.ts";

describe("jarvis_git_bridge git urls", () => {
  it("builds repository URL without embedding credentials", () => {
    const url = buildRemoteUrl("https://github.com", "jarvis", "home-assistant");
    assert.strictEqual(url, "https://github.com/jarvis/home-assistant.git");
    assert.strictEqual(url.includes("@"), false);
  });

  it("redacts URL credentials", () => {
    const redacted = sanitizeRemoteUrl("https://user:token@example.com/org/repo.git");
    assert.strictEqual(redacted.includes("token"), false);
    assert.strictEqual(redacted, "https://example.com/org/repo.git");
  });
});
