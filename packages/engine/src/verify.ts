// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { infraModelSchema } from "./model.ts";
import {
  type BundleEntry,
  bundlePlanFiles,
  contentHashFor,
  type EvidenceReceipt,
  planText,
  VERIFIABLE_RECEIPT_SCHEMAS,
} from "./receipt.ts";

/**
 * Offline bundle verification.
 *
 * Runs on WebCrypto: recompute the hash from the model and plan in the bundle,
 * compare it to the receipt, then check the Ed25519 signature against a public key
 * the caller trusts (`trustedKeys`). Nothing here contacts Terragram, which is the
 * only way the claim "an auditor can check this without us" is actually true. A key
 * carried inside the bundle proves nothing by itself: whoever can alter the bundle can
 * replace it, so without a trusted key the result is never `ok`, unless the caller
 * says `acceptBundledKey`.
 */

type VerifyStatus = "pass" | "fail" | "unavailable";

export type VerifyReport = {
  /** Overall: true only when the hash matches and the signature verifies against a
   *  trusted key (or, with `acceptBundledKey`, the bundle's own key or no signature). */
  ok: boolean;
  hash: { status: VerifyStatus; expected: string; actual: string; detail: string };
  signature: { status: VerifyStatus; detail: string };
  receipt: EvidenceReceipt | null;
  /** Why the bundle could not be read at all. */
  error?: string;
};

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Constant-time-ish comparison. Hashes are public, but the habit is worth keeping. */
function equalStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function failure(error: string): VerifyReport {
  return {
    ok: false,
    hash: { status: "fail", expected: "", actual: "", detail: error },
    signature: { status: "unavailable", detail: "Not checked — the bundle could not be read." },
    receipt: null,
    error,
  };
}

/** A plan file name that stays inside plan/: relative, with no empty or `..` segment and no backslash. */
function isSafePlanName(name: string): boolean {
  if (name === "" || name.startsWith("/") || name.includes("\\")) return false;
  return name.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/**
 * Why the entries cannot be read as one bundle, or null when they can. Each file is
 * matched by its exact name, so a look-alike such as `old-receipt.json` is never read
 * in place of `receipt.json`; and a name that appears twice is refused, since the host
 * showing the bundle and this check could otherwise each pick a different copy. Plan
 * files may sit in sub-folders (a function's handler is `plan/src/<slug>/<file>`), but a
 * name must stay inside plan/ and, when the receipt records its plan files, be one of
 * them: a file the hash does not cover is a file nobody vouched for.
 */
function ambiguousEntry(entries: readonly BundleEntry[]): string | null {
  const seen = new Set<string>();
  for (const { name } of entries) {
    if (seen.has(name)) return `The bundle holds more than one ${name}.`;
    seen.add(name);
    if (name.startsWith("plan/") && !isSafePlanName(name.slice("plan/".length))) {
      return `The bundle's plan file name is not allowed: ${name}.`;
    }
  }
  return null;
}

/** The first field a verifiable receipt must carry that this one lacks or holds in the wrong shape. */
function malformedField(receipt: Partial<Record<keyof EvidenceReceipt, unknown>>): string | null {
  if (typeof receipt.cloud !== "string") return "cloud";
  if (typeof receipt.contentHash !== "string") return "contentHash";
  if (!Array.isArray(receipt.plan) || !receipt.plan.every((name) => typeof name === "string")) return "plan";
  return null;
}

/** A plan file the receipt does not record, which the content hash would not cover. */
function unrecordedPlanFile(entries: readonly BundleEntry[], recorded: readonly string[]): string | null {
  const extra = entries.find((e) => e.name.startsWith("plan/") && !recorded.includes(e.name.slice("plan/".length)));
  return extra ? `The bundle's plan file ${extra.name} is not one the receipt records.` : null;
}

/** A public key as base64 SPKI, from either that or a PEM block. */
function spkiOf(key: string): string {
  return key.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "");
}

/** What `verifyBundle` accepts beyond the entries. */
export type VerifyOptions = {
  alsoAccept?: readonly string[];
  trustedKeys?: readonly string[];
  acceptBundledKey?: boolean;
};

/**
 * Verify a bundle's entries. `entries` is whatever the reader dropped in: the files
 * from the zip, named relative to the bundle (`receipt.json`, `model.json`,
 * `plan/main.tf`), or a pasted `receipt.json` on its own (in which case the hash cannot
 * be recomputed and we say so rather than reporting a pass). `alsoAccept` names receipt
 * schema ids beyond this build's own that the caller still trusts, such as an older
 * schema name its receipts were written under. `trustedKeys` are the signer public keys
 * (base64 SPKI, as the receipt carries them, or PEM) the caller obtained apart from the
 * bundle: the signature must verify against one of them, and the receipt must carry it.
 * With none, the result is not `ok` unless `acceptBundledKey` is set, which falls back
 * to checking the signature against the key the bundle carries (that proves integrity
 * against accident, not who signed) and lets an unsigned receipt pass on its hash.
 */
export async function verifyBundle(entries: BundleEntry[], options: VerifyOptions = {}): Promise<VerifyReport> {
  const ambiguous = ambiguousEntry(entries);
  if (ambiguous) return failure(ambiguous);
  const receiptEntry = entries.find((e) => e.name === "receipt.json");
  if (!receiptEntry) return failure("No receipt.json found in what you provided.");

  let receipt: EvidenceReceipt;
  try {
    receipt = JSON.parse(receiptEntry.content) as EvidenceReceipt;
  } catch {
    return failure("receipt.json is not valid JSON.");
  }
  if (typeof receipt !== "object" || receipt === null) return failure("receipt.json is not a receipt.");
  // Older receipts still verify: the schema grew a provenance section, but the
  // bytes it hashes and the way it signs them never changed.
  const schema = receipt?.schema as string;
  if (!VERIFIABLE_RECEIPT_SCHEMAS.includes(schema) && !(options.alsoAccept ?? []).includes(schema)) {
    return failure(`Unrecognised receipt schema: ${String(receipt?.schema ?? "missing")}.`);
  }
  const malformed = malformedField(receipt);
  if (malformed) return failure(`receipt.json has no usable ${malformed}.`);
  const unrecorded = unrecordedPlanFile(entries, receipt.plan);
  if (unrecorded) return failure(unrecorded);

  /* ------------------------------------------------------------------ hash -- */

  const modelEntry = entries.find((e) => e.name === "model.json");
  const planFiles = bundlePlanFiles(entries);
  let hash: VerifyReport["hash"];

  if (!modelEntry || planFiles.length === 0) {
    hash = {
      status: "unavailable",
      expected: receipt.contentHash,
      actual: "",
      detail:
        "The receipt alone cannot be hash-checked. Provide the whole bundle — model.json and the plan/ files — to confirm the content hash.",
    };
  } else {
    let modelJson: unknown;
    try {
      modelJson = JSON.parse(modelEntry.content);
    } catch {
      return failure("model.json is not valid JSON.");
    }
    const parsed = infraModelSchema.safeParse(modelJson);
    if (!parsed.success) {
      hash = {
        status: "fail",
        expected: receipt.contentHash,
        actual: "",
        detail: "model.json does not match the model schema.",
      };
    } else {
      const actual = await contentHashFor({
        model: parsed.data,
        cloud: receipt.cloud,
        planText: planText(planFiles, receipt.plan),
      });
      const match = equalStrings(actual, receipt.contentHash);
      hash = {
        status: match ? "pass" : "fail",
        expected: receipt.contentHash,
        actual,
        detail: match
          ? "The model and plan in this bundle hash to exactly the value the receipt records."
          : "The bundle's contents do not hash to the receipt's value — the model or plan has changed since it was approved.",
      };
    }
  }

  /* ------------------------------------------------------------- signature -- */

  const trusted = (options.trustedKeys ?? []).map(spkiOf);
  const requireTrusted = trusted.length > 0;
  let signature: VerifyReport["signature"];
  if (!receipt.signature || !receipt.publicKey) {
    signature = receipt.signed
      ? {
          status: "fail",
          detail: "The receipt claims to be signed but carries no signature or key, so there is nothing to check.",
        }
      : requireTrusted
        ? { status: "fail", detail: "This receipt is unsigned, but a signature from a trusted key was required." }
        : {
            status: "unavailable",
            detail:
              "This receipt is unsigned. The content hash still proves the bundle is unaltered; a signature would also prove who produced it.",
          };
  } else if (!requireTrusted && !options.acceptBundledKey) {
    signature = {
      status: "unavailable",
      detail:
        "No trusted key was given, so the signature was not checked: a key carried in the bundle proves nothing about who signed it.",
    };
  } else if (requireTrusted && !trusted.includes(spkiOf(receipt.publicKey))) {
    signature = { status: "fail", detail: "The key this receipt carries is not one of the trusted keys." };
  } else {
    try {
      const key = await globalThis.crypto.subtle.importKey(
        "spki",
        decodeBase64(spkiOf(receipt.publicKey)),
        { name: "Ed25519" },
        false,
        ["verify"],
      );
      const valid = await globalThis.crypto.subtle.verify(
        { name: "Ed25519" },
        key,
        decodeBase64(receipt.signature),
        new TextEncoder().encode(receipt.contentHash),
      );
      const by = `key ${receipt.keyId ?? "unknown"} on ${receipt.signedAt ?? "an unrecorded date"}`;
      signature = {
        status: valid ? "pass" : "fail",
        detail: !valid
          ? requireTrusted
            ? "The signature does not verify against the trusted key."
            : "The signature does not verify against the key in this bundle."
          : requireTrusted
            ? `Signed by trusted ${by}.`
            : `Signed by ${by}; the key came from the bundle itself and was not independently trusted.`,
      };
    } catch {
      signature = {
        status: "unavailable",
        detail:
          "This runtime cannot check Ed25519 signatures. The content hash result above still stands; try a current Node, Chrome, Firefox or Safari to check the signature.",
      };
    }
  }

  // With trusted keys the signature must pass. Without, the caller has said to go by the
  // hash and the bundle's own signature, or the result cannot be ok at all.
  const signatureOk = requireTrusted ? signature.status === "pass" : options.acceptBundledKey === true && signature.status !== "fail";
  return {
    ok: hash.status === "pass" && signatureOk,
    hash,
    signature,
    receipt,
  };
}

/** Read a dropped .zip bundle's text entries. Store-only, matching what we write. */
export async function readBundleZip(file: File): Promise<BundleEntry[]> {
  const data = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const decoder = new TextDecoder();
  const entries: BundleEntry[] = [];

  // Walk local file headers. Our writer stores every entry uncompressed, so an
  // entry's bytes are its contents; anything compressed is reported, not guessed at.
  let offset = 0;
  while (offset + 30 <= data.length && view.getUint32(offset, true) === 0x04034b50) {
    const method = view.getUint16(offset + 8, true);
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = decoder.decode(data.subarray(nameStart, nameStart + nameLength));
    const contentStart = nameStart + nameLength + extraLength;
    if (method !== 0) throw new Error(`${name} is compressed — export the bundle again.`);
    entries.push({
      name,
      content: decoder.decode(data.subarray(contentStart, contentStart + size)),
    });
    offset = contentStart + size;
  }

  const files = entries.filter((e) => !e.name.endsWith("/"));
  if (files.length === 0) throw new Error("That file does not look like an evidence bundle.");
  return withoutSharedRoot(files);
}

/**
 * A bundle zipped from its folder holds `bundle/receipt.json` rather than
 * `receipt.json`. When every entry sits under the same one folder, that folder is
 * dropped so the names are relative to the bundle, as `verifyBundle` reads them;
 * anything else is left as it is, for `verifyBundle` to accept or refuse by name.
 */
function withoutSharedRoot(entries: BundleEntry[]): BundleEntry[] {
  const roots = new Set(entries.map((e) => (e.name.includes("/") ? e.name.slice(0, e.name.indexOf("/")) : "")));
  const [root] = roots;
  if (roots.size !== 1 || !root) return entries;
  return entries.map((e) => ({ ...e, name: e.name.slice(root.length + 1) }));
}
