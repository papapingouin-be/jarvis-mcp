import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TOOL_NAMES } from "../types/schemas.js";
import { toToolError, toToolSuccess } from "./response.js";
import { getJarvisGitBridgeService } from "../services/runtime.js";

export function registerGitRegisterProviderTool(server: McpServer): void {
  server.tool(
    TOOL_NAMES.registerProvider,
    "Register or update a remote Git provider",
    {
      name: z.string().min(2).max(128),
      provider_type: z.enum(["gitea", "github"]),
      base_url: z.string().url(),
      owner_default: z.string().min(1).max(128),
      auth_type: z.enum(["pat", "ssh_key", "basic"]),
      secret_ref: z.string().min(3).max(255),
    },
    async (args) => {
      try {
        const service = await getJarvisGitBridgeService();
        const result = await service.registerProvider({
          name: args.name,
          providerType: args.provider_type,
          baseUrl: args.base_url,
          ownerDefault: args.owner_default,
          authType: args.auth_type,
          secretRef: args.secret_ref,
        });

        return toToolSuccess(result);
      } catch (error: unknown) {
        return toToolError(error);
      }
    }
  );
}

