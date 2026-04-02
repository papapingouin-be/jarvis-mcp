import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { describeScriptEnv, saveScriptEnvValues } from "../../../config/service.js";
import { ScriptRunnerService } from "../services/script-runner.js";
import { asScriptRunnerError } from "../services/errors.js";
import { scriptParamValueSchema } from "../types/schemas.js";

const keyValueParamSchema = z.object({
  key: z.string().min(1).max(255).describe("Parameter name."),
  value: scriptParamValueSchema.describe("Parameter value."),
});

const runInputSchema = {
  script_name: z.string().min(1).max(255),
  phase: z.enum(["collect", "execute"]),
  confirmed: z.boolean().optional(),
  verbose: z.boolean().optional().default(true),
  mode: z.enum(["sync", "async"]).optional().default("async"),
  params_list: z.array(keyValueParamSchema).optional().describe("Optional script parameters as key/value pairs."),
};

const pollInputSchema = {
  job_id: z.string().uuid(),
  offset: z.number().int().min(0).optional().default(0),
  limit: z.number().int().min(1).max(500).optional().default(100),
};

const describeInputSchema = {
  script_name: z.string().min(1).max(255),
};

const saveScriptConfigInputSchema = {
  script_name: z.string().min(1).max(255),
  values_list: z.array(z.object({
    key: z.string().min(1).max(255).describe("Environment variable name."),
    value: z.string().min(1).describe("Environment variable value."),
  })).min(1),
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
  const toParamRecord = (entries?: Array<{ key: string; value: string | number | boolean }>): Record<string, string | number | boolean> | undefined => {
    if (!Array.isArray(entries) || entries.length === 0) {
      return undefined;
    }

    return Object.fromEntries(entries.map((entry) => [entry.key, entry.value]));
  };

  server.tool(
    "jarvis_run_script",
    "Run an approved Jarvis infrastructure action. Use collect first to discover what a script can do. For long tasks, keep mode=async to get progress logs with jarvis_get_script_job.",
    runInputSchema,
    async (args) => {
      try {
        const params = toParamRecord(args.params_list);
        if (args.mode === "async") {
          const started = await service.startAsyncJob({
            script_name: args.script_name,
            phase: args.phase,
            confirmed: args.confirmed,
            verbose: args.verbose,
            params,
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
                  next_poll_after_ms: 1500,
                  message: "Script started. Poll jarvis_get_script_job to receive live logs before completion.",
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
          params,
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
    "jarvis_list_scripts",
    "List the approved Jarvis actions available for natural language requests.",
    {},
    async () => {
      try {
        const payload = await service.listScripts();
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

  server.tool(
    "jarvis_describe_script",
    "Explain one Jarvis action, what it does, what parameters it accepts, and which environment variables it needs.",
    describeInputSchema,
    async (args) => {
      try {
        const payload = await service.describeScript(args.script_name);
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

  server.tool(
    "jarvis_get_script_config",
    "Show the saved configuration values required by one Jarvis action.",
    describeInputSchema,
    async (args) => {
      try {
        const payload = await describeScriptEnv(args.script_name);
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

  server.tool(
    "jarvis_save_script_config",
    "Save configuration values for one Jarvis action using explicit key/value pairs.",
    saveScriptConfigInputSchema,
    async (args) => {
      try {
        const payload = await saveScriptEnvValues(
          args.script_name,
          Object.fromEntries(args.values_list.map((entry) => [entry.key, entry.value])),
        );
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

  server.tool(
    "jarvis_get_script_job",
    "Poll a running Jarvis action to get intermediate logs, status, and the final result.",
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
