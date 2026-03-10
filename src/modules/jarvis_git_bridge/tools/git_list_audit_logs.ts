import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TOOL_NAMES } from "../types/schemas.js";
import { toToolError, toToolSuccess } from "./response.js";
import { getJarvisGitBridgeService } from "../services/runtime.js";

export function registerGitListAuditLogsTool(server: McpServer): void {
  server.tool(
    TOOL_NAMES.listAuditLogs,
    "List git bridge audit logs",
    {
      limit: z.number().int().min(1).max(500).default(50),
    },
    async (args) => {
      try {
        const service = await getJarvisGitBridgeService();
        const result = await service.listAuditLogs(args.limit);
        return toToolSuccess(result);
      } catch (error: unknown) {
        return toToolError(error);
      }
    }
  );
}

