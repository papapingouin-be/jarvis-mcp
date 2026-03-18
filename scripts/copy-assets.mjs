import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

async function main() {
  const projectRoot = process.cwd();
  const sourceDir = path.join(projectRoot, "src", "modules", "jarvis_git_bridge", "db", "migrations");
  const targetDir = path.join(projectRoot, "build", "modules", "jarvis_git_bridge", "db", "migrations");

  await mkdir(targetDir, { recursive: true });
  await cp(sourceDir, targetDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error("Failed to copy build assets:", error);
  process.exit(1);
});