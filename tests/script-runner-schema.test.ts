import assert from "node:assert";
import { describe, it } from "node:test";
import { jarvisRunScriptInputSchema } from "../src/modules/script_runner/types/schemas.ts";

describe("jarvis_run_script input schema", () => {
  it("accepts collect payload", () => {
    const result = jarvisRunScriptInputSchema.safeParse({
      script_name: "proxmox-diagnose.sh",
      phase: "collect",
    });

    assert.strictEqual(result.success, true);
  });

  it("accepts verbose flag", () => {
    const result = jarvisRunScriptInputSchema.safeParse({
      script_name: "proxmox-diagnose.sh",
      phase: "collect",
      verbose: true,
    });

    assert.strictEqual(result.success, true);
  });

  it("rejects invalid phase", () => {
    const result = jarvisRunScriptInputSchema.safeParse({
      script_name: "proxmox-diagnose.sh",
      phase: "dryrun",
    });

    assert.strictEqual(result.success, false);
  });
});
