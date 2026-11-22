import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Constant-time string equality, for comparing a presented secret or signature
 * against the expected one.
 *
 * Both sides are hashed first, so the compare always runs over two 32-byte
 * digests: it leaks neither content nor length, and `timingSafeEqual` never sees
 * buffers of different byte length — which it THROWS on, and which a multi-byte
 * character produces even when the two strings' `.length`s agree.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}
