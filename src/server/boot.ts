import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { RequestHandler } from "express";
import cors from "cors";
import { config } from "dotenv";
import express, { type Express, type Request, type Response } from "express";
import { autoRegisterModules } from "../registry/auto-loader.js";
import { setRuntimeState } from "./runtime-state.js";
import {
  MCP_SESSION_HEADER,
  MCP_SESSION_HEADER_LOWER,
} from "./session.js";

type TransportMode = "stdio" | "http";

config();

const SERVER_NAME = "mcp-server-starter";
const SERVER_VERSION = "1.0.2";

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
        MCP_SESSION_HEADER,
        MCP_SESSION_HEADER_LOWER,
        "x-mcp-session",
      ],
      exposedHeaders: [MCP_SESSION_HEADER, MCP_SESSION_HEADER_LOWER],
    }),
  );

  return app;
}

export function createTransport(): StreamableHTTPServerTransport {
  return new StreamableHTTPServerTransport();
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

    const incomingSessionId =
      req.header(MCP_SESSION_HEADER) ??
      req.header(MCP_SESSION_HEADER_LOWER) ??
      req.header("x-mcp-session");

    if (incomingSessionId) {
      req.headers[MCP_SESSION_HEADER.toLowerCase()] = incomingSessionId;
      req.headers[MCP_SESSION_HEADER_LOWER] = incomingSessionId;
    }

    next();
  };
}

function shouldRejectSseWithoutInitialize(req: Request): boolean {
  if (req.method !== "GET") return false;

  const accept = String(req.header("accept") ?? "").toLowerCase();
  return accept.includes("text/event-stream");
}

function hasSessionHeader(req: Request): boolean {
  return Boolean(
    req.header(MCP_SESSION_HEADER) ??
      req.header(MCP_SESSION_HEADER_LOWER) ??
      req.header("x-mcp-session"),
  );
}

function isInitializeRequest(req: Request): boolean {
  return req.method === "POST" && req.body?.method === "initialize";
}

function isInitializedNotification(req: Request): boolean {
  return req.method === "POST" && req.body?.method === "notifications/initialized";
}

function sendPreInitializeSseError(res: Response): void {
  res.status(400).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message:
        "SSE stream requires an initialized MCP session. Call initialize first, then notifications/initialized.",
    },
    id: null,
  });
}

export async function boot(mode?: TransportMode): Promise<void> {
  const transportMode =
    mode ?? (process.env.STARTER_TRANSPORT as TransportMode | undefined) ?? "stdio";

  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  const registrationResults = await autoRegisterModules(server);
  const registeredTools = registrationResults
    .filter((result) => result.success && result.type === "tool")
    .map((result) => result.name);

  setRuntimeState({
    transport: transportMode,
    tools: registeredTools,
    serverName: SERVER_NAME,
    serverVersion: SERVER_VERSION,
    startedAt: Date.now(),
  });

  if (transportMode === "stdio") {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("[mcp/stdio] server running on stdio");
    return;
  }

  const corsOrigin = process.env.CORS_ORIGIN ?? "*";
  const app = createApp(corsOrigin);
  const transport = createTransport();

  await server.connect(transport);

  app.use("/mcp", sessionMiddleware());

  app.all("/mcp", (req, res) => {
    if (shouldRejectSseWithoutInitialize(req) && !hasSessionHeader(req)) {
      sendPreInitializeSseError(res);
      return;
    }

    if (isInitializeRequest(req)) {
      console.log("[mcp/http] initialize request received");
    } else if (isInitializedNotification(req)) {
      console.log("[mcp/http] initialized notification received");
    }

    void transport.handleRequest(req, res, req.body);
  });

  const port = Number(process.env.PORT ?? 3000);
  const httpServer = app.listen(port, () => {
    console.log(`[mcp/http] listening on http://localhost:${String(port)}/mcp`);
    console.log(`[mcp/http] cors origin: ${corsOrigin}`);
  });

  process.on("SIGINT", () => {
    console.log("[mcp/http] shutting down...");
    void transport.close();
    httpServer.close(() => {
      process.exit(0);
    });
  });
}