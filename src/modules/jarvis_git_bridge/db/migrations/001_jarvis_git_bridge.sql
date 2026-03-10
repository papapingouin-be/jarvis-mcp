CREATE TABLE IF NOT EXISTS git_secrets (
  id BIGSERIAL PRIMARY KEY,
  secret_name VARCHAR(128) UNIQUE NOT NULL,
  secret_type VARCHAR(32) NOT NULL,
  ciphertext TEXT NOT NULL,
  key_version VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_tested_at TIMESTAMPTZ NULL
);

CREATE TABLE IF NOT EXISTS git_providers (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(128) UNIQUE NOT NULL,
  provider_type VARCHAR(32) NOT NULL,
  base_url TEXT NOT NULL,
  owner_default VARCHAR(128) NOT NULL,
  auth_type VARCHAR(32) NOT NULL,
  secret_ref VARCHAR(255) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS git_repositories (
  id BIGSERIAL PRIMARY KEY,
  provider_id BIGINT NOT NULL REFERENCES git_providers(id),
  repo_name VARCHAR(300) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_synced_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider_id, repo_name)
);

CREATE TABLE IF NOT EXISTS git_sync_jobs (
  id BIGSERIAL PRIMARY KEY,
  source_provider_id BIGINT NOT NULL REFERENCES git_providers(id),
  target_provider_id BIGINT NOT NULL REFERENCES git_providers(id),
  source_repo VARCHAR(300) NOT NULL,
  target_repo VARCHAR(300) NOT NULL,
  mode VARCHAR(16) NOT NULL,
  status VARCHAR(32) NOT NULL,
  requested_by VARCHAR(128) NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ NULL,
  result_json JSONB NULL
);

CREATE TABLE IF NOT EXISTS git_audit_logs (
  id BIGSERIAL PRIMARY KEY,
  tool_name VARCHAR(128) NOT NULL,
  action VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL,
  message TEXT NOT NULL,
  context_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_git_audit_logs_created_at ON git_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_git_sync_jobs_status ON git_sync_jobs(status);
