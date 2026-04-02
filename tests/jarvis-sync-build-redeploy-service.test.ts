import assert from "node:assert";
import { describe, it } from "node:test";
import { JarvisSyncBuildRedeployService } from "../src/config/jarvis-sync-build-redeploy-service.ts";
import { ScriptRunnerError } from "../src/modules/script_runner/services/errors.ts";

function withEnv(values: Record<string, string>, work: () => Promise<void>): Promise<void> {
  const snapshot = { ...process.env };
  Object.assign(process.env, values);

  return work().finally(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) {
        delete process.env[key];
      }
    }

    Object.assign(process.env, snapshot);
  });
}

describe("jarvis sync build redeploy service", () => {
  it("returns the execution sequence for describe-service", async () => {
    const service = new JarvisSyncBuildRedeployService();

    const payload = await service.collect({
      mode: "describe-service",
      service: "all",
      dry_run: true,
    });

    assert.strictEqual(payload.ok, true);
    assert.deepStrictEqual(payload.sequence, [
      "sync",
      "install",
      "build",
      "deploy-web",
      "deploy-scripts",
      "mirror",
      "webhook",
      "restart",
    ]);
  });

  it("requires confirmation for execute when dry_run is false", async () => {
    const service = new JarvisSyncBuildRedeployService();

    await assert.rejects(
      async () => service.execute({
        mode: "sync",
        confirmed: false,
        dry_run: false,
      }),
      (error: unknown) => error instanceof ScriptRunnerError && error.code === "CONFIRMATION_REQUIRED"
    );
  });

  it("runs in dry-run mode without relying on shell helper scripts", async () => {
    const commands: Array<{ command: string; args: Array<string> }> = [];
    const service = new JarvisSyncBuildRedeployService(
      async (params) => {
        commands.push({ command: params.command, args: params.args });
        return {
          stdout: "",
          stderr: "",
        };
      },
      async () => new Response("", { status: 204 }),
    );

    await withEnv({
      jarvis_tools_GITHUB_TOKEN: "gh-token",
      jarvis_tools_GITEA_TOKEN: "gitea-token",
      JARVIS_LOCAL_REPO: "/tmp/jarvis-mcp",
      JARVIS_srv_SSH: "jarvis.example.org:22",
      JARVIS_srv_USER: "deploy",
      JARVIS_TOOLS_WEBHOOK_URL: "https://example.invalid/webhook",
    }, async () => {
      const payload = await service.execute({
        mode: "all",
        confirmed: false,
        dry_run: true,
      });

      assert.strictEqual(payload.ok, true);
      assert.deepStrictEqual(payload.sequence, [
        "sync",
        "install",
        "build",
        "deploy-web",
        "deploy-scripts",
        "mirror",
        "webhook",
        "restart",
      ]);

      const trace = payload.trace;
      assert(Array.isArray(trace));
      assert(trace.some((line) => line.includes("git clone --mirror")));
      assert(trace.some((line) => line.includes("rsync")));
      assert(trace.some((line) => line.includes("POST [redacted webhook]")));
      assert.strictEqual(commands.length, 0);
    });
  });

  it("prefers Portainer API redeploy when Portainer credentials are available", async () => {
    const service = new JarvisSyncBuildRedeployService(
      async () => ({ stdout: "", stderr: "" }),
      async () => new Response("", { status: 204 }),
    );

    await withEnv({
      jarvis_tools_GITHUB_TOKEN: "gh-token",
      jarvis_tools_GITEA_TOKEN: "gitea-token",
      JARVIS_LOCAL_REPO: "/tmp/jarvis-mcp",
      JARVIS_srv_SSH: "jarvis.example.org:22",
      JARVIS_srv_USER: "deploy",
      jarvis_tools_PORTAINER_URL: "192.168.11.206:9443",
      jarvis_tools_PORTAINER_USER: "jarvisadmin",
      jarvis_tools_PORTAINER_PASSWORD: "secret",
      PORTAINER_ENDPOINT_ID: "3",
      JARVIS_TOOLS_STACK_NAME: "jarvis-tools",
    }, async () => {
      const payload = await service.execute({
        mode: "webhook",
        confirmed: false,
        dry_run: true,
      });

      assert.strictEqual(payload.ok, true);
      assert(payload.trace.some((line) => line.includes("/api/auth")));
      assert(payload.trace.some((line) => line.includes("/api/stacks?endpointId=3")));
      assert(payload.trace.some((line) => line.includes("Resolve stack name jarvis-tools")));
    });
  });
});
