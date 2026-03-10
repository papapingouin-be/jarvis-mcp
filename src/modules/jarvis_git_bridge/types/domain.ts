import type {
  GitAuthTypeSchema,
  GitMirrorModeSchema,
  GitProviderTypeSchema,
  GitSecretTypeSchema,
} from "./type-tags.js";

export type GitProviderType = GitProviderTypeSchema;
export type GitAuthType = GitAuthTypeSchema;
export type GitSecretType = GitSecretTypeSchema;
export type GitMirrorMode = GitMirrorModeSchema;

export type GitProviderRow = {
  id: number;
  name: string;
  provider_type: GitProviderType;
  base_url: string;
  owner_default: string;
  auth_type: GitAuthType;
  secret_ref: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type GitSecretRow = {
  id: number;
  secret_name: string;
  secret_type: GitSecretType;
  ciphertext: string;
  key_version: string;
  status: string;
  created_at: string;
  updated_at: string;
  last_tested_at: string | null;
};

export type GitAuditLogRow = {
  id: number;
  tool_name: string;
  action: string;
  status: string;
  message: string;
  context_json: Record<string, unknown>;
  created_at: string;
};

export type GitSyncJobStatus = "running" | "success" | "failed";

export type GitSyncJobRow = {
  id: number;
  source_provider_id: number;
  target_provider_id: number;
  source_repo: string;
  target_repo: string;
  mode: GitMirrorMode;
  status: GitSyncJobStatus;
  requested_by: string;
  started_at: string;
  ended_at: string | null;
  result_json: Record<string, unknown> | null;
};

export type RegisterProviderResult = {
  provider_id: number;
  status: "registered";
};

export type StoreSecretResult = {
  secret_ref: string;
  status: "stored";
};

export type TestConnectionResult = {
  ok: boolean;
  provider_name: string;
  auth_type: string;
  test_summary: string;
};

export type MirrorResult = {
  ok: boolean;
  mode: GitMirrorMode;
  source: string;
  target: string;
  summary: string;
  branches_pushed: number;
  tags_pushed: number;
  warnings: Array<string>;
};

export type CompareRefsResult = {
  ok: boolean;
  source_only_refs: Array<string>;
  target_only_refs: Array<string>;
  divergent_refs: Array<string>;
  summary: string;
};

export type ToolResultEnvelope = {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
};
