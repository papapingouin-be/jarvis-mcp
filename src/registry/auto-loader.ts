import {
  getRootDir,
  countResults,
  formatRegistrationSummary,
  logFailedModules,
  findModuleFiles,
  type ModuleLoadResult,
} from "./helpers.js";
import { processModule } from "./module-processor.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export async function autoRegisterModules(server: McpServer): Promise<Array<ModuleLoadResult>> {
  const rootDir = getRootDir(import.meta.url);
  const files = await findModuleFiles(rootDir);

  const settledResults = await Promise.allSettled(
    files.map(filePath => processModule(filePath, server))
  );

  const { successful, failed } = countResults(settledResults);
  console.error(formatRegistrationSummary(successful, failed));

  if (failed > 0) {
    logFailedModules(settledResults);
  }

  return settledResults.map((result) => {
    if (result.status === "fulfilled") {
      return result.value;
    }

    return {
      success: false,
      name: "unknown",
      error: result.reason,
    };
  });
}
