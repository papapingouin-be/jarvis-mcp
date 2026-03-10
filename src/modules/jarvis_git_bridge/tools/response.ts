import { JarvisGitBridgeError, asSafeError } from "../services/errors.js";

export function toToolSuccess<TData extends object>(data: TData): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{
      type: "text",
      text: JSON.stringify(data),
    }],
  };
}

export function toToolError(error: unknown): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
  const safeError = error instanceof JarvisGitBridgeError ? error : asSafeError(error);

  return {
    isError: true,
    content: [{
      type: "text",
      text: JSON.stringify({
        ok: false,
        error: {
          code: safeError.code,
          message: safeError.safeMessage,
        },
      }),
    }],
  };
}


