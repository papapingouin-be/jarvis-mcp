import assert from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ScriptRunnerError } from "../src/modules/script_runner/services/errors.ts";
import { ApprovedScriptRegistry } from "../src/modules/script_runner/services/script-registry.ts";
import { ScriptRunnerService } from "../src/modules/script_runner/services/script-runner.ts";

describe("script runner service", () => {
  it("refuses non-allowlisted scripts", async () => {
    const service = new ScriptRunnerService();

    await assert.rejects(
      async () => service.run({
        script_name: "evil.sh",
        phase: "collect",
      }),
      (error: unknown) => error instanceof ScriptRunnerError && error.code === "SCRIPT_NOT_ALLOWED"
    );
  });

  it("refuses execute when confirmed is not true", async () => {
    const service = new ScriptRunnerService();

    await assert.rejects(
      async () => service.run({
        script_name: "proxmox-CTDEV.sh",
        phase: "execute",
      }),
      (error: unknown) => error instanceof ScriptRunnerError && error.code === "CONFIRMATION_REQUIRED"
    );
  });

  it("executes with mocked runner", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "script-runner-"));

    try {
      const fileName = "approved.sh";
      const scriptPath = path.join(tempDir, fileName);
      await writeFile(scriptPath, "#!/usr/bin/env bash\necho '{}'\n", "utf8");

      const registry = new ApprovedScriptRegistry({
        "approved.sh": {
          name: "approved.sh",
          file_name: fileName,
          required_env: [],
        },
      });

      let capturedArgs: Array<string> = [];
      const service = new ScriptRunnerService({
        scriptsRoot: tempDir,
        registry,
        execRunner: async (_filePath, args) => {
          capturedArgs = args;
          return {
            stdout: "{\"summary\":\"ok\",\"status\":\"done\"}",
            stderr: "",
          };
        },
      });

      const result = await service.run({
        script_name: "approved.sh",
        phase: "execute",
        confirmed: true,
        params: {
          vmid: 9100,
          template: "debian",
        },
      });

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.script_name, "approved.sh");
      assert(capturedArgs.includes("--phase"));
      assert(capturedArgs.includes("execute"));
      assert(capturedArgs.includes("--param"));
      assert(capturedArgs.includes("vmid=9100"));
      assert(capturedArgs.includes("template=debian"));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
