import type { JarvisRunScriptInput } from "./schemas.js";

export type ScriptPhase = JarvisRunScriptInput["phase"];

export type ScriptRunSuccess = {
  ok: true;
  script_name: string;
  phase: ScriptPhase;
  result: Record<string, unknown>;
};

export type ScriptDefinition = {
  name: string;
  file_name: string;
  required_env: Array<string>;
};

export type ScriptRegistry = Record<string, ScriptDefinition>;
