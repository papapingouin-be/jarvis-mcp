import assert from "node:assert";
import { describe, it } from "node:test";
import { ApprovedScriptRegistry } from "../src/modules/script_runner/services/script-registry.ts";

describe("approved script registry", () => {
  it("contains proxmox-diagnose.sh", () => {
    const registry = new ApprovedScriptRegistry();

    assert.strictEqual(registry.isAllowed("proxmox-diagnose.sh"), true);
    assert(registry.listNames().includes("proxmox-diagnose.sh"));
    assert.strictEqual(registry.get("proxmox-diagnose.sh").file_name, "proxmox-diagnose.sh");
  });

  it("contains jarvis_sync_build_redeploy.sh", () => {
    const registry = new ApprovedScriptRegistry();

    assert.strictEqual(registry.isAllowed("jarvis_sync_build_redeploy.sh"), true);
    assert(registry.listNames().includes("jarvis_sync_build_redeploy.sh"));
    assert.strictEqual(registry.get("jarvis_sync_build_redeploy.sh").file_name, "jarvis_sync_build_redeploy.sh");
    assert.strictEqual(registry.get("jarvis_sync_build_redeploy.sh").version, "1.4.1");
  });

  it("returns script descriptions", () => {
    const registry = new ApprovedScriptRegistry();

    const diagnoseDescription = registry.get("proxmox-diagnose.sh").description;
    assert.strictEqual(typeof diagnoseDescription, "string");
    assert(diagnoseDescription?.includes("Proxmox"));

    const redeployDescription = registry.get("jarvis_sync_build_redeploy.sh").description;
    assert.strictEqual(typeof redeployDescription, "string");
    assert(redeployDescription?.includes("deploy"));
  });

  it("rejects unknown scripts", () => {
    const registry = new ApprovedScriptRegistry();

    assert.throws(() => {
      registry.get("unknown.sh");
    });
  });
});
