import { randomUUID } from "node:crypto";

export const MCP_SESSION_HEADER = "Mcp-Session-Id";
export const MCP_SESSION_HEADER_LOWER = "x-mcp-session-id";

export function resolveSessionId(headers: Record<string, string | string[] | undefined>): {
  sessionId: string;
  source: "existing" | "generated";
} {
  const fromCanonical = headers[MCP_SESSION_HEADER] ?? headers[MCP_SESSION_HEADER.toLowerCase()];
  const fromLower = headers[MCP_SESSION_HEADER_LOWER];

  const candidates = [fromCanonical, fromLower]
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .map((value) => (value ?? "").trim())
    .filter(Boolean);

  if (candidates.length > 0 && candidates[0] !== undefined) {
    return { sessionId: candidates[0], source: "existing" };
  }

  return { sessionId: randomUUID(), source: "generated" };
}
