import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TOOL_NAMES } from "../types/schemas.js";
import { toToolError, toToolSuccess } from "./response.js";
import { getJarvisGitBridgeService } from "../services/runtime.js";

export function registerGitTestConnectionTool(server: McpServer): void {
  server.tool(
    TOOL_NAMES.testConnection,
    "Test provider authentication and connectivity",
    {
      provider_name: z.string().min(2).max(128),
    },
    async (args) => {
      try {
        const service = await getJarvisGitBridgeService();
        const result = await service.testConnection(args.provider_name);
        return toToolSuccess(result);
      } catch (error: unknown) {
        return toToolError(error);
      }
    }
  );
}

