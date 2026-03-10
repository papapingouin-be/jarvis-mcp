export class ScriptRunnerError extends Error {
  public readonly code: string;
  public readonly safeMessage: string;

  constructor(code: string, safeMessage: string) {
    super(safeMessage);
    this.code = code;
    this.safeMessage = safeMessage;
    this.name = "ScriptRunnerError";
  }
}

export function asScriptRunnerError(error: unknown): ScriptRunnerError {
  if (error instanceof ScriptRunnerError) {
    return error;
  }

  return new ScriptRunnerError("SCRIPT_RUNNER_INTERNAL", "Internal script runner error");
}
