import { readFile } from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisterableModule } from "../registry/types.js";
import { getGitBridgeEnvConfig } from "../config/env.js";

function toPayload(data: Record<string, unknown>): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [{
      type: "text",
      text: JSON.stringify(data),
    }],
  };
}

const jarvisAutotestRuntimeModule: RegisterableModule = {
  type: "tool",
  name: "jarvis_autotest_runtime",
  description: "Check runtime prerequisites such as env vars, module resolution, and package metadata.",
  register(server: McpServer) {
    server.tool(
      "jarvis_autotest_runtime",
      "Check runtime prerequisites such as env vars, module resolution, and package metadata.",
      {},
      async () => {
        const gitBridgeConfig = getGitBridgeEnvConfig();
        const packageJsonPath = path.join(process.cwd(), "package.json");

        const checks: Record<string, unknown> = {
          package_json_read_ok: false,
          package_json_has_pg_dependency: false,
          pg_module_resolvable: false,
          connection_string_present: Boolean(gitBridgeConfig.database.connectionString),
        };

        let packageJsonDependencies: Record<string, string> = {};
        let packageJsonDevDependencies: Record<string, string> = {};
        let packageJsonName: string | null = null;

        try {
          const rawPackageJson = await readFile(packageJsonPath, "utf8");
          const parsed = JSON.parse(rawPackageJson) as {
            name?: string;
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
          };

          packageJsonName = parsed.name ?? null;
          packageJsonDependencies = parsed.dependencies ?? {};
          packageJsonDevDependencies = parsed.devDependencies ?? {};
          checks.package_json_read_ok = true;
          checks.package_json_has_pg_dependency = typeof packageJsonDependencies.pg === "string";
        } catch {
        }

        try {
          await import(gitBridgeConfig.database.pgModuleName);
          checks.pg_module_resolvable = true;
        } catch {
        }

        const ok = checks.package_json_read_ok === true
          && checks.package_json_has_pg_dependency === true
          && checks.pg_module_resolvable === true;

        return toPayload({
          ok,
          status: ok ? "OK" : "KO",
          checks,
          runtime: {
            cwd: process.cwd(),
            node_version: process.version,
            package_name: packageJsonName,
            pg_module_name: gitBridgeConfig.database.pgModuleName,
          },
          config: {
            connection_string_present: Boolean(gitBridgeConfig.database.connectionString),
            env_presence: {
              DATABASE_URL: Boolean(process.env.DATABASE_URL),
              jarvis_tools_DATABASE_URL: Boolean(process.env.jarvis_tools_DATABASE_URL),
              jarvis_tools_PG_URL: Boolean(process.env.jarvis_tools_PG_URL),
              jarvis_tools_PG_DB: Boolean(process.env.jarvis_tools_PG_DB),
              jarvis_tools_PG_USER: Boolean(process.env.jarvis_tools_PG_USER),
              jarvis_tools_PG_PASSWORD: Boolean(process.env.jarvis_tools_PG_PASSWORD),
            },
          },
          package_json: {
            dependencies: packageJsonDependencies,
            dev_dependencies: packageJsonDevDependencies,
          },
          recommendations: ok
            ? []
            : [
                "Rebuild the runtime image/container after updating dependencies.",
                "Verify that package.json includes pg under dependencies, not only devDependencies.",
                "Verify that the runtime executes npm install/npm ci after the dependency change.",
              ],
        });
      }
    );
  },
};

export default jarvisAutotestRuntimeModule;