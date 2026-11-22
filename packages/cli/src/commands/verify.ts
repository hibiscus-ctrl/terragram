// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { createPublicKey, verify as verifySignature } from "node:crypto";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

import type { BundleEntry } from "terragram-engine/receipt";
import { verifyBundle, type VerifyReport } from "terragram-engine/verify";

import { CommandError, type Io, isDirectory, isFile, listFiles, readText, UsageError } from "../io.ts";

const VERIFY_HELP = `Usage: terragram verify <receipt.json | bundle-dir> [--sig <file> --key <pem>] [options]

Check an evidence receipt offline. With the bundle beside it (model.json and plan/),
the content hash is recomputed from them and compared with the receipt's; the
signature inside the receipt is checked against the key the receipt carries.

--sig and --key add the detached signature over receipt.json's exact bytes, checked
against a public key you hold. When receipt.json.sig and signing-key.pem sit beside
the receipt they are used without being named.

Exit status: 0 verified, 1 not verified (or unreadable), 2 bad arguments.

Options:
  --sig <file>   detached signature of receipt.json (base64)
  --key <pem>    the signer's public key, PEM
  --json         print the full report as JSON
  -h, --help     show this help
`;

type Detached = { status: "pass" | "fail" | "unavailable"; detail: string };

function detachedSignature(receiptBytes: string, signature: string, keyPem: string): Detached {
  try {
    const ok = verifySignature(
      null,
      Buffer.from(receiptBytes, "utf8"),
      createPublicKey(keyPem),
      Buffer.from(signature.trim(), "base64"),
    );
    return ok
      ? { status: "pass", detail: "The detached signature verifies over receipt.json against the key given." }
      : { status: "fail", detail: "The detached signature does not verify over receipt.json against the key given." };
  } catch {
    return { status: "fail", detail: "The detached signature or the key could not be read." };
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

function describe(report: VerifyReport, detached: Detached | null, keyNote: string | null): string {
  const lines = [
    report.receipt
      ? `receipt:   ${report.receipt.schema} (${report.receipt.cloud}, ${report.receipt.regionLabel}, ${report.receipt.tool})`
      : "receipt:   unreadable",
    `hash:      ${report.hash.status}  ${report.hash.detail}`,
    `signature: ${report.signature.status}  ${report.signature.detail}`,
  ];
  if (detached) lines.push(`detached:  ${detached.status}  ${detached.detail}`);
  if (keyNote) lines.push(`key:       fail  ${keyNote}`);
  return `${lines.join("\n")}\n`;
}

export async function verify(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      sig: { type: "string" },
      key: { type: "string" },
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
  if (target === undefined || extra.length > 0) throw new UsageError("give exactly one receipt.json or bundle directory");
  if ((values.sig === undefined) !== (values.key === undefined)) {
    throw new UsageError("--sig and --key go together");
  }

  const receiptPath = isDirectory(io, target) ? join(target, "receipt.json") : target;
  const entries = bundleEntries(io, receiptPath);
  const report = await verifyBundle(entries);
  if (report.error) throw new CommandError(report.error);

  const beside = (name: string) => join(dirname(receiptPath), name);
  const sigPath = values.sig ?? (isFile(io, beside("receipt.json.sig")) ? beside("receipt.json.sig") : undefined);
  const keyPath = values.key ?? (isFile(io, beside("signing-key.pem")) ? beside("signing-key.pem") : undefined);

  let detached: Detached | null = null;
  let keyNote: string | null = null;
  if (sigPath !== undefined && keyPath !== undefined) {
    const keyPem = readText(io, keyPath);
    detached = detachedSignature(entries[0]?.content ?? "", readText(io, sigPath), keyPem);
    // A detached signature checked against a key other than the one the receipt
    // carries would pass for a different signer than the receipt names.
    const carried = report.receipt?.publicKey;
    if (detached.status === "pass" && carried) {
      try {
        const der = createPublicKey(keyPem).export({ type: "spki", format: "der" }).toString("base64");
        if (der !== carried) keyNote = "The key given is not the key the receipt carries.";
      } catch {
        keyNote = "The key given could not be read.";
      }
    }
  }

  const ok = report.ok && detached?.status !== "fail" && keyNote === null;
  if (values.json) {
    io.out(`${JSON.stringify({ ok, hash: report.hash, signature: report.signature, detached, key: keyNote, receipt: report.receipt }, null, 2)}\n`);
  } else {
    io.out(describe(report, detached, keyNote));
    io.out(ok ? "verified\n" : "NOT verified\n");
  }
  return ok ? 0 : 1;
}
