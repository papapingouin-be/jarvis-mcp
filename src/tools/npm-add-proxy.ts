import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Tool definition expected by the starter auto-loader: export default { ... }
export default {
  name: "npm_add_proxy",
  description: "Add or update a proxy host in Nginx Proxy Manager using the host script wrapper.",
  inputSchema: z.object({
    domain: z.string().min(1),
    forward_host: z.string().min(1),
    forward_port: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
  }),
  handler: async (input: { domain: string; forward_host: string; forward_port: number | string }) => {
    const portStr = typeof input.forward_port === "number" ? String(input.forward_port) : input.forward_port;

    // Wrapper inside the container
    const cmd = "/app/tools/npm_add_proxy.sh";
    const args = [input.domain, input.forward_host, portStr];

    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 60_000 });
      return {
        content: [
          { type: "text", text: `OK\n\nSTDOUT:\n${stdout || "(empty)"}\n\nSTDERR:\n${stderr || "(empty)"}` },
        ],
      };
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      const out = e?.stdout ?? "";
      const err = e?.stderr ?? "";
      return {
        isError: true,
        content: [
          { type: "text", text: `ERROR: ${msg}\n\nSTDOUT:\n${out || "(empty)"}\n\nSTDERR:\n${err || "(empty)"}` },
        ],
      };
    }
  },
};
