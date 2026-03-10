import { loadInitialMigrationSql } from "./migrations.js";
import type { DatabaseClient } from "./database.js";
import type {
  GitAuditLogRow,
  GitProviderRow,
  GitSecretRow,
  GitSyncJobRow,
  GitSyncJobStatus,
} from "../types/domain.js";
import type { GitMirrorModeSchema } from "../types/type-tags.js";

type JsonLike = string | Record<string, unknown> | null;

function parseJson(input: JsonLike): Record<string, unknown> {
  if (input === null) {
    return {};
  }

  if (typeof input === "string") {
    try {
      return JSON.parse(input) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  return input;
}

export async function runJarvisGitBridgeMigrations(db: DatabaseClient): Promise<void> {
  const sql = await loadInitialMigrationSql();
  await db.query(sql);
}

export class GitSecretRepository {
  private readonly db: DatabaseClient;

  constructor(db: DatabaseClient) {
    this.db = db;
  }

  async upsert(params: {
    secretName: string;
    secretType: string;
    ciphertext: string;
    keyVersion: string;
  }): Promise<GitSecretRow> {
    const rows = await this.db.query<GitSecretRow>(
      `
      INSERT INTO git_secrets (secret_name, secret_type, ciphertext, key_version, status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, 'active', NOW(), NOW())
      ON CONFLICT (secret_name)
      DO UPDATE SET
        secret_type = EXCLUDED.secret_type,
        ciphertext = EXCLUDED.ciphertext,
        key_version = EXCLUDED.key_version,
        status = 'active',
        updated_at = NOW()
      RETURNING *
      `,
      [params.secretName, params.secretType, params.ciphertext, params.keyVersion]
    );

    const first = rows[0];
    if (first === undefined) {
      throw new Error("Failed to persist secret");
    }

    return first;
  }

  async findByRef(secretRef: string): Promise<GitSecretRow | null> {
    const rows = await this.db.query<GitSecretRow>(
      "SELECT * FROM git_secrets WHERE secret_name = $1 LIMIT 1",
      [secretRef]
    );

    return rows[0] ?? null;
  }

  async markTested(secretName: string): Promise<void> {
    await this.db.query(
      "UPDATE git_secrets SET last_tested_at = NOW(), updated_at = NOW() WHERE secret_name = $1",
      [secretName]
    );
  }
}

export class GitProviderRepository {
  private readonly db: DatabaseClient;

  constructor(db: DatabaseClient) {
    this.db = db;
  }

  async upsert(params: {
    name: string;
    providerType: string;
    baseUrl: string;
    ownerDefault: string;
    authType: string;
    secretRef: string;
  }): Promise<GitProviderRow> {
    const rows = await this.db.query<GitProviderRow>(
      `
      INSERT INTO git_providers (name, provider_type, base_url, owner_default, auth_type, secret_ref, is_active, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW(), NOW())
      ON CONFLICT (name)
      DO UPDATE SET
        provider_type = EXCLUDED.provider_type,
        base_url = EXCLUDED.base_url,
        owner_default = EXCLUDED.owner_default,
        auth_type = EXCLUDED.auth_type,
        secret_ref = EXCLUDED.secret_ref,
        is_active = TRUE,
        updated_at = NOW()
      RETURNING *
      `,
      [params.name, params.providerType, params.baseUrl, params.ownerDefault, params.authType, params.secretRef]
    );

    const first = rows[0];
    if (first === undefined) {
      throw new Error("Failed to persist provider");
    }

    return first;
  }

  async findByName(name: string): Promise<GitProviderRow | null> {
    const rows = await this.db.query<GitProviderRow>(
      "SELECT * FROM git_providers WHERE name = $1 AND is_active = TRUE LIMIT 1",
      [name]
    );

    return rows[0] ?? null;
  }
}

export class GitSyncJobRepository {
  private readonly db: DatabaseClient;

  constructor(db: DatabaseClient) {
    this.db = db;
  }

  async create(params: {
    sourceProviderId: number;
    targetProviderId: number;
    sourceRepo: string;
    targetRepo: string;
    mode: GitMirrorModeSchema;
    requestedBy: string;
  }): Promise<GitSyncJobRow> {
    const rows = await this.db.query<GitSyncJobRow>(
      `
      INSERT INTO git_sync_jobs (
        source_provider_id, target_provider_id, source_repo, target_repo, mode,
        status, requested_by, started_at
      ) VALUES ($1, $2, $3, $4, $5, 'running', $6, NOW())
      RETURNING *
      `,
      [params.sourceProviderId, params.targetProviderId, params.sourceRepo, params.targetRepo, params.mode, params.requestedBy]
    );

    const first = rows[0];
    if (first === undefined) {
      throw new Error("Failed to create sync job");
    }

    return first;
  }

  async finish(jobId: number, status: GitSyncJobStatus, result: Record<string, unknown>): Promise<void> {
    await this.db.query(
      `
      UPDATE git_sync_jobs
      SET status = $1, ended_at = NOW(), result_json = $2::jsonb
      WHERE id = $3
      `,
      [status, JSON.stringify(result), jobId]
    );
  }
}

export class GitAuditLogRepository {
  private readonly db: DatabaseClient;

  constructor(db: DatabaseClient) {
    this.db = db;
  }

  async create(params: {
    toolName: string;
    action: string;
    status: string;
    message: string;
    context: Record<string, unknown>;
  }): Promise<void> {
    await this.db.query(
      `
      INSERT INTO git_audit_logs (tool_name, action, status, message, context_json, created_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
      `,
      [params.toolName, params.action, params.status, params.message, JSON.stringify(params.context)]
    );
  }

  async list(limit: number): Promise<Array<GitAuditLogRow>> {
    const rows = await this.db.query<GitAuditLogRow>(
      `
      SELECT id, tool_name, action, status, message, context_json, created_at
      FROM git_audit_logs
      ORDER BY created_at DESC
      LIMIT $1
      `,
      [limit]
    );

    return rows.map((row) => ({
      ...row,
      context_json: parseJson(row.context_json as JsonLike),
    }));
  }
}
