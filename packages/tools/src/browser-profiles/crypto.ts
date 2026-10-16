// The browser-profile cipher (ANY-90 T12). The same master key the vault
// uses, but this card's own helper: AES-256-GCM with the key HKDF-SHA256-
// derived under info `fabric-browser-profile-v1`, a fresh 12-byte nonce that
// leads the file, and the AAD `browser-profile:<workspace>:<user>:<version>`
// binding each blob to its row so a swapped or foreign file fails to decrypt.
// The auth tag closes the file. Everything streams: tar goes in one side,
// ciphertext out the other; a whole profile is never buffered.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, type DecipherGCM } from "node:crypto";
import { Readable } from "node:stream";

const HKDF_INFO = Buffer.from("fabric-browser-profile-v1", "utf8");
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function derivedKey(masterKey: Uint8Array): Buffer {
  return Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), HKDF_INFO, KEY_BYTES));
}

/** The additional authenticated data binding a blob to its row. */
export function profileAad(workspaceId: string, userId: string, version: number): Buffer {
  return Buffer.from(`browser-profile:${workspaceId}:${userId}:${version}`, "utf8");
}

/** Encrypts `source` into the on-disk layout `[nonce | ciphertext | tag]`. */
export function encryptProfileStream(
  masterKey: Uint8Array,
  aad: Buffer,
  source: AsyncIterable<Buffer>
): Readable {
  const key = derivedKey(masterKey);
  return Readable.from(
    (async function* () {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aad);
      yield nonce;
      for await (const chunk of source) {
        if (chunk.byteLength > 0) yield cipher.update(chunk);
      }
      yield cipher.final();
      yield cipher.getAuthTag();
    })()
  );
}

/** Decrypts the `[nonce | ... | tag]` layout back to plaintext chunks. The
 * last TAG_BYTES bytes are withheld until the stream ends, then verified as
 * the auth tag; a wrong key or AAD fails at final(). */
export function decryptProfileStream(masterKey: Uint8Array, aad: Buffer, source: AsyncIterable<Buffer>): Readable {
  const key = derivedKey(masterKey);
  return Readable.from(
    (async function* () {
      let decipher: DecipherGCM | null = null;
      let pending = Buffer.alloc(0);
      for await (const chunk of source) {
        let buffer = Buffer.concat([pending, chunk]);
        if (decipher === null) {
          if (buffer.byteLength < NONCE_BYTES) {
            pending = buffer;
            continue;
          }
          decipher = createDecipheriv("aes-256-gcm", key, buffer.subarray(0, NONCE_BYTES), {
            authTagLength: TAG_BYTES,
          });
          decipher.setAAD(aad);
          buffer = buffer.subarray(NONCE_BYTES);
        }
        if (buffer.byteLength > TAG_BYTES) {
          const cut = buffer.byteLength - TAG_BYTES;
          yield decipher.update(buffer.subarray(0, cut));
          pending = buffer.subarray(cut);
        } else {
          pending = buffer;
        }
      }
      if (decipher === null) throw new Error("browser profile: encrypted profile is truncated");
      if (pending.byteLength !== TAG_BYTES) {
        throw new Error("browser profile: encrypted profile is truncated (no auth tag)");
      }
      decipher.setAuthTag(pending);
      const tail = decipher.final();
      if (tail.byteLength > 0) yield tail;
    })()
  );
}
