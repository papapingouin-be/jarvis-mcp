import assert from "node:assert";
import { describe, it } from "node:test";
import { withTestClient } from "./helpers/test-client.ts";

type AutotestRuntimeResponse = {
  ok: boolean;
  status: "OK" | "KO";
  checks: {
    package_json_read_ok: boolean;
    package_json_has_pg_dependency: boolean;
    pg_module_resolvable: boolean;
    connection_string_present: boolean;
  };
  runtime: {
    cwd: string;
    node_version: string;
    package_name: string | null;
    pg_module_name: string;
  };
};

describe("jarvis_autotest_runtime tool", () => {
  it("should be listed among available tools", async () => {
    await withTestClient(async (client) => {
      const response = await client.listTools();
      const tool = response.tools.find((entry) => entry.name === "jarvis_autotest_runtime");

      assert(tool !== undefined, "jarvis_autotest_runtime should be listed");
      assert.strictEqual(tool.description, "Check runtime prerequisites such as env vars, module resolution, and package metadata.");
    });
  });

  it("should return a JSON prerequisite report", async () => {
    await withTestClient(async (client) => {
      const response = await client.callTool("jarvis_autotest_runtime", {});
      const text = (response.content[0] as { text?: string } | undefined)?.text;

      assert.ok(typeof text === "string", "tool should return text content");

      const parsed = JSON.parse(text) as AutotestRuntimeResponse;
      assert.strictEqual(typeof parsed.ok, "boolean");
      assert.ok(parsed.status === "OK" || parsed.status === "KO");
      assert.strictEqual(typeof parsed.checks.package_json_read_ok, "boolean");
      assert.strictEqual(typeof parsed.checks.package_json_has_pg_dependency, "boolean");
      assert.strictEqual(typeof parsed.checks.pg_module_resolvable, "boolean");
      assert.strictEqual(typeof parsed.runtime.pg_module_name, "string");
    });
  });
});