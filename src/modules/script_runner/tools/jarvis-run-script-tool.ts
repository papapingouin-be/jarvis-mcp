import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ScriptRunnerService } from "../services/script-runner.js";
import { asScriptRunnerError } from "../services/errors.js";
import { scriptParamValueSchema } from "../types/schemas.js";

const inputSchema = {
  script_name: z.string().min(1).max(128),
  phase: z.enum(["collect", "execute"]),
  confirmed: z.boolean().optional(),
  verbose: z.boolean().optional().default(true),
  params: z.record(z.string(), scriptParamValueSchema).optional(),
};

const service = new ScriptRunnerService();

export function registerJarvisRunScriptTool(server: McpServer): void {
  server.tool(
    "jarvis_run_script",
    "Run approved infrastructure scripts with collect/execute phases",
    inputSchema,
    async (args) => {
      try {
        const result = await service.run(args);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (error: unknown) {
        const safeError = asScriptRunnerError(error);

        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: {
                  code: safeError.code,
                  message: safeError.safeMessage,
                  context: safeError.context ?? {},
                },
              }),
            },
          ],
        };
      }
    }
  );
}
