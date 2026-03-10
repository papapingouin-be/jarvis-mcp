import type { AesGcmCryptoService } from "../crypto/aes-gcm.js";
import type { GitSecretRepository } from "../db/repositories.js";
import { JarvisGitBridgeError } from "./errors.js";

export class SecretStoreService {
  private readonly repository: GitSecretRepository;
  private readonly crypto: AesGcmCryptoService;

  constructor(repository: GitSecretRepository, crypto: AesGcmCryptoService) {
    this.repository = repository;
    this.crypto = crypto;
  }

  async store(params: {
    secretName: string;
    secretType: "pat" | "ssh_private_key" | "basic_password";
    secretValue: string;
  }): Promise<{ secretRef: string; status: "stored" }> {
    const encrypted = this.crypto.encrypt(params.secretValue);

    await this.repository.upsert({
      secretName: params.secretName,
      secretType: params.secretType,
      ciphertext: encrypted.ciphertext,
      keyVersion: encrypted.keyVersion,
    });

    return {
      secretRef: params.secretName,
      status: "stored",
    };
  }

  async getDecryptedSecret(secretRef: string): Promise<{ secretType: string; secretValue: string }> {
    const secret = await this.repository.findByRef(secretRef);
    if (secret === null) {
      throw new JarvisGitBridgeError("SECRET_NOT_FOUND", "Secret not found");
    }

    const secretValue = this.crypto.decrypt(secret.ciphertext);
    return {
      secretType: secret.secret_type,
      secretValue,
    };
  }

  async markTested(secretRef: string): Promise<void> {
    await this.repository.markTested(secretRef);
  }
}
