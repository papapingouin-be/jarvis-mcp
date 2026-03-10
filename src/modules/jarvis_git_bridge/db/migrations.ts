import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);

export async function loadInitialMigrationSql(): Promise<string> {
  const filePath = path.join(currentDir, "migrations", "001_jarvis_git_bridge.sql");
  return readFile(filePath, "utf8");
}
