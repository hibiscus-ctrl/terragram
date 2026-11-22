/**
 * Pure-logic self-tests for the network-free commercialization seams: the
 * evidence-bundle hash + Ed25519 signature, the managed-model proxy mint, and the
 * rate limiter. Run with:
 *
 *   npm run test:cloud
 *
 * No DB, no network.
 */
import { createHmac, generateKeyPairSync, verify } from "node:crypto";

import { buildEvidenceBundle, signEvidenceBundle } from "../src/features/api/evidence.ts";
import { isModelProxyConfigured, mintProxyToken } from "../src/features/billing/proxy.ts";
import { rateLimit, retryAfterLabel } from "../src/libs/rate-limit.ts";

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

// --- evidence bundle -----------------------------------------------------
console.log("evidence");
const baseInput = {
  org: "acme",
  residencyRegion: "eu-west-2",
  generatedAt: "2026-06-14T00:00:00.000Z",
  framework: {
    id: "cyber-essentials",
    name: "Cyber Essentials",
    authority: "NCSC",
    revision: "v3.1",
  },
  crosswalkVersion: "2026.06",
  repositories: ["acme/platform-core"],
  controls: [
    { id: "A1.2", name: "Default-deny ingress", verdict: "fail" as const, evidence: [] },
    { id: "A2.1", name: "Encryption at rest", verdict: "pass" as const, evidence: [] },
  ],
};
const b1 = buildEvidenceBundle(baseInput);
const b2 = buildEvidenceBundle(baseInput);
check("bundle schema is terragram.evidence/v1", b1.schema === "terragram.evidence/v1");
check(
  "bundle is immutable + date-stamped",
  b1.immutable === true && b1.generated_at === baseInput.generatedAt,
);
check("content_hash is sha256-prefixed", /^sha256:[0-9a-f]{64}$/.test(b1.content_hash));
check("hash is deterministic for identical input", b1.content_hash === b2.content_hash);
check("summary counts verdicts", b1.summary.fail === 1 && b1.summary.pass === 1);
const b3 = buildEvidenceBundle({
  ...baseInput,
  controls: [{ ...baseInput.controls[0], verdict: "pass" as const }, baseInput.controls[1]],
});
check("hash changes when a verdict changes", b1.content_hash !== b3.content_hash);

// --- evidence signature --------------------------------------------------
const { publicKey: edPub, privateKey: edPriv } = generateKeyPairSync("ed25519");
const signed = signEvidenceBundle(b1, {
  privateKey: edPriv,
  keyId: "k1",
  signedAt: baseInput.generatedAt,
});
check(
  "signature is ed25519 with the key id",
  signed.signature?.algorithm === "ed25519" && signed.signature?.key_id === "k1",
);
check(
  "detached signature verifies against the content_hash",
  signed.signature !== undefined &&
    verify(
      null,
      Buffer.from(signed.content_hash),
      edPub,
      Buffer.from(signed.signature.signature, "base64"),
    ),
);
check(
  "a tampered content_hash fails verification",
  signed.signature !== undefined &&
    !verify(
      null,
      Buffer.from(`${signed.content_hash}0`),
      edPub,
      Buffer.from(signed.signature.signature, "base64"),
    ),
);

// --- model proxy ---------------------------------------------------------
console.log("proxy");
check("isModelProxyConfigured false when unset", !isModelProxyConfigured());
process.env.TERRAGRAM_MODEL_PROXY_URL = "https://eu-proxy.example";
process.env.TERRAGRAM_MODEL_PROXY_SECRET = "proxy-secret-xyz";
check("isModelProxyConfigured true when set", isModelProxyConfigured());
const px = mintProxyToken("org-123", "claude-haiku-4-5");
check("proxy token has tmpx_ prefix", px.token.startsWith("tmpx_"));
const [pxPayload, pxSig] = px.token.slice("tmpx_".length).split(".");
check(
  "proxy token HMAC verifies",
  pxSig === createHmac("sha256", "proxy-secret-xyz").update(pxPayload).digest("base64url"),
);
check("proxy token expires ~1h out", new Date(px.expires_at).getTime() - Date.now() > 3_000_000);
check("proxy endpoint echoed", px.endpoint === "https://eu-proxy.example");

// --- rate limiter --------------------------------------------------------
console.log("rate limit");
let allowed = 0;
for (let i = 0; i < 5; i++) {
  if ((await rateLimit("rl-a", { limit: 3, windowMs: 60_000 })).ok) allowed++;
}
check("allows exactly up to the limit", allowed === 3);
const blocked = await rateLimit("rl-a", { limit: 3, windowMs: 60_000 });
check("blocks past the limit with retryAfterMs", !blocked.ok && (blocked.retryAfterMs ?? 0) > 0);
check(
  "distinct keys have independent budgets",
  (await rateLimit("rl-b", { limit: 1, windowMs: 60_000 })).ok,
);
check("a fresh window key is allowed", (await rateLimit("rl-c", { limit: 1, windowMs: 1 })).ok);
check("retryAfterLabel formats minutes", retryAfterLabel(120_000) === "2 minutes");
check('retryAfterLabel floors to "a minute"', retryAfterLabel(5_000) === "a minute");

// --- result --------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
