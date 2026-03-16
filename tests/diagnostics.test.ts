import assert from "node:assert";
import { describe, it } from "node:test";
import {
  createRequestContext,
  decorateToolResultWithDiagnostics,
  recordDiagnosticEvent,
  sanitizeForLogs,
  withRequestContext,
} from "../src/server/diagnostics.ts";

describe("server diagnostics", () => {
  it("redacts sensitive keys recursively", () => {
    const sanitized = sanitizeForLogs({
      token: "secret-token",
      nested: {
        password: "super-secret",
        safe: "value",
      },
      list: [{ apiKey: "hidden" }],
    }) as {
      token: string;
      nested: { password: string; safe: string };
      list: Array<{ apiKey: string }>;
    };

    assert.strictEqual(sanitized.token, "***");
    assert.strictEqual(sanitized.nested.password, "***");
    assert.strictEqual(sanitized.nested.safe, "value");
    assert.strictEqual(sanitized.list[0]?.apiKey, "***");
  });

  it("injects verbose diagnostics into JSON tool responses", async () => {
    const context = createRequestContext({
      transport: "http",
      sessionId: "session-1",
      ip: "127.0.0.1",
      verbose: true,
    });

    const result = await withRequestContext(context, async () => {
      recordDiagnosticEvent("request.received", "Incoming MCP request", { step: "received" });
      return decorateToolResultWithDiagnostics(
        {
          content: [{
            type: "text",
            text: JSON.stringify({ ok: true }),
          }],
        },
        "diagnose",
        42,
      );
    });

    const text = result.content?.[0]?.text;
    assert.ok(typeof text === "string");

    const parsed = JSON.parse(text) as {
      ok: boolean;
      _mcp_debug?: {
        tool: string;
        duration_ms: number;
        request_id: string;
        events: Array<{ kind: string }>;
      };
    };

    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed._mcp_debug?.tool, "diagnose");
    assert.strictEqual(parsed._mcp_debug?.duration_ms, 42);
    assert.ok(typeof parsed._mcp_debug?.request_id === "string");
    assert.strictEqual(parsed._mcp_debug?.events[0]?.kind, "request.received");
  });

  it("appends a debug block for non JSON tool responses", async () => {
    const context = createRequestContext({
      transport: "http",
      verbose: true,
    });

    const result = await withRequestContext(context, async () => {
      recordDiagnosticEvent("tool.start", "Tool started");
      return decorateToolResultWithDiagnostics(
        {
          content: [{
            type: "text",
            text: "plain text response",
          }],
        },
        "echo",
        5,
      );
    });

    assert.strictEqual(result.content?.length, 2);
    assert.strictEqual(result.content?.[0]?.text, "plain text response");
    assert.match(result.content?.[1]?.text ?? "", /_mcp_debug/);
  });
});