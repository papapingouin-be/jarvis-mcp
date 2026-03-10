export class ScriptRunnerError extends Error {
  public readonly code: string;
  public readonly safeMessage: string;
  public readonly context?: Record<string, unknown>;

  constructor(code: string, safeMessage: string, context?: Record<string, unknown>) {
    super(safeMessage);
    this.code = code;
    this.safeMessage = safeMessage;
    this.context = context;
    this.name = "ScriptRunnerError";
  }
}

export function asScriptRunnerError(error: unknown): ScriptRunnerError {
  if (error instanceof ScriptRunnerError) {
    return error;
  }

  return new ScriptRunnerError("SCRIPT_RUNNER_INTERNAL", "Internal script runner error");
}
