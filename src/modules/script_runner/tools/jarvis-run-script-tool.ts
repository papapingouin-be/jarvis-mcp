import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ScriptRunnerService } from "../services/script-runner.js";
import { asScriptRunnerError } from "../services/errors.js";
import { scriptParamValueSchema } from "../types/schemas.js";

const runInputSchema = {
  script_name: z.string().min(1).max(128),
  phase: z.enum(["collect", "execute"]),
  confirmed: z.boolean().optional(),
  verbose: z.boolean().optional().default(true),
  mode: z.enum(["sync", "async"]).optional().default("sync"),
  params: z.record(z.string(), scriptParamValueSchema).optional(),
};

const pollInputSchema = {
  job_id: z.string().uuid(),
  offset: z.number().int().min(0).optional().default(0),
  limit: z.number().int().min(1).max(500).optional().default(100),
};

const service = new ScriptRunnerService();

function toErrorResponse(error: unknown): {
  isError: true;
  content: Array<{ type: "text"; text: string }>;
} {
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

export function registerJarvisRunScriptTool(server: McpServer): void {
  server.tool(
    "jarvis_run_script",
    "Run approved infrastructure scripts with collect/execute phases",
    runInputSchema,
    async (args) => {
      try {
        if (args.mode === "async") {
          const started = await service.startAsyncJob({
            script_name: args.script_name,
            phase: args.phase,
            confirmed: args.confirmed,
            verbose: args.verbose,
            params: args.params,
          });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: true,
                  mode: "async",
                  ...started,
                  poll_tool: "jarvis_get_script_job",
                }),
              },
            ],
          };
        }

        const result = await service.run({
          script_name: args.script_name,
          phase: args.phase,
          confirmed: args.confirmed,
          verbose: args.verbose,
          params: args.params,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (error: unknown) {
        return toErrorResponse(error);
      }
    }
  );

  server.tool(
    "jarvis_get_script_job",
    "Poll async script job status and logs",
    pollInputSchema,
    async (args) => {
      try {
        const payload = service.getAsyncJob({
          job_id: args.job_id,
          offset: args.offset,
          limit: args.limit,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(payload),
            },
          ],
        };
      } catch (error: unknown) {
        return toErrorResponse(error);
      }
    }
  );
}
