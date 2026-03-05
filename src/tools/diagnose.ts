import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RegisterableModule } from "../registry/types.js";
import { getRuntimeState } from "../server/runtime-state.js";

const EXPECTED_ENV_VARS = [
  "STARTER_TRANSPORT",
  "PORT",
  "CORS_ORIGIN",
  "NPM_URL",
  "NPM_IDENTITY",
  "NPM_SECRET",
] as const;

function diagnosePayload(): Record<string, unknown> {
  const runtime = getRuntimeState();
  const uptimeSec = Math.floor((Date.now() - runtime.startedAt) / 1000);

  const env = Object.fromEntries(
    EXPECTED_ENV_VARS.map((name) => [name, Boolean(process.env[name])])
  );

  const messages: Array<string> = [];
  if (runtime.tools.length === 0) {
    messages.push("No tools registered.");
  }

  return {
    ok: messages.length === 0,
    status: messages.length === 0 ? "OK" : "KO",
    messages,
    serverName: runtime.serverName,
    serverVersion: runtime.serverVersion,
    transport: runtime.transport,
    uptimeSec,
    env,
    tools: runtime.tools,
  };
}

const diagnoseModule: RegisterableModule = {
  type: "tool",
  name: "diagnose",
  description: "Return MCP runtime diagnostics (transport/version/uptime/env presence/tools).",
  register(server: McpServer) {
    server.tool(
      "diagnose",
      "Return MCP runtime diagnostics (transport/version/uptime/env presence/tools).",
      {
        verbose: z.boolean().optional().describe("Reserved for future detail level; currently ignored."),
      },
      async () => {
        const payload = diagnosePayload();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(payload, null, 2),
            },
          ],
        };
      }
    );
  },
};

export default diagnoseModule;
