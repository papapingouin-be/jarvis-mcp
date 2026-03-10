export class JarvisGitBridgeError extends Error {
  public readonly code: string;
  public readonly safeMessage: string;

  constructor(code: string, safeMessage: string) {
    super(safeMessage);
    this.code = code;
    this.safeMessage = safeMessage;
    this.name = "JarvisGitBridgeError";
  }
}

export function asSafeError(error: unknown): JarvisGitBridgeError {
  if (error instanceof JarvisGitBridgeError) {
    return error;
  }

  return new JarvisGitBridgeError("INTERNAL_ERROR", "Internal error");
}
