import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerGitCompareRefsTool } from "./git_compare_refs.js";
import { registerGitListAuditLogsTool } from "./git_list_audit_logs.js";
import { registerGitMirrorRepoTool } from "./git_mirror_repo.js";
import { registerGitRegisterProviderTool } from "./git_register_provider.js";
import { registerGitStoreSecretTool } from "./git_store_secret.js";
import { registerGitTestConnectionTool } from "./git_test_connection.js";

export function registerJarvisGitBridgeTools(server: McpServer): void {
  registerGitStoreSecretTool(server);
  registerGitRegisterProviderTool(server);
  registerGitTestConnectionTool(server);
  registerGitMirrorRepoTool(server);
  registerGitCompareRefsTool(server);
  registerGitListAuditLogsTool(server);
}

