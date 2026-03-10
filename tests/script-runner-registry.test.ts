import assert from "node:assert";
import { describe, it } from "node:test";
import { ApprovedScriptRegistry } from "../src/modules/script_runner/services/script-registry.ts";

describe("approved script registry", () => {
  it("contains proxmox-CTDEV.sh", () => {
    const registry = new ApprovedScriptRegistry();

    assert.strictEqual(registry.isAllowed("proxmox-CTDEV.sh"), true);
    assert(registry.listNames().includes("proxmox-CTDEV.sh"));
  });

  it("rejects unknown scripts", () => {
    const registry = new ApprovedScriptRegistry();

    assert.throws(() => {
      registry.get("unknown.sh");
    });
  });
});
