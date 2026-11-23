// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { createPublicKey, type KeyObject, verify as verifySignature } from "node:crypto";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import type { BundleEntry } from "terragram-engine/receipt";
import { verifyBundle } from "terragram-engine/verify";

import { CommandError, type Io, isDirectory, isFile, listFiles, readText, UsageError } from "../io.ts";

/** The schema ids receipts carried before they were renamed to `diagram.receipt/*`.
 *  They hash and sign exactly as today's do, so they still verify; none is written. */
const LEGACY_RECEIPT_SCHEMAS = ["terragram.receipt/v1", "terragram.receipt/v2"] as const;

const VERIFY_HELP = `Usage: terragram verify <receipt.json | bundle-dir> --key <pem> [options]
       terragram verify <receipt.json | bundle-dir> --trust <file> [options]
       terragram verify <receipt.json | bundle-dir> --allow-unsigned

Check an evidence receipt offline. It is verified only when BOTH hold:
  1. the content hash recomputed from model.json and plan/ (beside the receipt)
     equals the receipt's, and
  2. the receipt's signature verifies against a public key YOU trust, and the key
     the receipt carries is that key.

The trusted key comes from outside the bundle: --key, or --trust. A key shipped inside
the bundle (signing-key.pem) is never used, because whoever can alter the bundle can
replace it. A receipt with no signature does not verify.

Options:
  --key <pem>         the signer's public key (PEM), obtained separately from the bundle
  --trust <file>      JSON object of key id -> public key PEM; the receipt's key id picks the entry
  --sig <file>        detached signature of receipt.json (default: receipt.json.sig beside it,
                      when present); checked against the trusted key
  --allow-unsigned    check the hashes only (not with --key or --trust). The result says UNSIGNED, whatever the receipt
                      claims: nothing about who produced it has been checked
  --json              print the full report as JSON
  -h, --help          show this help

Exit status: 0 verified (or hashes ok with --allow-unsigned), 1 not verified, 2 bad arguments.
`;

type Status = "pass" | "fail" | "unavailable";
type Check = { status: Status; detail: string };

function spkiBase64(key: KeyObject): string {
  return key.export({ type: "spki", format: "der" }).toString("base64");
}

function readKey(pem: string, origin: string): KeyObject {
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("not Ed25519");
    return key;
  } catch {
    throw new CommandError(`${origin} is not an Ed25519 public key in PEM form`);
  }
}

/** The key a receipt is to be judged against, from --key or --trust, never from the bundle. */
function trustedKey(io: Io, keyPath: string | undefined, trustPath: string | undefined, keyId: string | null): {
  key: KeyObject | null;
  problem: string | null;
} {
  if (keyPath !== undefined) return { key: readKey(readText(io, keyPath), keyPath), problem: null };
  if (trustPath === undefined) return { key: null, problem: null };

  let table: unknown;
  try {
    table = JSON.parse(readText(io, trustPath));
  } catch (cause) {
    if (cause instanceof CommandError) throw cause;
    throw new CommandError(`${trustPath} is not valid JSON`);
  }
  if (typeof table !== "object" || table === null || Array.isArray(table)) {
    throw new CommandError(`${trustPath} must be a JSON object of key id to public key PEM`);
  }
  if (keyId === null) return { key: null, problem: "The receipt names no key id, so the trust file cannot pick a key." };
  const pem = Object.hasOwn(table, keyId) ? (table as Record<string, unknown>)[keyId] : undefined;
  if (typeof pem !== "string") return { key: null, problem: `The receipt's key id "${keyId}" is not in ${trustPath}.` };
  return { key: readKey(pem, `${trustPath} entry "${keyId}"`), problem: null };
}

function checkSignature(bytes: string, signatureB64: string, key: KeyObject): boolean {
  try {
    return verifySignature(null, Buffer.from(bytes, "utf8"), key, Buffer.from(signatureB64.trim(), "base64"));
  } catch {
    return false;
  }
}

/** The bundle as `verifyBundle` reads it: receipt.json, and beside it model.json and plan/. */
function bundleEntries(io: Io, receiptPath: string): BundleEntry[] {
  const dir = dirname(receiptPath);
  const entries: BundleEntry[] = [{ name: "receipt.json", content: readText(io, receiptPath) }];
  const model = join(dir, "model.json");
  if (isFile(io, model)) entries.push({ name: "model.json", content: readText(io, model) });
  const plan = join(dir, "plan");
  if (isDirectory(io, plan)) {
    for (const name of listFiles(io, plan)) {
      entries.push({ name: `plan/${name}`, content: readText(io, join(plan, name)) });
    }
  }
  return entries;
}

export async function verify(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      key: { type: "string" },
      trust: { type: "string" },
      sig: { type: "string" },
      "allow-unsigned": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });
  if (values.help) {
    io.out(VERIFY_HELP);
    return 0;
  }
  const [target, ...extra] = positionals;
  if (target === undefined || extra.length > 0) {
    throw new UsageError("give exactly one receipt.json or bundle directory");
  }
  if (values.key !== undefined && values.trust !== undefined) throw new UsageError("give --key or --trust, not both");
  const allowUnsigned = values["allow-unsigned"];
  const haveTrust = values.key !== undefined || values.trust !== undefined;
  // With a trusted key, a receipt must be signed by it: stripping the signature must never
  // turn a failed check into a passing "unsigned" one.
  if (haveTrust && allowUnsigned) throw new UsageError("--allow-unsigned cannot be combined with --key or --trust");
  if (!haveTrust && !allowUnsigned) {
    throw new UsageError(
      "no trusted key: give --key <pem> or --trust <file> (a key from outside the bundle), or --allow-unsigned to check hashes only",
    );
  }
  if (values.sig !== undefined && !haveTrust) throw new UsageError("--sig needs --key or --trust to check it against");

  const receiptPath = isDirectory(io, target) ? join(target, "receipt.json") : target;
  const entries = bundleEntries(io, receiptPath);
  // The CLI judges the signature itself, against a key from outside the bundle (below), and reads
  // only the hash and the receipt from this report, so it opts out of the engine's key handling.
  const report = await verifyBundle(entries, { alsoAccept: LEGACY_RECEIPT_SCHEMAS, acceptBundledKey: true });
  if (report.error || !report.receipt) throw new CommandError(report.error ?? "receipt.json could not be read");
  const receipt = report.receipt;
  const receiptBytes = entries[0]?.content ?? "";

  const hash: Check = report.hash;
  const unsigned = !receipt.signed || !receipt.signature || !receipt.publicKey;

  // Everything below judges the signature against the trusted key and nothing else.
  let signature: Check;
  let detached: Check | null = null;
  let key: Check;
  const { key: trusted, problem } = trustedKey(io, values.key, values.trust, receipt.keyId);

  if (!haveTrust) {
    const note = unsigned ? "the receipt carries no signature" : "no trusted key was given";
    signature = { status: "unavailable", detail: `Not checked: ${note}.` };
    key = { status: "unavailable", detail: "No trusted key was given." };
  } else if (trusted === null) {
    signature = { status: "fail", detail: problem ?? "No trusted key." };
    key = { status: "fail", detail: problem ?? "No trusted key." };
  } else if (unsigned) {
    signature = { status: "fail", detail: "The receipt is UNSIGNED: there is no signature to check against the trusted key." };
    key = { status: "unavailable", detail: "The receipt carries no key." };
  } else {
    const carried = receipt.publicKey ?? "";
    key =
      carried === spkiBase64(trusted)
        ? { status: "pass", detail: `The key the receipt carries is the trusted key (key id ${receipt.keyId ?? "none"}).` }
        : { status: "fail", detail: "The key the receipt carries is NOT the trusted key." };
    signature = checkSignature(receipt.contentHash, receipt.signature ?? "", trusted)
      ? { status: "pass", detail: `The signature over the content hash verifies against the trusted key (signed ${receipt.signedAt ?? "at an unrecorded time"}).` }
      : { status: "fail", detail: "The signature over the content hash does not verify against the trusted key." };
  }

  // The detached signature over receipt.json's exact bytes: the named file, else the
  // conventional one beside the receipt. It proves nothing without the trusted key.
  const sigPath =
    values.sig ?? (isFile(io, join(dirname(receiptPath), "receipt.json.sig")) ? join(dirname(receiptPath), "receipt.json.sig") : undefined);
  if (sigPath !== undefined && trusted !== null) {
    detached = checkSignature(receiptBytes, readText(io, sigPath), trusted)
      ? { status: "pass", detail: "receipt.json's detached signature verifies against the trusted key." }
      : { status: "fail", detail: "receipt.json's detached signature does not verify against the trusted key." };
  } else if (values.sig !== undefined) {
    detached = { status: "fail", detail: "The detached signature could not be checked: no trusted key for this receipt." };
  }

  const hashOk = hash.status === "pass";
  const signedOk =
    signature.status === "pass" && key.status === "pass" && (detached === null || detached.status === "pass");
  // `unsigned` is not a pass: it says only that the hashes held. It is reachable only with
  // --allow-unsigned, which excludes a trusted key, so no signature is judged on that path.
  const unsignedTolerated = allowUnsigned && !haveTrust && hashOk;
  const finalVerdict = signedOk && hashOk ? "verified" : unsignedTolerated ? "unsigned" : "not-verified";

  const exit = finalVerdict === "not-verified" ? 1 : 0;
  if (values.json) {
    io.out(
      `${JSON.stringify({ verdict: finalVerdict, ok: exit === 0, hash, signature, key, detached, receipt }, null, 2)}\n`,
    );
    return exit;
  }

  const lines = [
    `receipt:   ${receipt.schema} (${receipt.cloud}, ${receipt.regionLabel}, ${receipt.tool})`,
    `hash:      ${hash.status}  ${hash.detail}`,
    `signature: ${signature.status}  ${signature.detail}`,
    `key:       ${key.status}  ${key.detail}`,
  ];
  if (detached) lines.push(`detached:  ${detached.status}  ${detached.detail}`);
  lines.push(
    finalVerdict === "verified"
      ? "verified"
      : finalVerdict === "unsigned"
        ? "UNSIGNED: hashes checked only (--allow-unsigned). Nothing says who produced this receipt."
        : "NOT verified",
  );
  io.out(`${lines.join("\n")}\n`);
  return exit;
}
