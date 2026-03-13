import assert from "node:assert";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
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

  it("executes with mocked runner and includes trace by default", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "script-runner-"));

    try {
      const fileName = "approved.sh";
      await writeFile(path.join(tempDir, fileName), "#!/usr/bin/env bash\necho '{}'\n", "utf8");

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
            stderr: "step 1\nstep 2",
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

      const trace = result.result.trace;
      assert(Array.isArray(trace));
      assert.deepStrictEqual(trace, ["step 1", "step 2"]);
      assert.strictEqual(result.result.live_logs_supported, true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("supports nested script paths under scripts root", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "script-runner-"));

    try {
      await mkdir(path.join(tempDir, "import"), { recursive: true });
      await writeFile(path.join(tempDir, "import", "approved.sh"), "#!/usr/bin/env bash\necho '{}'\n", "utf8");

      let capturedPath = "";
      const registry = new ApprovedScriptRegistry({
        "approved-import.sh": {
          name: "approved-import.sh",
          file_name: "import/approved.sh",
          required_env: [],
        },
      });

      const service = new ScriptRunnerService({
        scriptsRoot: tempDir,
        registry,
        execRunner: async (filePath) => {
          capturedPath = filePath;
          return {
            stdout: "{\"summary\":\"ok\"}",
            stderr: "",
          };
        },
      });

      await service.run({
        script_name: "approved-import.sh",
        phase: "collect",
      });

      assert.strictEqual(capturedPath, path.join(tempDir, "import", "approved.sh"));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("refuses parent traversal in script paths", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "script-runner-"));

    try {
      const registry = new ApprovedScriptRegistry({
        "bad.sh": {
          name: "bad.sh",
          file_name: "../bad.sh",
          required_env: [],
        },
      });

      const service = new ScriptRunnerService({
        scriptsRoot: tempDir,
        registry,
      });

      await assert.rejects(
        async () => service.run({
          script_name: "bad.sh",
          phase: "collect",
        }),
        (error: unknown) => error instanceof ScriptRunnerError && error.code === "SCRIPT_PATH_INVALID"
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("can disable verbose trace", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "script-runner-"));

    try {
      const fileName = "approved.sh";
      await writeFile(path.join(tempDir, fileName), "#!/usr/bin/env bash\necho '{}'\n", "utf8");

      const registry = new ApprovedScriptRegistry({
        "approved.sh": {
          name: "approved.sh",
          file_name: fileName,
          required_env: [],
        },
      });

      const service = new ScriptRunnerService({
        scriptsRoot: tempDir,
        registry,
        execRunner: async () => ({
          stdout: "{\"summary\":\"ok\"}",
          stderr: "hidden-trace",
        }),
      });

      const result = await service.run({
        script_name: "approved.sh",
        phase: "collect",
        verbose: false,
      });

      assert.strictEqual(result.result.trace, undefined);
      assert.strictEqual(result.result.live_logs_supported, undefined);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("supports async job polling", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "script-runner-"));

    try {
      const fileName = "approved.sh";
      await writeFile(path.join(tempDir, fileName), "#!/usr/bin/env bash\necho '{}'\n", "utf8");

      const registry = new ApprovedScriptRegistry({
        "approved.sh": {
          name: "approved.sh",
          file_name: fileName,
          required_env: [],
        },
      });

      const service = new ScriptRunnerService({
        scriptsRoot: tempDir,
        registry,
        spawnRunner: () => {
          const proc = new EventEmitter() as EventEmitter & {
            stdout: PassThrough;
            stderr: PassThrough;
            kill: () => boolean;
          };
          proc.stdout = new PassThrough();
          proc.stderr = new PassThrough();
          proc.kill = () => true;

          setTimeout(() => {
            proc.stderr.write("collecting\n");
            proc.stdout.write('{"summary":"ok","status":"done"}');
            proc.stdout.end();
            proc.stderr.end();
            proc.emit("close", 0);
          }, 10);

          return proc as unknown as import("node:child_process").ChildProcess;
        },
      });

      const started = await service.startAsyncJob({
        script_name: "approved.sh",
        phase: "collect",
      });

      assert.strictEqual(started.status, "running");

      await new Promise((resolve) => setTimeout(resolve, 30));

      const poll = service.getAsyncJob({
        job_id: started.job_id,
        offset: 0,
        limit: 50,
      });

      assert.strictEqual(poll.ok, true);
      const job = poll.job as {
        status?: string;
        completed?: boolean;
        logs?: Array<string>;
        result?: Record<string, unknown> | null;
      };
      assert.strictEqual(job.status, "completed");
      assert.strictEqual(job.completed, true);
      assert.deepStrictEqual(job.logs, ["collecting"]);
      assert.strictEqual((job.result ?? {}).summary, "ok");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
