import { z } from "zod";
import type { RegisterableModule } from "../registry/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const npmAddProxyModule: RegisterableModule = {
  type: "tool",
  name: "npm_add_proxy",
  description: "Add or update a proxy host in Nginx Proxy Manager (wraps host script).",
  register(server: McpServer) {
    server.tool(
      "npm_add_proxy",
      "Add or update a proxy host in Nginx Proxy Manager (wraps host script).",
      {
        domain: z.string().min(1).describe("Domain name to create/update in NPM (e.g. n8n.jarvis.example.com)"),
        forward_host: z.string().min(1).describe("Upstream IP/hostname (e.g. 192.168.11.206)"),
        forward_port: z.number().int().positive().describe("Upstream port (e.g. 5678)"),
      },
      async (args) => {
        const cmd = "/app/tools/npm_add_proxy.sh";
        const execArgs = [args.domain, args.forward_host, String(args.forward_port)];

        try {
          const { stdout, stderr } = await execFileAsync(cmd, execArgs, { timeout: 60_000 });
          return {
            content: [
              {
                type: "text",
                text:
                  `OK\n` +
                  `domain=${args.domain}\nforward=${args.forward_host}:${args.forward_port}\n\n` +
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
                  `ERROR: ${msg}\n` +
                  `domain=${args.domain}\nforward=${args.forward_host}:${args.forward_port}\n\n` +
                  `STDOUT:\n${out || "(empty)"}\n\n` +
                  `STDERR:\n${err || "(empty)"}`,
              },
            ],
          };
        }
      }
    );
  },
};

export default npmAddProxyModule;
