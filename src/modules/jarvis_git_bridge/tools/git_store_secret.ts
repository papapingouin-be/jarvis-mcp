import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TOOL_NAMES } from "../types/schemas.js";
import { toToolError, toToolSuccess } from "./response.js";
import { getJarvisGitBridgeService } from "../services/runtime.js";

export function registerGitStoreSecretTool(server: McpServer): void {
  server.tool(
    TOOL_NAMES.storeSecret,
    "Store encrypted git secret in PostgreSQL",
    {
      secret_name: z.string().min(3).max(128),
      secret_type: z.enum(["pat", "ssh_private_key", "basic_password"]),
      secret_value: z.string().min(1).max(20_000),
    },
    async (args) => {
      try {
        const service = await getJarvisGitBridgeService();
        const result = await service.storeSecret({
          secretName: args.secret_name,
          secretType: args.secret_type,
          secretValue: args.secret_value,
        });

        return toToolSuccess({
          secret_ref: result.secret_ref,
          status: result.status,
        });
      } catch (error: unknown) {
        return toToolError(error);
      }
    }
  );
}

