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

  const registrationResults = await autoRegisterModules(server);
  const registeredTools = registrationResults
    .filter((result) => result.success && result.type === "tool")
    .map((result) => result.name);

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
    console.log(`[mcp/http] session not found sid=${sessionId}`);
    sendJsonRpcError(res, 404, -32001, "Session not found");
    return undefined;
  }

  console.log(`[mcp/http] request on existing session sid=${sessionId} method=${req.method}`);
  return session;
}

async function handleInitialize(req: Request, res: Response, sessions: SessionContextMap): Promise<void> {
  const providedSessionId = getSessionIdFromRequest(req);
  if (providedSessionId) {
    sendJsonRpcError(res, 400, -32600, "Initialize must not provide a session id");
    return;
  }

  console.log("[mcp/http] initialize request received");

  const transport = createTransport();
  const { server } = await createRegisteredServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);

  const sessionId = getSessionIdFromResponse(res);
  if (!sessionId) {
    console.log("[mcp/http] initialize response missing session id header");
    await transport.close();
    return;
  }

  sessions.set(sessionId, { server, transport });
  console.log(`[mcp/http] session created sid=${sessionId}`);
}

async function handleSessionDelete(req: Request, res: Response, sessions: SessionContextMap): Promise<void> {
  const sessionId = getSessionIdFromRequest(req);
  if (!sessionId) {
    sendJsonRpcError(res, 400, -32600, "Session id header is required");
    return;
  }

  const session = sessions.get(sessionId);
  if (!session) {
    console.log(`[mcp/http] delete requested for unknown session sid=${sessionId}`);
    sendJsonRpcError(res, 404, -32001, "Session not found");
    return;
  }

  await session.transport.handleRequest(req, res, req.body);
  sessions.delete(sessionId);
  await session.transport.close();
  console.log(`[mcp/http] session closed sid=${sessionId}`);
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

  if (transportMode === "stdio") {
    const transport = new StdioServerTransport();
    await bootstrap.server.connect(transport);
    console.error("[mcp/stdio] server running on stdio");
    return;
  }

  const sessions: SessionContextMap = new Map();
  const corsOrigin = runtimeConfig.corsOrigin;
  const app = createApp(corsOrigin);

  app.use("/mcp", sessionMiddleware());

  app.post("/mcp", async (req, res) => {
    try {
      if (isInitializeRequest(req)) {
        await handleInitialize(req, res, sessions);
        return;
      }

      if (isInitializedNotification(req)) {
        console.log("[mcp/http] initialized notification received");
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
      console.error("[mcp/http] POST handler error:", error);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal error");
      }
    }
  });

  app.get("/mcp", async (req, res) => {
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
      console.error("[mcp/http] GET handler error:", error);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal error");
      }
    }
  });

  app.delete("/mcp", async (req, res) => {
    try {
      await handleSessionDelete(req, res, sessions);
    } catch (error) {
      console.error("[mcp/http] DELETE handler error:", error);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal error");
      }
    }
  });

  const port = runtimeConfig.port;
  const httpServer = app.listen(port, () => {
    console.log(`[mcp/http] listening on http://localhost:${String(port)}/mcp`);
    console.log(`[mcp/http] cors origin: ${corsOrigin}`);
  });

  process.on("SIGINT", () => {
    console.log("[mcp/http] shutting down...");
    const closing = Array.from(sessions.values()).map((session) => session.transport.close());
    void Promise.allSettled(closing).finally(() => {
      httpServer.close(() => {
        process.exit(0);
      });
    });
  });
}
