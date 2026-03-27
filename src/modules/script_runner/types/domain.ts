import type { JarvisRunScriptInput } from "./schemas.js";

export type ScriptPhase = JarvisRunScriptInput["phase"];

export type ScriptEnvDefinition = string | {
  name: string;
  required?: boolean;
  secret?: boolean;
  description?: string;
};

export type ScriptRunSuccess = {
  ok: true;
  script_name: string;
  phase: ScriptPhase;
  result: Record<string, unknown>;
};

export type ScriptDefinition = {
  name: string;
  file_name: string;
  required_env: Array<ScriptEnvDefinition>;
  description?: string;
};

export type ScriptRegistry = Record<string, ScriptDefinition>;
