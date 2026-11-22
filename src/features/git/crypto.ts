import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * At-rest sealing for Git provider tokens.
 *
 * A user-to-server token opens pull requests as the user, so a leaked database row
 * must not be enough to use it. Tokens are sealed with AES-256-GCM under a key that
 * lives only in the deployment environment, and the sealed form is what the shared
 * database stores. No key, no storage: `sealToken` throws rather than falling back
 * to plaintext, because a silent downgrade is exactly the failure this exists to
 * prevent.
 *
 * Format: `v1.<iv>.<ciphertext>.<tag>`, every part base64url. The version prefix is
 * so a future key rotation or algorithm change can tell old rows from new.
 */

const VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;

/** Decode the deployment key: 32 bytes, base64 (standard or url-safe). Null when unset. */
export function encryptionKeyFromEnv(raw = process.env.GIT_TOKEN_ENCRYPTION_KEY): Buffer | null {
  const value = raw?.trim();
  if (!value) return null;
  const key = Buffer.from(value, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `GIT_TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}); generate one with \`openssl rand -base64 32\``,
    );
  }
  return key;
}

export function sealToken(plain: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, ciphertext, tag].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

/** Open a sealed token. Throws on a wrong key, a tampered value or an unknown format. */
export function openToken(sealed: string, key: Buffer): string {
  const [version, iv, ciphertext, tag] = sealed.split(".");
  if (version !== VERSION || !iv || !ciphertext || !tag) {
    throw new Error("sealed token is not in a recognised format");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}
