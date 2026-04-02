import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { JarvisSyncBuildRedeployService } from "../config/jarvis-sync-build-redeploy-service.js";
import { asScriptRunnerError } from "../modules/script_runner/services/errors.js";
import type { RegisterableModule } from "../registry/types.js";

const phaseSchema = z.enum(["collect", "execute"]);
const modeSchema = z.enum([
  "self-doc",
  "registry-doc",
  "list-services",
  "describe-service",
  "validate-service-input",
  "all",
  "sync",
  "install",
  "build",
  "deploy-web",
  "deploy-scripts",
  "mirror",
  "webhook",
  "restart",
]);

const executeModeSet = new Set([
  "all",
  "sync",
  "install",
  "build",
  "deploy-web",
  "deploy-scripts",
  "mirror",
  "webhook",
  "restart",
]);

const metadataServiceModeSet = new Set(["describe-service", "validate-service-input"]);

type ExecuteMode = "all" | "sync" | "install" | "build" | "deploy-web" | "deploy-scripts" | "mirror" | "webhook" | "restart";
type MetadataMode = "self-doc" | "registry-doc" | "list-services" | "describe-service" | "validate-service-input";

const service = new JarvisSyncBuildRedeployService();

function toResponse(payload: Record<string, unknown>): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload),
      },
    ],
  };
}

const jarvisSyncBuildRedeployModule: RegisterableModule = {
  type: "tool",
  name: "jarvis_sync_build_redeploy",
  description: "Redeploy Jarvis MCP updates in natural steps: sync code, build, deploy assets, redeploy the Portainer stack, and restart MCPO.",
  register(server: McpServer) {
    server.tool(
      "jarvis_sync_build_redeploy",
      "Redeploy Jarvis MCP updates in natural steps: sync code, build, deploy assets, redeploy the Portainer stack, and restart MCPO.",
      {
        phase: phaseSchema.optional().default("collect").describe("MCP phase: collect or execute."),
        mode: modeSchema.optional().default("self-doc").describe("Metadata mode or workflow mode."),
        confirmed: z.boolean().optional().default(false).describe("Required for execute unless dry_run=true."),
        dry_run: z.boolean().optional().default(false).describe("Show intended commands without executing them."),
        env_file: z.string().min(1).optional().describe("Optional dotenv file merged before DB-backed config values."),
        service: z.enum([
          "all",
          "sync",
          "install",
          "build",
          "deploy-web",
          "deploy-scripts",
          "mirror",
          "webhook",
          "restart",
        ]).optional().describe("Execution service used by describe-service or validate-service-input."),
      },
      async (args) => {
        try {
          if (args.phase === "execute") {
            if (!executeModeSet.has(args.mode)) {
              return toResponse({
                ok: false,
                summary: "Invalid execute mode",
                details: `Mode ${args.mode} is metadata-only and cannot run in execute phase`,
              });
            }

            return toResponse(await service.execute({
              mode: args.mode as ExecuteMode,
              confirmed: args.confirmed,
              dry_run: args.dry_run,
              env_file: args.env_file,
            }));
          }

          if (metadataServiceModeSet.has(args.mode) && args.service === undefined) {
            return toResponse({
              ok: false,
              summary: "Missing required service parameter",
              details: `Mode ${args.mode} requires service=...`,
            });
          }

          return toResponse(await service.collect({
            mode: args.mode as MetadataMode,
            dry_run: args.dry_run,
            env_file: args.env_file,
            service: args.service,
          }));
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
  },
};

export default jarvisSyncBuildRedeployModule;
