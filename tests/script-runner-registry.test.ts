import assert from "node:assert";
import { describe, it } from "node:test";
import { ApprovedScriptRegistry } from "../src/modules/script_runner/services/script-registry.ts";

describe("approved script registry", () => {
  it("contains proxmox-CTDEV.sh", () => {
    const registry = new ApprovedScriptRegistry();

    assert.strictEqual(registry.isAllowed("proxmox-CTDEV.sh"), true);
    assert(registry.listNames().includes("proxmox-CTDEV.sh"));
    assert.strictEqual(registry.get("proxmox-CTDEV.sh").file_name, "proxmox-CTDEV.sh");
  });

  it("contains proxmox-diagnose.sh", () => {
    const registry = new ApprovedScriptRegistry();

    assert.strictEqual(registry.isAllowed("proxmox-diagnose.sh"), true);
    assert(registry.listNames().includes("proxmox-diagnose.sh"));
    assert.strictEqual(registry.get("proxmox-diagnose.sh").file_name, "proxmox-diagnose.sh");
  });

  it("returns script descriptions", () => {
    const registry = new ApprovedScriptRegistry();

    const description = registry.get("proxmox-CTDEV.sh").description;
    assert.strictEqual(typeof description, "string");
    assert(description?.includes("Proxmox"));

    const diagnoseDescription = registry.get("proxmox-diagnose.sh").description;
    assert.strictEqual(typeof diagnoseDescription, "string");
    assert(diagnoseDescription?.includes("Proxmox"));
  });

  it("rejects unknown scripts", () => {
    const registry = new ApprovedScriptRegistry();

    assert.throws(() => {
      registry.get("unknown.sh");
    });
  });
});
