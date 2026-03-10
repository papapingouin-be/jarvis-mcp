import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TOOL_NAMES } from "../types/schemas.js";
import { toToolError, toToolSuccess } from "./response.js";
import { getJarvisGitBridgeService } from "../services/runtime.js";

export function registerGitMirrorRepoTool(server: McpServer): void {
  server.tool(
    TOOL_NAMES.mirrorRepo,
    "Synchronize repository between providers",
    {
      source_provider: z.string().min(2).max(128),
      source_repo: z.string().min(1).max(300),
      target_provider: z.string().min(2).max(128),
      target_repo: z.string().min(1).max(300),
      mode: z.enum(["mirror", "refs"]),
      create_if_missing: z.boolean(),
    },
    async (args) => {
      try {
        const service = await getJarvisGitBridgeService();
        const result = await service.mirrorRepository({
          sourceProviderName: args.source_provider,
          sourceRepo: args.source_repo,
          targetProviderName: args.target_provider,
          targetRepo: args.target_repo,
          mode: args.mode,
          createIfMissing: args.create_if_missing,
        });

        return toToolSuccess(result);
      } catch (error: unknown) {
        return toToolError(error);
      }
    }
  );
}

