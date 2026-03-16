import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, appendFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getServerEnvConfig, type TransportMode } from "../config/env.js";

type LogLevel = "debug" | "info" | "warn" | "error";

type ToolResultContent = {
  type: string;
  text?: string;
};

type ToolResult = {
  content?: Array<ToolResultContent>;
  isError?: boolean;
};

export type DiagnosticEvent = {
  timestamp: string;
  kind: string;
  message: string;
  requestId: string;
  sessionId?: string;
  ip?: string;
  transport: TransportMode;
  data?: Record<string, unknown>;
};

export type RequestContext = {
  requestId: string;
  sessionId?: string;
  ip?: string;
  transport: TransportMode;
  verbose: boolean;
  startedAt: number;
  events: Array<DiagnosticEvent>;
};

type DiagnosticSummary = {
  request_id: string;
  session_id: string | null;
  ip: string | null;
  transport: TransportMode;
  tool: string;
  duration_ms: number;
  events: Array<DiagnosticEvent>;
};

type ToolHandler = (...args: Array<any>) => unknown;

const requestContextStorage = new AsyncLocalStorage<RequestContext>();
const recentEvents: Array<DiagnosticEvent> = [];
const toolInstrumentationMarker = Symbol.for("jarvis.mcp.toolInstrumentation");

function retainRecentEvents(): number {
  return Math.max(10, getServerEnvConfig().recentEventLimit);
}

function getLogFilePath(): string {
  return getServerEnvConfig().logFilePath;
}

function isSensitiveKey(key: string): boolean {
  return /(password|secret|token|authorization|api[_-]?key|master[_-]?key)/i.test(key);
}

export function sanitizeForLogs(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForLogs(entry));
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [
        key,
        isSensitiveKey(key) ? "***" : sanitizeForLogs(entryValue),
      ])
    );
  }

  return value;
}

async function appendLogLine(serializedLine: string): Promise<void> {
  const logFilePath = getLogFilePath();
  await mkdir(path.dirname(logFilePath), { recursive: true });
  await appendFile(logFilePath, `${serializedLine}\n`, "utf8");
}

function pushRecentEvent(event: DiagnosticEvent): void {
  recentEvents.push(event);

  const overflow = recentEvents.length - retainRecentEvents();
  if (overflow > 0) {
    recentEvents.splice(0, overflow);
  }
}

function serializeLogLine(level: LogLevel, message: string, context?: RequestContext, data?: Record<string, unknown>): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    requestId: context?.requestId ?? null,
    sessionId: context?.sessionId ?? null,
    ip: context?.ip ?? null,
    transport: context?.transport ?? null,
    data: data === undefined ? undefined : sanitizeForLogs(data),
  });
}

export function logDiagnostic(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  const context = requestContextStorage.getStore();
  const serializedLine = serializeLogLine(level, message, context, data);

  if (level === "error") {
    console.error(serializedLine);
  } else {
    console.log(serializedLine);
  }

  void appendLogLine(serializedLine).catch((error: unknown) => {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      message: "Failed to write MCP diagnostic log",
      data: sanitizeForLogs(error),
    }));
  });
}

export function createRequestContext(params: {
  transport: TransportMode;
  sessionId?: string;
  ip?: string;
  verbose?: boolean;
}): RequestContext {
  return {
    requestId: randomUUID(),
    sessionId: params.sessionId,
    ip: params.ip,
    transport: params.transport,
    verbose: params.verbose ?? getServerEnvConfig().verboseMode,
    startedAt: Date.now(),
    events: [],
  };
}

export function withRequestContext<TValue>(
  context: RequestContext,
  work: () => Promise<TValue> | TValue,
): Promise<TValue> | TValue {
  return requestContextStorage.run(context, work);
}

export function getCurrentRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

export function setCurrentSessionId(sessionId: string): void {
  const context = requestContextStorage.getStore();
  if (context !== undefined) {
    context.sessionId = sessionId;
  }
}

export function recordDiagnosticEvent(
  kind: string,
  message: string,
  data?: Record<string, unknown>,
): DiagnosticEvent | undefined {
  const context = requestContextStorage.getStore();
  if (context === undefined) {
    return undefined;
  }

  const event: DiagnosticEvent = {
    timestamp: new Date().toISOString(),
    kind,
    message,
    requestId: context.requestId,
    sessionId: context.sessionId,
    ip: context.ip,
    transport: context.transport,
    data: data === undefined ? undefined : sanitizeForLogs(data) as Record<string, unknown>,
  };

  context.events.push(event);
  pushRecentEvent(event);
  return event;
}

export function getRecentDiagnosticEvents(limit = 20): Array<DiagnosticEvent> {
  return recentEvents.slice(-Math.max(1, limit));
}

export function getDiagnosticsRuntimeConfig(): {
  logFilePath: string;
  verboseMode: boolean;
  recentEventLimit: number;
} {
  const config = getServerEnvConfig();
  return {
    logFilePath: config.logFilePath,
    verboseMode: config.verboseMode,
    recentEventLimit: config.recentEventLimit,
  };
}

export function isVerboseHttpRequest(req: Request): boolean {
  const explicitHeader = req.header("x-jarvis-verbose") ?? req.header("x-openwebui-verbose");
  const explicitQuery = typeof req.query.verbose === "string" ? req.query.verbose : undefined;
  const config = getServerEnvConfig();

  const normalized = (explicitHeader ?? explicitQuery)?.trim().toLowerCase();
  if (normalized !== undefined) {
    return ["1", "true", "yes", "on"].includes(normalized);
  }

  return config.verboseMode;
}

export function extractClientIp(req: Request): string | undefined {
  const forwardedFor = req.header("x-forwarded-for");
  if (typeof forwardedFor === "string" && forwardedFor.trim().length > 0) {
    return forwardedFor.split(",")[0]?.trim();
  }

  const realIp = req.header("x-real-ip")?.trim();
  if (realIp) {
    return realIp;
  }

  return req.ip || req.socket.remoteAddress || undefined;
}

function summarizeContextForTool(toolName: string, durationMs: number, context: RequestContext): DiagnosticSummary {
  return {
    request_id: context.requestId,
    session_id: context.sessionId ?? null,
    ip: context.ip ?? null,
    transport: context.transport,
    tool: toolName,
    duration_ms: durationMs,
    events: context.events.slice(),
  };
}

export function decorateToolResultWithDiagnostics(
  result: ToolResult,
  toolName: string,
  durationMs: number,
): ToolResult {
  const context = requestContextStorage.getStore();
  if (context === undefined || !context.verbose) {
    return result;
  }

  const diagnosticSummary = summarizeContextForTool(toolName, durationMs, context);
  const diagnosticBlock = JSON.stringify({ _mcp_debug: diagnosticSummary }, null, 2);

  if (!Array.isArray(result.content) || result.content.length === 0) {
    return {
      ...result,
      content: [{ type: "text", text: diagnosticBlock }],
    };
  }

  const firstItem = result.content[0];
  if (firstItem?.type === "text" && typeof firstItem.text === "string") {
    try {
      const parsed = JSON.parse(firstItem.text) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return {
          ...result,
          content: [
            {
              ...firstItem,
              text: JSON.stringify({ ...parsed, _mcp_debug: diagnosticSummary }, null, 2),
            },
            ...result.content.slice(1),
          ],
        };
      }
    } catch {
    }
  }

  return {
    ...result,
    content: [...result.content, { type: "text", text: diagnosticBlock }],
  };
}

function ensureRequestContext(verboseFallback: boolean, work: () => Promise<unknown>): Promise<unknown> {
  const currentContext = requestContextStorage.getStore();
  if (currentContext !== undefined) {
    return work();
  }

  const detachedContext = createRequestContext({
    transport: "stdio",
    verbose: verboseFallback,
  });

  return Promise.resolve(withRequestContext(detachedContext, work));
}

export function instrumentServerTools(server: McpServer): void {
  const instrumentedServer = server as McpServer & Record<PropertyKey, unknown>;

  if (instrumentedServer[toolInstrumentationMarker] === true) {
    return;
  }

  const originalTool = server.tool.bind(server) as (...toolArgs: Array<any>) => unknown;

  const patchedTool = ((...toolArgs: Array<any>) => {
    const maybeHandler = toolArgs.at(-1);
    if (typeof maybeHandler !== "function") {
      return originalTool(...toolArgs);
    }

    const toolName = typeof toolArgs[0] === "string" ? toolArgs[0] : "unknown";
    const wrappedHandler: ToolHandler = async (...args: Array<any>) => {
      const verboseFallback = getServerEnvConfig().verboseMode;

      return ensureRequestContext(verboseFallback, async () => {
        const startedAt = Date.now();
        const input = args[0] as Record<string, unknown> | undefined;
        recordDiagnosticEvent("tool.start", `Tool ${toolName} started`, { tool: toolName, args: input });
        logDiagnostic("info", "MCP tool started", { tool: toolName, args: input });

        try {
          const result = await Promise.resolve(maybeHandler(...args));
          const durationMs = Date.now() - startedAt;
          recordDiagnosticEvent("tool.success", `Tool ${toolName} completed`, { tool: toolName, duration_ms: durationMs });
          logDiagnostic("info", "MCP tool completed", { tool: toolName, duration_ms: durationMs });
          return decorateToolResultWithDiagnostics(result as ToolResult, toolName, durationMs);
        } catch (error: unknown) {
          const durationMs = Date.now() - startedAt;
          recordDiagnosticEvent("tool.error", `Tool ${toolName} failed`, {
            tool: toolName,
            duration_ms: durationMs,
            error,
          });
          logDiagnostic("error", "MCP tool failed", {
            tool: toolName,
            duration_ms: durationMs,
            error,
          });
          throw error;
        }
      });
    };

    const forwardedArgs = [...toolArgs];
    forwardedArgs[forwardedArgs.length - 1] = wrappedHandler;
    return originalTool(...forwardedArgs);
  }) as unknown as McpServer["tool"];

  (server as unknown as { tool: unknown }).tool = patchedTool;

  instrumentedServer[toolInstrumentationMarker] = true;
}