// The master-key file (ANY-44 T4, D4) for local and self-hosted servers: a
// 32-byte key created with mode 0600 on first read. On POSIX, a mode broader
// than 0600 or a length other than 32 bytes is an error, never a silent
// downgrade — the key encrypts every secret in the table.
import { randomBytes } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";

const KEY_BYTES = 32;
const KEY_MODE = 0o600;

function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

/** Reads the key file, creating it (32 random bytes, 0600) when missing. */
export async function loadOrCreateMasterKey(filePath: string): Promise<Buffer> {
  try {
    const info = await stat(filePath);
    if (process.platform !== "win32" && (info.mode & 0o777 & ~KEY_MODE) !== 0) {
      throw new Error(
        `master key ${filePath} has mode ${(info.mode & 0o777).toString(8)}, broader than 0600`
      );
    }
    const key = await readFile(filePath);
    if (key.length !== KEY_BYTES) {
      throw new Error(`master key ${filePath} is ${key.length} bytes, expected ${KEY_BYTES}`);
    }
    return key;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      const key = randomBytes(KEY_BYTES);
      await writeFile(filePath, key, { mode: KEY_MODE });
      return key;
    }
    throw error;
  }
}
