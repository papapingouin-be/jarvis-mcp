import assert from "node:assert";
import { describe, it } from "node:test";
import { withTestClient } from "./helpers/test-client.ts";

type AutotestDbResponse = {
  ok: boolean;
  status: "OK" | "KO";
  checks: {
    connection_string_present: boolean;
    pg_module_name?: string;
    connectivity_query_ok?: boolean;
    config_store_migrations_ok?: boolean;
    app_config_read_ok?: boolean;
    script_registry_read_ok?: boolean;
    script_env_read_ok?: boolean;
  };
  database?: {
    now_utc: string | null;
  };
  summary?: {
    app_config_keys_read: Array<string>;
    active_script_count: number;
    proxmox_env_keys_found: Array<string>;
  };
  error?: {
    code: string;
    message: string;
  };
};

describe("jarvis_autotest_db tool", () => {
  it("should be listed among available tools", async () => {
    await withTestClient(async (client) => {
      const response = await client.listTools();
      const tool = response.tools.find((entry) => entry.name === "jarvis_autotest_db");

      assert(tool !== undefined, "jarvis_autotest_db should be listed");
      assert.strictEqual(tool.description, "Run a database connectivity/config-store autotest and return a JSON report.");
    });
  });

  it("should return a JSON autotest report", async () => {
    await withTestClient(async (client) => {
      const response = await client.callTool("jarvis_autotest_db", {});
      const text = (response.content[0] as { text?: string } | undefined)?.text;

      assert.ok(typeof text === "string", "tool should return text content");

      const parsed = JSON.parse(text) as AutotestDbResponse;
      assert.strictEqual(typeof parsed.ok, "boolean");
      assert.ok(parsed.status === "OK" || parsed.status === "KO");
      assert.strictEqual(typeof parsed.checks.connection_string_present, "boolean");

      if (parsed.ok) {
        assert.strictEqual(parsed.checks.connectivity_query_ok, true);
        assert.strictEqual(parsed.checks.config_store_migrations_ok, true);
        assert.strictEqual(typeof parsed.summary?.active_script_count, "number");
      } else {
        assert.ok(typeof parsed.error?.code === "string");
        assert.ok(typeof parsed.error?.message === "string");
      }
    });
  });
});