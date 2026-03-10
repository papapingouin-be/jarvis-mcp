import { readFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { JarvisGitBridgeError } from "../services/errors.js";

const MASTER_KEY_BYTES = 32;

function toValidKey(raw: string): Buffer {
  const normalized = raw.trim();
  const decoded = Buffer.from(normalized, "base64");

  if (decoded.byteLength !== MASTER_KEY_BYTES) {
    throw new JarvisGitBridgeError(
      "MASTER_KEY_INVALID",
      "Master key must be base64 and decode to 32 bytes"
    );
  }

  return decoded;
}

export async function loadMasterKeyFromEnv(): Promise<Buffer> {
  const keyFile = process.env.MASTER_KEY_FILE?.trim()
    || process.env.jarvis_tools_MASTER_KEY_FILE?.trim();
  if (typeof keyFile === "string" && keyFile.length > 0) {
    const fileContent = await readFile(keyFile, "utf-8");
    return toValidKey(fileContent);
  }

  const inlineKey = process.env.MASTER_KEY?.trim()
    || process.env.jarvis_tools_MASTER_KEY?.trim();
  if (typeof inlineKey === "string" && inlineKey.length > 0) {
    return toValidKey(inlineKey);
  }

  throw new JarvisGitBridgeError(
    "MASTER_KEY_MISSING",
    "Master key is required through MASTER_KEY_FILE or MASTER_KEY"
  );
}
