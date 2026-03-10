import { URL } from "node:url";

export function normalizeRepoName(ownerDefault: string, repoName: string): string {
  const trimmed = repoName.trim().replace(/^\/+|\/+$/g, "");
  if (trimmed.includes("/")) {
    return trimmed;
  }

  return `${ownerDefault}/${trimmed}`;
}

export function buildRemoteUrl(baseUrl: string, ownerDefault: string, repoName: string): string {
  const normalizedBase = baseUrl.trim().replace(/\/+$/g, "");
  const repoPath = normalizeRepoName(ownerDefault, repoName);
  return `${normalizedBase}/${repoPath}.git`;
}

export function sanitizeRemoteUrl(urlValue: string): string {
  try {
    const parsed = new URL(urlValue);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return urlValue.replace(/\/\/[^@]+@/g, "//***@");
  }
}
