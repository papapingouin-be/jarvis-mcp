import { AesGcmCryptoService } from "../crypto/aes-gcm.js";
import { loadMasterKeyFromEnv } from "../crypto/master-key.js";
import { createDatabaseClientFromEnv } from "../db/database.js";
import {
  GitAuditLogRepository,
  GitProviderRepository,
  GitSecretRepository,
  GitSyncJobRepository,
  runJarvisGitBridgeMigrations,
} from "../db/repositories.js";
import { AuditLogService } from "./audit-log-service.js";
import { JarvisGitBridgeService } from "./bridge-service.js";
import { JarvisGitBridgeError } from "./errors.js";
import { GitService } from "./git-service.js";
import { ProviderService } from "./provider-service.js";
import { SecretStoreService } from "./secret-store.js";

type SecretStoreLike = Pick<SecretStoreService, "store" | "getDecryptedSecret" | "markTested">;

class UnavailableSecretStore implements SecretStoreLike {
  async store(_params: {
    secretName: string;
    secretType: "pat" | "ssh_private_key" | "basic_password";
    secretValue: string;
  }): Promise<never> {
    throw new JarvisGitBridgeError(
      "MASTER_KEY_MISSING",
      "Master key is required through MASTER_KEY_FILE or MASTER_KEY"
    );
  }

  async getDecryptedSecret(_secretRef: string): Promise<never> {
    throw new JarvisGitBridgeError(
      "MASTER_KEY_MISSING",
      "Master key is required through MASTER_KEY_FILE or MASTER_KEY"
    );
  }

  async markTested(_secretRef: string): Promise<never> {
    throw new JarvisGitBridgeError(
      "MASTER_KEY_MISSING",
      "Master key is required through MASTER_KEY_FILE or MASTER_KEY"
    );
  }
}

let runtimePromise: Promise<JarvisGitBridgeService> | null = null;

async function createRuntime(): Promise<JarvisGitBridgeService> {
  const db = await createDatabaseClientFromEnv();
  await runJarvisGitBridgeMigrations(db);

  const providerRepo = new GitProviderRepository(db);
  const secretRepo = new GitSecretRepository(db);
  const syncJobs = new GitSyncJobRepository(db);
  const auditRepo = new GitAuditLogRepository(db);

  const providerService = new ProviderService(providerRepo);
  const auditLog = new AuditLogService(auditRepo);
  const gitService = new GitService();

  let secretStore: SecretStoreLike = new UnavailableSecretStore();
  try {
    const masterKey = await loadMasterKeyFromEnv();
    const crypto = new AesGcmCryptoService(masterKey);
    secretStore = new SecretStoreService(secretRepo, crypto);
  } catch (error: unknown) {
    if (!(error instanceof JarvisGitBridgeError) || error.code !== "MASTER_KEY_MISSING") {
      throw error;
    }
  }

  return new JarvisGitBridgeService({
    providerService,
    secretStore,
    gitService,
    auditLog,
    syncJobs,
  });
}

export function getJarvisGitBridgeService(): Promise<JarvisGitBridgeService> {
  if (runtimePromise === null) {
    runtimePromise = createRuntime();
  }

  return runtimePromise;
}
