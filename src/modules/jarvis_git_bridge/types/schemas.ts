import { z } from "zod";

export const gitProviderTypeSchema = z.enum(["gitea", "github"]);
export const gitAuthTypeSchema = z.enum(["pat", "ssh_key", "basic"]);
export const gitSecretTypeSchema = z.enum(["pat", "ssh_private_key", "basic_password"]);
export const gitMirrorModeSchema = z.enum(["mirror", "refs"]);

export const gitRegisterProviderInputSchema = z.object({
  name: z.string().min(2).max(128),
  provider_type: gitProviderTypeSchema,
  base_url: z.string().url(),
  owner_default: z.string().min(1).max(128),
  auth_type: gitAuthTypeSchema,
  secret_ref: z.string().min(3).max(255),
});

export const gitStoreSecretInputSchema = z.object({
  secret_name: z.string().min(3).max(128),
  secret_type: gitSecretTypeSchema,
  secret_value: z.string().min(1).max(20_000),
});

export const gitTestConnectionInputSchema = z.object({
  provider_name: z.string().min(2).max(128),
});

export const gitMirrorRepoInputSchema = z.object({
  source_provider: z.string().min(2).max(128),
  source_repo: z.string().min(1).max(300),
  target_provider: z.string().min(2).max(128),
  target_repo: z.string().min(1).max(300),
  mode: gitMirrorModeSchema,
  create_if_missing: z.boolean(),
});

export const gitCompareRefsInputSchema = z.object({
  source_provider: z.string().min(2).max(128),
  source_repo: z.string().min(1).max(300),
  target_provider: z.string().min(2).max(128),
  target_repo: z.string().min(1).max(300),
});

export const gitListAuditLogsInputSchema = z.object({
  limit: z.number().int().min(1).max(500),
});

export const TOOL_NAMES = {
  registerProvider: "git_register_provider",
  storeSecret: "git_store_secret",
  testConnection: "git_test_connection",
  mirrorRepo: "git_mirror_repo",
  compareRefs: "git_compare_refs",
  listAuditLogs: "git_list_audit_logs",
} as const;

export type GitRegisterProviderInput = z.infer<typeof gitRegisterProviderInputSchema>;
export type GitStoreSecretInput = z.infer<typeof gitStoreSecretInputSchema>;
export type GitTestConnectionInput = z.infer<typeof gitTestConnectionInputSchema>;
export type GitMirrorRepoInput = z.infer<typeof gitMirrorRepoInputSchema>;
export type GitCompareRefsInput = z.infer<typeof gitCompareRefsInputSchema>;
export type GitListAuditLogsInput = z.infer<typeof gitListAuditLogsInputSchema>;
