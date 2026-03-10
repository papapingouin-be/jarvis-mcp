import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerJarvisGitBridgeTools } from "../modules/jarvis_git_bridge/index.js";
import type { RegisterableModule } from "../registry/types.js";

const jarvisGitBridgeModule: RegisterableModule = {
  type: "tool",
  name: "jarvis_git_bridge",
  description: "Secure Git bridge for Gitea and GitHub synchronization",
  register(server: McpServer) {
    registerJarvisGitBridgeTools(server);
  },
};

export default jarvisGitBridgeModule;
