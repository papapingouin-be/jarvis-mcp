import type { GitAuthTypeSchema } from "../types/type-tags.js";
import type {
  CompareRefsResult,
  MirrorResult,
  RegisterProviderResult,
  StoreSecretResult,
  TestConnectionResult,
} from "../types/domain.js";
import type { GitSyncJobRepository } from "../db/repositories.js";
import { AuditLogService } from "./audit-log-service.js";
import { JarvisGitBridgeError } from "./errors.js";
import { GitService } from "./git-service.js";
import { ProviderService } from "./provider-service.js";
import { SecretStoreService } from "./secret-store.js";

type SecretStoreLike = {
  store: SecretStoreService["store"];
  getDecryptedSecret: SecretStoreService["getDecryptedSecret"];
  markTested: SecretStoreService["markTested"];
};

function expectedSecretType(authType: GitAuthTypeSchema): "pat" | "ssh_private_key" | "basic_password" {
  if (authType === "pat") {
    return "pat";
  }

  if (authType === "ssh_key") {
    return "ssh_private_key";
  }

  return "basic_password";
}

function assertSecretCompatibility(authType: GitAuthTypeSchema, secretType: string): void {
  const expected = expectedSecretType(authType);
  if (secretType !== expected) {
    throw new JarvisGitBridgeError(
      "SECRET_TYPE_MISMATCH",
      `Secret type mismatch: expected ${expected}`
    );
  }
}

export class JarvisGitBridgeService {
  private readonly providerService: ProviderService;
  private readonly secretStore: SecretStoreLike;
  private readonly gitService: GitService;
  private readonly auditLog: AuditLogService;
  private readonly syncJobs: GitSyncJobRepository;

  constructor(params: {
    providerService: ProviderService;
    secretStore: SecretStoreLike;
    gitService: GitService;
    auditLog: AuditLogService;
    syncJobs: GitSyncJobRepository;
  }) {
    this.providerService = params.providerService;
    this.secretStore = params.secretStore;
    this.gitService = params.gitService;
    this.auditLog = params.auditLog;
    this.syncJobs = params.syncJobs;
  }

  async storeSecret(params: {
    secretName: string;
    secretType: "pat" | "ssh_private_key" | "basic_password";
    secretValue: string;
  }): Promise<StoreSecretResult> {
    const stored = await this.secretStore.store(params);
    await this.auditLog.record({
      toolName: "git_store_secret",
      action: "store_secret",
      status: "ok",
      message: "Secret stored",
      context: {
        secret_name: params.secretName,
        secret_type: params.secretType,
      },
    });

    return {
      secret_ref: stored.secretRef,
      status: stored.status,
    };
  }

  async registerProvider(params: {
    name: string;
    providerType: "gitea" | "github";
    baseUrl: string;
    ownerDefault: string;
    authType: "pat" | "ssh_key" | "basic";
    secretRef: string;
  }): Promise<RegisterProviderResult> {
    const secret = await this.secretStore.getDecryptedSecret(params.secretRef);
    assertSecretCompatibility(params.authType, secret.secretType);

    const result = await this.providerService.register(params);

    await this.auditLog.record({
      toolName: "git_register_provider",
      action: "register_provider",
      status: "ok",
      message: params.authType === "basic" ? "Provider registered (legacy basic auth)" : "Provider registered",
      context: {
        provider_name: params.name,
        provider_type: params.providerType,
        auth_type: params.authType,
      },
    });

    return {
      provider_id: result.providerId,
      status: result.status,
    };
  }

  async testConnection(providerName: string): Promise<TestConnectionResult> {
    const provider = await this.providerService.requireProviderByName(providerName);
    const secret = await this.secretStore.getDecryptedSecret(provider.secret_ref);
    assertSecretCompatibility(provider.auth_type, secret.secretType);

    const result = await this.gitService.testConnection({
      provider,
      secretValue: secret.secretValue,
    });

    if (result.ok) {
      await this.secretStore.markTested(provider.secret_ref);
    }

    await this.auditLog.record({
      toolName: "git_test_connection",
      action: "test_connection",
      status: result.ok ? "ok" : "error",
      message: result.testSummary,
      context: {
        provider_name: providerName,
        auth_type: provider.auth_type,
      },
    });

    return {
      ok: result.ok,
      provider_name: providerName,
      auth_type: provider.auth_type,
      test_summary: result.testSummary,
    };
  }

  async compareRefs(params: {
    sourceProviderName: string;
    sourceRepo: string;
    targetProviderName: string;
    targetRepo: string;
  }): Promise<CompareRefsResult> {
    const sourceProvider = await this.providerService.requireProviderByName(params.sourceProviderName);
    const targetProvider = await this.providerService.requireProviderByName(params.targetProviderName);

    const sourceSecret = await this.secretStore.getDecryptedSecret(sourceProvider.secret_ref);
    const targetSecret = await this.secretStore.getDecryptedSecret(targetProvider.secret_ref);
    assertSecretCompatibility(sourceProvider.auth_type, sourceSecret.secretType);
    assertSecretCompatibility(targetProvider.auth_type, targetSecret.secretType);

    const result = await this.gitService.compareRefs({
      source: {
        provider: sourceProvider,
        secretValue: sourceSecret.secretValue,
      },
      sourceRepo: params.sourceRepo,
      target: {
        provider: targetProvider,
        secretValue: targetSecret.secretValue,
      },
      targetRepo: params.targetRepo,
    });

    await this.auditLog.record({
      toolName: "git_compare_refs",
      action: "compare_refs",
      status: "ok",
      message: result.summary,
      context: {
        source_provider: params.sourceProviderName,
        target_provider: params.targetProviderName,
      },
    });

    return result;
  }

  async mirrorRepository(params: {
    sourceProviderName: string;
    sourceRepo: string;
    targetProviderName: string;
    targetRepo: string;
    mode: "mirror" | "refs";
    createIfMissing: boolean;
  }): Promise<MirrorResult> {
    const sourceProvider = await this.providerService.requireProviderByName(params.sourceProviderName);
    const targetProvider = await this.providerService.requireProviderByName(params.targetProviderName);
    const sourceSecret = await this.secretStore.getDecryptedSecret(sourceProvider.secret_ref);
    const targetSecret = await this.secretStore.getDecryptedSecret(targetProvider.secret_ref);

    assertSecretCompatibility(sourceProvider.auth_type, sourceSecret.secretType);
    assertSecretCompatibility(targetProvider.auth_type, targetSecret.secretType);

    const syncJob = await this.syncJobs.create({
      sourceProviderId: sourceProvider.id,
      targetProviderId: targetProvider.id,
      sourceRepo: params.sourceRepo,
      targetRepo: params.targetRepo,
      mode: params.mode,
      requestedBy: "mcp:jarvis_git_bridge",
    });

    try {
      const result = await this.gitService.mirrorRepository({
        source: {
          provider: sourceProvider,
          secretValue: sourceSecret.secretValue,
        },
        sourceRepo: params.sourceRepo,
        target: {
          provider: targetProvider,
          secretValue: targetSecret.secretValue,
        },
        targetRepo: params.targetRepo,
        mode: params.mode,
        createIfMissing: params.createIfMissing,
      });

      await this.syncJobs.finish(syncJob.id, "success", result);
      await this.auditLog.record({
        toolName: "git_mirror_repo",
        action: "mirror_repo",
        status: "ok",
        message: result.summary,
        context: {
          source_provider: params.sourceProviderName,
          target_provider: params.targetProviderName,
          mode: params.mode,
          warnings: result.warnings,
        },
      });

      return result;
    } catch (error: unknown) {
      const safeError = error instanceof JarvisGitBridgeError
        ? error
        : new JarvisGitBridgeError("MIRROR_FAILED", "Mirror operation failed");

      await this.syncJobs.finish(syncJob.id, "failed", {
        code: safeError.code,
        message: safeError.safeMessage,
      });
      await this.auditLog.record({
        toolName: "git_mirror_repo",
        action: "mirror_repo",
        status: "error",
        message: safeError.safeMessage,
        context: {
          source_provider: params.sourceProviderName,
          target_provider: params.targetProviderName,
          mode: params.mode,
          error_code: safeError.code,
        },
      });

      throw safeError;
    }
  }

  async listAuditLogs(limit: number): Promise<{ entries: Array<Record<string, unknown>> }> {
    const entries = await this.auditLog.list(limit);
    return { entries };
  }
}
