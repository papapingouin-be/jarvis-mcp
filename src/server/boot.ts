import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { RequestHandler } from "express";
import cors from "cors";
import express, { type Express, type Request, type Response } from "express";
import { loadServerConfig } from "../config/service.js";
import { SERVER_NAME, SERVER_VERSION, type TransportMode } from "../config/env.js";
import { autoRegisterModules } from "../registry/auto-loader.js";
import {
  createRequestContext,
  extractClientIp,
  instrumentServerTools,
  isVerboseHttpRequest,
  logDiagnostic,
  recordDiagnosticEvent,
  setCurrentSessionId,
  withRequestContext,
} from "./diagnostics.js";
import { setRuntimeState } from "./runtime-state.js";
import { MCP_SESSION_HEADER, MCP_SESSION_HEADER_LOWER } from "./session.js";

type SessionContext = { server: McpServer; transport: StreamableHTTPServerTransport };
type SessionContextMap = Map<string, SessionContext>;

const MCP_PROTOCOL_HEADER = "MCP-Protocol-Version";

export function createApp(corsOrigin: string): Express {
  const app = express();

  app.use(express.json({ limit: "1mb" }));
  app.use(
    cors({
      origin: corsOrigin,
      credentials: true,
      methods: ["GET", "POST", "OPTIONS", "DELETE"],
      allowedHeaders: [
        "Content-Type",
        MCP_PROTOCOL_HEADER,
        MCP_SESSION_HEADER,
        MCP_SESSION_HEADER_LOWER,
        "x-mcp-session",
        "x-jarvis-verbose",
        "x-openwebui-verbose",
      ],
      exposedHeaders: [MCP_SESSION_HEADER, MCP_SESSION_HEADER_LOWER],
    }),
  );

  return app;
}

async function createRegisteredServer(): Promise<{ server: McpServer; registeredTools: string[] }> {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  instrumentServerTools(server);

  const registrationResults = await autoRegisterModules(server);
  const registeredTools = registrationResults
    .filter((result) => result.success && result.type === "tool")
    .map((result) => result.name);

  logDiagnostic("info", "MCP server modules registered", {
    tool_count: registeredTools.length,
    tools: registeredTools,
  });

  return { server, registeredTools };
}

export function createTransport(): StreamableHTTPServerTransport {
  return new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
}

export function sessionMiddleware(): RequestHandler {
  return (req, res, next) => {
    const originalSetHeader = res.setHeader.bind(res);

    res.setHeader = (name: string, value: string | number | readonly string[]) => {
      originalSetHeader(name, value);

      const lower = name.toLowerCase();
      if (lower === MCP_SESSION_HEADER.toLowerCase()) {
        originalSetHeader(MCP_SESSION_HEADER_LOWER, value);
      } else if (lower === MCP_SESSION_HEADER_LOWER) {
        originalSetHeader(MCP_SESSION_HEADER, value);
      }

      return res;
    };

    const incomingSessionId = getSessionIdFromRequest(req);
    if (incomingSessionId) {
      req.headers[MCP_SESSION_HEADER.toLowerCase()] = incomingSessionId;
      req.headers[MCP_SESSION_HEADER_LOWER] = incomingSessionId;
    }

    next();
  };
}

function getSessionIdFromRequest(req: Request): string | undefined {
  const raw = req.header(MCP_SESSION_HEADER) ?? req.header(MCP_SESSION_HEADER_LOWER) ?? req.header("x-mcp-session");
  const sessionId = raw?.trim();
  return sessionId ? sessionId : undefined;
}

function getSessionIdFromResponse(res: Response): string | undefined {
  const canonical = res.getHeader(MCP_SESSION_HEADER);
  const lower = res.getHeader(MCP_SESSION_HEADER_LOWER);
  const value = canonical ?? lower;

  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }

  if (Array.isArray(value) && value.length > 0) {
    const first = String(value[0] ?? "").trim();
    return first ? first : undefined;
  }

  return undefined;
}

function isInitializeRequest(req: Request): boolean {
  return req.method === "POST" && req.body?.method === "initialize";
}

function isInitializedNotification(req: Request): boolean {
  return req.method === "POST" && req.body?.method === "notifications/initialized";
}

function sendJsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function summarizeParams(method: string | undefined, params: unknown): Record<string, unknown> | undefined {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }

  const payload = params as Record<string, unknown>;

  switch (method) {
    case "tools/call":
      return {
        tool_name: payload.name ?? null,
        arguments: payload.arguments ?? null,
      };
    case "resources/read":
      return {
        uri: payload.uri ?? null,
      };
    case "prompts/get":
      return {
        prompt_name: payload.name ?? null,
        arguments: payload.arguments ?? null,
      };
    case "initialize":
      return {
        client_info: payload.clientInfo ?? null,
        capabilities: payload.capabilities ?? null,
      };
    default:
      return payload;
  }
}

function buildRequestDetails(req: Request): Record<string, unknown> {
  const body = req.body as { id?: unknown; method?: unknown; params?: unknown } | undefined;
  const mcpMethod = typeof body?.method === "string" ? body.method : undefined;
  const isSseStream = req.method === "GET";

  return {
    http_method: req.method,
    path: req.path,
    request_kind: isSseStream ? "sse_stream" : "rpc_call",
    request_purpose: isSseStream
      ? "Open MCP SSE stream for server notifications and responses"
      : "Handle MCP JSON-RPC request",
    mcp_method: mcpMethod ?? (isSseStream ? "sse/connect" : undefined),
    body_id: body?.id,
    params_preview: summarizeParams(mcpMethod, body?.params),
    verbose: isVerboseHttpRequest(req),
  };
}

function getExistingSession(
  req: Request,
  res: Response,
  sessions: SessionContextMap,
): SessionContext | undefined {
  const sessionId = getSessionIdFromRequest(req);
  if (!sessionId) {
    return undefined;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    logDiagnostic("warn", "MCP session not found", { session_id: sessionId, method: req.method });
    sendJsonRpcError(res, 404, -32001, "Session not found");
    return undefined;
  }

  recordDiagnosticEvent("session.reused", "Request matched existing session", {
    session_id: sessionId,
    method: req.method,
  });
  return session;
}

async function handleInitialize(req: Request, res: Response, sessions: SessionContextMap): Promise<void> {
  const providedSessionId = getSessionIdFromRequest(req);
  if (providedSessionId) {
    sendJsonRpcError(res, 400, -32600, "Initialize must not provide a session id");
    return;
  }

  recordDiagnosticEvent("session.initialize", "Initialize request received", {
    client_info: req.body?.params?.clientInfo,
  });

  const transport = createTransport();
  const { server } = await createRegisteredServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);

  const sessionId = getSessionIdFromResponse(res);
  if (!sessionId) {
    logDiagnostic("warn", "Initialize response missing session id header");
    await transport.close();
    return;
  }

  sessions.set(sessionId, { server, transport });
  setCurrentSessionId(sessionId);
  recordDiagnosticEvent("session.created", "MCP session created", { session_id: sessionId });
  logDiagnostic("info", "MCP session created", { session_id: sessionId });
}

async function handleSessionDelete(req: Request, res: Response, sessions: SessionContextMap): Promise<void> {
  const sessionId = getSessionIdFromRequest(req);
  if (!sessionId) {
    sendJsonRpcError(res, 400, -32600, "Session id header is required");
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    logDiagnostic("warn", "Delete requested for unknown session", { session_id: sessionId });
    sendJsonRpcError(res, 404, -32001, "Session not found");
    return;
  }

  await session.transport.handleRequest(req, res, req.body);
  sessions.delete(sessionId);
  await session.transport.close();
  recordDiagnosticEvent("session.closed", "MCP session closed", { session_id: sessionId });
  logDiagnostic("info", "MCP session closed", { session_id: sessionId });
}

async function runHttpRequestWithDiagnostics(
  req: Request,
  res: Response,
  handler: () => Promise<void>,
): Promise<void> {
  const context = createRequestContext({
    transport: "http",
    sessionId: getSessionIdFromRequest(req),
    ip: extractClientIp(req),
    verbose: isVerboseHttpRequest(req),
  });

  await withRequestContext(context, async () => {
    const startedAt = Date.now();
    const requestDetails = buildRequestDetails(req);

    recordDiagnosticEvent("request.received", "Incoming MCP HTTP request", requestDetails);
    logDiagnostic("info", "Incoming MCP HTTP request", requestDetails);

    try {
      await handler();
    } finally {
      const durationMs = Date.now() - startedAt;
      const completionDetails = {
        ...requestDetails,
        status_code: res.statusCode,
        duration_ms: durationMs,
      };

      recordDiagnosticEvent("request.completed", "MCP HTTP request completed", completionDetails);
      logDiagnostic("info", "MCP HTTP request completed", completionDetails);
    }
  });
}

export async function boot(mode?: TransportMode): Promise<void> {
  const runtimeConfig = await loadServerConfig();
  const transportMode = mode ?? runtimeConfig.transportMode;

  const bootstrap = await createRegisteredServer();
  setRuntimeState({
    transport: transportMode,
    tools: bootstrap.registeredTools,
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    startedAt: Date.now(),
  });

  logDiagnostic("info", "MCP server booting", {
    transport: transportMode,
    verbose_mode: runtimeConfig.verboseMode,
    log_file_path: runtimeConfig.logFilePath,
    recent_event_limit: runtimeConfig.recentEventLimit,
  });

  if (transportMode === "stdio") {
    const transport = new StdioServerTransport();
    await bootstrap.server.connect(transport);
    logDiagnostic("info", "MCP stdio server running", { transport: "stdio" });
    console.error("[mcp/stdio] server running on stdio");
    return;
  }

  const sessions: SessionContextMap = new Map();
  const corsOrigin = runtimeConfig.corsOrigin;
  const app = createApp(corsOrigin);

  app.use("/mcp", sessionMiddleware());

  app.post("/mcp", async (req, res) => {
    await runHttpRequestWithDiagnostics(req, res, async () => {
      try {
        if (isInitializeRequest(req)) {
          await handleInitialize(req, res, sessions);
          return;
        }

        if (isInitializedNotification(req)) {
          recordDiagnosticEvent("session.initialized", "Initialized notification received", {
            session_id: getSessionIdFromRequest(req),
          });
        }

        const session = getExistingSession(req, res, sessions);
        if (!session) {
          if (!res.headersSent) {
            sendJsonRpcError(res, 400, -32600, "Session id header is required");
          }
          return;
        }

        await session.transport.handleRequest(req, res, req.body);
      } catch (error) {
        logDiagnostic("error", "MCP HTTP POST handler error", { error });
        if (!res.headersSent) {
          sendJsonRpcError(res, 500, -32603, "Internal error");
        }
      }
    });
  });

  app.get("/mcp", async (req, res) => {
    await runHttpRequestWithDiagnostics(req, res, async () => {
      try {
        const session = getExistingSession(req, res, sessions);
        if (!session) {
          if (!res.headersSent) {
            sendJsonRpcError(res, 400, -32000, "SSE stream requires an initialized MCP session. Call initialize first.");
          }
          return;
        }

        await session.transport.handleRequest(req, res);
      } catch (error) {
        logDiagnostic("error", "MCP HTTP GET handler error", { error });
        if (!res.headersSent) {
          sendJsonRpcError(res, 500, -32603, "Internal error");
        }
      }
    });
  });

  app.delete("/mcp", async (req, res) => {
    await runHttpRequestWithDiagnostics(req, res, async () => {
      try {
        await handleSessionDelete(req, res, sessions);
      } catch (error) {
        logDiagnostic("error", "MCP HTTP DELETE handler error", { error });
        if (!res.headersSent) {
          sendJsonRpcError(res, 500, -32603, "Internal error");
        }
      }
    });
  });

  const port = runtimeConfig.port;
  const httpServer = app.listen(port, () => {
    logDiagnostic("info", "MCP HTTP server listening", {
      url: `http://localhost:${String(port)}/mcp`,
      cors_origin: corsOrigin,
    });
    console.log(`[mcp/http] listening on http://localhost:${String(port)}/mcp`);
    console.log(`[mcp/http] cors origin: ${corsOrigin}`);
  });

  process.on("SIGINT", () => {
    logDiagnostic("info", "MCP HTTP server shutting down", { open_sessions: sessions.size });
    const closing = Array.from(sessions.values()).map((session) => session.transport.close());
    void Promise.allSettled(closing).finally(() => {
      httpServer.close(() => {
        process.exit(0);
      });
    });
  });
}