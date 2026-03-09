import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { RegisterableModule } from "../registry/types.js";

const execFileAsync = promisify(execFile);

const actionSchema = z.enum(["help", "list", "add", "delete"]);

const jarvisNpmModule: RegisterableModule = {
  type: "tool",
  name: "jarvis_npm",
  description: "Nginx Proxy Manager helper: help, list, add, delete.",
  register(server: McpServer) {
    server.tool(
      "jarvis_npm",
      "Nginx Proxy Manager helper: help, list, add, delete.",
      {
        action: actionSchema.describe("Action to run: help, list, add, delete"),
        domain: z.string().min(1).optional().describe("Domain for add/delete (e.g. n8n.jarvis.example.com)"),
        forward_host: z.string().min(1).optional().describe("Upstream host/IP for add (e.g. 192.168.11.206)"),
        forward_port: z.number().int().positive().optional().describe("Upstream port for add (e.g. 5678)"),
      },
      async (args) => {
        if (args.action === "add") {
          if (!args.domain || !args.forward_host || !args.forward_port) {
            return {
              isError: true,
              content: [{
                type: "text",
                text: "ERROR: action=add requires domain, forward_host and forward_port.",
              }],
            };
          }
        }

        if (args.action === "delete" && !args.domain) {
          return {
            isError: true,
            content: [{
              type: "text",
              text: "ERROR: action=delete requires domain.",
            }],
          };
        }

        const cmd = "/app/tools/jarvis_npm.sh";
        const execArgs: string[] = [args.action];

        if (args.action === "add") {
          execArgs.push(args.domain!, args.forward_host!, String(args.forward_port!));
        } else if (args.action === "delete") {
          execArgs.push(args.domain!);
        } else if (args.action === "list" && args.domain) {
          execArgs.push(args.domain);
        }

        try {
          const { stdout, stderr } = await execFileAsync(cmd, execArgs, { timeout: 60_000 });
          return {
            content: [
              {
                type: "text",
                text:
                  `OK action=${args.action}\n\n` +
                  `STDOUT:\n${stdout || "(empty)"}\n\n` +
                  `STDERR:\n${stderr || "(empty)"}`,
              },
            ],
          };
        } catch (e: any) {
          const msg = e?.message ?? String(e);
          const out = e?.stdout ?? "";
          const err = e?.stderr ?? "";
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  `ERROR action=${args.action}: ${msg}\n\n` +
                  `STDOUT:\n${out || "(empty)"}\n\n` +
                  `STDERR:\n${err || "(empty)"}`,
              },
            ],
          };
        }
      },
    );
  },
};

export default jarvisNpmModule;
