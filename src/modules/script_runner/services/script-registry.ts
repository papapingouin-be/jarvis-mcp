import type { ScriptDefinition, ScriptRegistry } from "../types/domain.js";
import { ScriptRunnerError } from "./errors.js";
import { loadConfiguredScriptRegistry } from "../../../config/service.js";
import { getDefaultApprovedScripts } from "../../../config/env.js";

export type ScriptRegistryProvider = {
  isAllowed: (scriptName: string) => boolean | Promise<boolean>;
  get: (scriptName: string) => ScriptDefinition | Promise<ScriptDefinition>;
  listNames: () => Array<string> | Promise<Array<string>>;
};

export class ApprovedScriptRegistry implements ScriptRegistryProvider {
  private readonly registry: ScriptRegistry;

  constructor(registry: ScriptRegistry = getDefaultApprovedScripts()) {
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

export class ConfiguredScriptRegistry implements ScriptRegistryProvider {
  private readonly fallback: ApprovedScriptRegistry;
  private registryPromise: Promise<ApprovedScriptRegistry> | null;

  constructor(fallback: ScriptRegistry = getDefaultApprovedScripts()) {
    this.fallback = new ApprovedScriptRegistry(fallback);
    this.registryPromise = null;
  }

  private async loadRegistry(): Promise<ApprovedScriptRegistry> {
    if (this.registryPromise === null) {
      this.registryPromise = loadConfiguredScriptRegistry()
        .then((registry) => new ApprovedScriptRegistry(registry))
        .catch(() => this.fallback);
    }

    return this.registryPromise;
  }

  async isAllowed(scriptName: string): Promise<boolean> {
    const registry = await this.loadRegistry();
    return registry.isAllowed(scriptName);
  }

  async get(scriptName: string): Promise<ScriptDefinition> {
    const registry = await this.loadRegistry();
    return registry.get(scriptName);
  }

  async listNames(): Promise<Array<string>> {
    const registry = await this.loadRegistry();
    return registry.listNames();
  }
}
