import assert from "node:assert";
import { describe, it } from "node:test";
import { Buffer } from "node:buffer";
import { AesGcmCryptoService } from "../src/modules/jarvis_git_bridge/crypto/aes-gcm.ts";

describe("jarvis_git_bridge crypto", () => {
  it("encrypts then decrypts value", () => {
    const key = Buffer.alloc(32, 7);
    const crypto = new AesGcmCryptoService(key);

    const encrypted = crypto.encrypt("super-secret");
    assert.notStrictEqual(encrypted.ciphertext, "super-secret");

    const decrypted = crypto.decrypt(encrypted.ciphertext);
    assert.strictEqual(decrypted, "super-secret");
  });

  it("fails on tampered ciphertext", () => {
    const key = Buffer.alloc(32, 9);
    const crypto = new AesGcmCryptoService(key);

    const encrypted = crypto.encrypt("abc123");
    const tampered = `${encrypted.ciphertext.slice(0, -2)}AA`;

    assert.throws(() => {
      crypto.decrypt(tampered);
    });
  });
});
