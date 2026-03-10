import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { JarvisGitBridgeError } from "../services/errors.js";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type EncryptedPayload = {
  ciphertext: string;
  keyVersion: string;
};

type SerializedCiphertext = {
  v: 1;
  iv: string;
  ct: string;
  tag: string;
};

export class AesGcmCryptoService {
  private readonly masterKey: Buffer;
  private readonly keyVersion: string;

  constructor(masterKey: Buffer, keyVersion = "v1") {
    if (masterKey.byteLength !== 32) {
      throw new JarvisGitBridgeError("MASTER_KEY_INVALID", "Master key must be 32 bytes");
    }

    this.masterKey = masterKey;
    this.keyVersion = keyVersion;
  }

  encrypt(secretValue: string): EncryptedPayload {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.masterKey, iv, { authTagLength: TAG_BYTES });
    const encrypted = Buffer.concat([cipher.update(secretValue, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();

    const payload: SerializedCiphertext = {
      v: 1,
      iv: iv.toString("base64"),
      ct: encrypted.toString("base64"),
      tag: tag.toString("base64"),
    };

    return {
      ciphertext: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
      keyVersion: this.keyVersion,
    };
  }

  decrypt(ciphertext: string): string {
    let decodedPayload: SerializedCiphertext;
    try {
      const decoded = Buffer.from(ciphertext, "base64").toString("utf8");
      decodedPayload = JSON.parse(decoded) as SerializedCiphertext;
    } catch {
      throw new JarvisGitBridgeError("SECRET_DECRYPT_ERROR", "Failed to decrypt secret");
    }

    if (decodedPayload.v !== 1) {
      throw new JarvisGitBridgeError("SECRET_DECRYPT_ERROR", "Failed to decrypt secret");
    }

    try {
      const iv = Buffer.from(decodedPayload.iv, "base64");
      const encrypted = Buffer.from(decodedPayload.ct, "base64");
      const tag = Buffer.from(decodedPayload.tag, "base64");
      const decipher = createDecipheriv(ALGORITHM, this.masterKey, iv, { authTagLength: TAG_BYTES });
      decipher.setAuthTag(tag);
      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      return decrypted.toString("utf8");
    } catch {
      throw new JarvisGitBridgeError("SECRET_DECRYPT_ERROR", "Failed to decrypt secret");
    }
  }
}
