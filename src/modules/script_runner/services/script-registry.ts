import type { ScriptDefinition, ScriptRegistry } from "../types/domain.js";
import { ScriptRunnerError } from "./errors.js";

const DEFAULT_REGISTRY: ScriptRegistry = {
  "proxmox-CTDEV.sh": {
    name: "proxmox-CTDEV.sh",
    file_name: "proxmox-CTDEV.sh",
    required_env: [
      "PROXMOX_HOST",
      "PROXMOX_WEB",
      "PROXMOX_SSH_PORT",
      "PROXMOX_USER",
      "PROXMOX_PASSWORD",
      "PROXMOX_API_TOKEN_ID",
      "PROXMOX_API_TOKEN_SECRET",
    ],
  },
};

export class ApprovedScriptRegistry {
  private readonly registry: ScriptRegistry;

  constructor(registry: ScriptRegistry = DEFAULT_REGISTRY) {
    this.registry = registry;
  }

  isAllowed(scriptName: string): boolean {
    return this.registry[scriptName] !== undefined;
  }

  get(scriptName: string): ScriptDefinition {
    const definition = this.registry[scriptName];
    if (definition === undefined) {
      throw new ScriptRunnerError("SCRIPT_NOT_ALLOWED", "Script is not in the approved allowlist");
    }

    return definition;
  }

  listNames(): Array<string> {
    return Object.keys(this.registry).sort();
  }
}
