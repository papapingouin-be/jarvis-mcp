import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getServerEnvConfig } from "../config/env.js";
import type { RegisterableModule } from "../registry/types.js";
import { getDiagnosticsRuntimeConfig, getRecentDiagnosticEvents } from "../server/diagnostics.js";
import { getRuntimeState } from "../server/runtime-state.js";

function diagnosePayload(verbose = false): Record<string, unknown> {
  const runtime = getRuntimeState();
  const uptimeSec = Math.floor((Date.now() - runtime.startedAt) / 1000);
  const envConfig = getServerEnvConfig();
  const loggingConfig = getDiagnosticsRuntimeConfig();
  const expectedEnvVars = envConfig.diagnoseEnvVars;

  const env = Object.fromEntries(
    expectedEnvVars.map((name) => [name, Boolean(process.env[name])])
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
    logging: {
      log_file_path: loggingConfig.logFilePath,
      verbose_mode: loggingConfig.verboseMode,
      recent_event_limit: loggingConfig.recentEventLimit,
    },
    recentEvents: verbose ? getRecentDiagnosticEvents(25) : undefined,
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
        verbose: z.boolean().optional().describe("When true, include recent MCP events and logging settings."),
      },
      async (args) => {
        const payload = diagnosePayload(args.verbose === true);
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