import assert from "node:assert";
import { describe, it } from "node:test";
import { resolveSessionId } from "../src/server/session.ts";

describe("resolveSessionId", () => {
  it("uses Mcp-Session-Id when provided", () => {
    const result = resolveSessionId({ "Mcp-Session-Id": "abc-123" });
    assert.strictEqual(result.sessionId, "abc-123");
    assert.strictEqual(result.source, "existing");
  });

  it("uses x-mcp-session-id when canonical header is absent", () => {
    const result = resolveSessionId({ "x-mcp-session-id": "xyz-987" });
    assert.strictEqual(result.sessionId, "xyz-987");
    assert.strictEqual(result.source, "existing");
  });

  it("generates a session id when headers are absent", () => {
    const result = resolveSessionId({});
    assert.strictEqual(result.source, "generated");
    assert.ok(result.sessionId.length > 0);
  });
});
