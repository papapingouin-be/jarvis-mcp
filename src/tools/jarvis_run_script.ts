import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerJarvisRunScriptTool } from "../modules/script_runner/index.js";
import type { RegisterableModule } from "../registry/types.js";

const jarvisRunScriptModule: RegisterableModule = {
  type: "tool",
  name: "jarvis_run_script",
  description: "Natural entry point for Jarvis infrastructure actions: discover scripts, run them safely, and follow live progress for long-running jobs.",
  register(server: McpServer) {
    registerJarvisRunScriptTool(server);
  },
};

export default jarvisRunScriptModule;
