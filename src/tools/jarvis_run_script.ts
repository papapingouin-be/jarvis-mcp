import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerJarvisRunScriptTool } from "../modules/script_runner/index.js";
import type { RegisterableModule } from "../registry/types.js";

const jarvisRunScriptModule: RegisterableModule = {
  type: "tool",
  name: "jarvis_run_script",
  description: "Execute approved infrastructure scripts in collect/execute phases, including advanced Proxmox and redeploy workflows.",
  register(server: McpServer) {
    registerJarvisRunScriptTool(server);
  },
};

export default jarvisRunScriptModule;
