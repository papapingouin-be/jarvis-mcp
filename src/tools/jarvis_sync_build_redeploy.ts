import { access } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RegisterableModule } from "../registry/types.js";

const execFileAsync = promisify(execFile);

const phaseSchema = z.enum(["collect", "execute"]);
const modeSchema = z.enum([
  "self-doc",
  "registry-doc",
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

function resolveToolPath(): string {
  return path.resolve(
    process.env.JARVIS_SYNC_BUILD_REDEPLOY_SCRIPT
      ?? process.env.jarvis_tools_SYNC_BUILD_REDEPLOY_SCRIPT
      ?? path.join(process.cwd(), "tools", "jarvis_sync_build_redeploy.sh")
  );
}

function toToolResponse(payload: Record<string, unknown>): {
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
  description: "Run the Jarvis sync/build/redeploy shell workflow and return its JSON summary.",
  register(server: McpServer) {
    server.tool(
      "jarvis_sync_build_redeploy",
      "Run the Jarvis sync/build/redeploy shell workflow and return its JSON summary.",
      {
        phase: phaseSchema.optional().default("collect").describe("MCP phase: collect or execute."),
        mode: modeSchema.optional().default("self-doc").describe("Workflow mode or metadata mode."),
        confirmed: z.boolean().optional().default(false).describe("Required for execute modes unless dry_run=true."),
        dry_run: z.boolean().optional().default(false).describe("Run execute modes in simulation mode."),
        env_file: z.string().min(1).optional().describe("Optional path to the .env file consumed by the shell script."),
      },
      async (args) => {
        const toolPath = resolveToolPath();

        try {
          await access(toolPath);
        } catch {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  summary: "Redeploy tool script not found",
                  details: `Expected script at ${toolPath}`,
                }),
              },
            ],
          };
        }

        const execArgs: Array<string> = [
          "--phase",
          args.phase,
          "--confirmed",
          args.confirmed ? "true" : "false",
          "--param",
          `mode=${args.mode}`,
          "--param",
          `dry_run=${args.dry_run ? "true" : "false"}`,
          "--json-stdout",
        ];

        if (args.env_file) {
          execArgs.push("--param", `env_file=${args.env_file}`);
        }

        try {
          const { stdout } = await execFileAsync(toolPath, execArgs, {
            timeout: 15 * 60 * 1000,
            maxBuffer: 1024 * 1024,
            env: process.env,
          });

          const parsed = JSON.parse(stdout.trim()) as Record<string, unknown>;
          return toToolResponse({
            ok: true,
            tool: "jarvis_sync_build_redeploy",
            result: parsed,
          });
        } catch (error: unknown) {
          const safeError = error as {
            message?: string;
            stdout?: string | Buffer;
            stderr?: string | Buffer;
          };

          const stdout = typeof safeError.stdout === "string"
            ? safeError.stdout
            : safeError.stdout?.toString("utf8") ?? "";
          const stderr = typeof safeError.stderr === "string"
            ? safeError.stderr
            : safeError.stderr?.toString("utf8") ?? "";

          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ok: false,
                  tool: "jarvis_sync_build_redeploy",
                  summary: "Redeploy workflow failed",
                  details: safeError.message ?? "Unknown error",
                  stdout: stdout.trim() || null,
                  stderr: stderr.trim() || null,
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
