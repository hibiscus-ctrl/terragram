// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The gate between the Google Cloud sandbox workflow's two jobs (`.github/workflows/sandbox-google.yml`):
 * what the job that installs dependencies wrote is checked, by the job that can get a token, before
 * Terraform is run on it.
 *
 *   node scripts/sandbox-gcp-validate.mjs <dir of the plans>
 *
 * THE THREAT. The first job runs this repository's dependency tree to generate the plans, so a compromised
 * package could write a plan that runs code instead of describing infrastructure: an `external` data source,
 * a provisioner, a module or a provider from somewhere else, a backend, a file that reads the runner's
 * disk. The second job applies the artifact with a cloud token. Nothing that job runs may trust the plans.
 *
 * WHAT THIS DOES. It refuses, and does not repair, whatever the generator does not write today:
 * - a directory that is not the four plans, a file that is not a regular `*.tf` file or one of the
 *   generator's placeholder sources (pinned by hash), a name outside a plain alphabet, a symlink, a hidden
 *   file (`.terraform`, `.terraform.lock.hcl`, `.terraformrc`), an override file, a file too large;
 * - in a `*.tf` file, anything but `terraform`, `provider`, `variable`, `locals`, `resource`, `data` and
 *   `output` blocks: no `module`, `moved`, `import`, `removed` or `check`; in `terraform`, nothing but
 *   `required_version` and `required_providers` (so no `backend`, no `cloud`); providers only as exact
 *   source and version strings of `ALLOWED_PROVIDERS`; resources and data sources only of the exact types the
 *   generator writes (`ALLOWED_RESOURCES`, `ALLOWED_DATA`) and `archive_file` reading only the placeholder
 *   sources; no data source that hands out a token, no attribute that reads a local path; no provisioner, no
 *   `local-exec`, no `remote-exec`, no heredoc, no reference to `path`, and no use at all of a function that
 *   reads a file or runs a provider's own function (the name alone is refused, whatever follows it).
 *
 * It is plain JavaScript on Node's built-ins, so it runs where nothing is installed. Its parser is a strict
 * subset of HCL's: anything it cannot read is refused, never skipped, and Terraform's own checks (a lock file
 * of the providers' hashes, `terraform init -lockfile=readonly`, a CLI configuration with no overrides)
 * stand behind it. It prints the digest of what it read, which both jobs put in their summaries.
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The plans, one directory each. */
export const PLAN_IDS = ["gcp-data", "gcp-platform", "gcp-site", "gcp-serverless"];

/** The providers a plan may require, by name: the exact `source` and `version` strings, and no others. */
export const ALLOWED_PROVIDERS = {
  google: { source: "hashicorp/google", version: "~> 8.12" },
  "google-beta": { source: "hashicorp/google-beta", version: "~> 8.12" },
  archive: { source: "hashicorp/archive", version: "~> 2.8" },
};

/**
 * The placeholder sources the generator writes beside a plan, which `archive_file` zips for Cloud Functions and
 * App Engine, by path and SHA-256. A change to the generator's placeholders changes a hash here, and the
 * tests say so.
 */
export const PINNED_SOURCES = {
  "gcp-data/src/app-service/index.js": "31b88f2f1fc1ce68b0da56257cdd7ada456bdce446e4795e42a9e1ea896334c4",
  "gcp-data/src/app-service/package.json": "22dbaffa663c982d9ed544a96b9d840a51f19c255c27666c7688cabd252da081",
  "gcp-serverless/src/functions/index.js": "8d18e49cf6f7eab469785291fc1513fe3d58ea4fcc16272ffe8067d5b3337e5b",
  "gcp-serverless/src/functions/package.json": "86a04dc0b7fdf82198a32594cf4201c3e760020f13669d3b1c7896e6ecda27f5",
};

/**
 * The resource types the four plans and the network root contain, and no others: a type the generator starts to
 * write is refused until it is listed here, and the tests fail on the pull request that adds it.
 */
export const ALLOWED_RESOURCES = new Set([
  "google_bigquery_dataset",
  "google_cloud_run_service_iam_member",
  "google_cloud_run_v2_service",
  "google_cloud_run_v2_service_iam_member",
  "google_cloudfunctions2_function",
  "google_compute_backend_bucket",
  "google_compute_backend_service",
  "google_compute_firewall",
  "google_compute_global_address",
  "google_compute_global_forwarding_rule",
  "google_compute_instance",
  "google_compute_managed_ssl_certificate",
  "google_compute_network",
  "google_compute_region_network_endpoint_group",
  "google_compute_router",
  "google_compute_router_nat",
  "google_compute_security_policy",
  "google_compute_ssl_policy",
  "google_compute_subnetwork",
  "google_compute_target_http_proxy",
  "google_compute_target_https_proxy",
  "google_compute_url_map",
  "google_container_cluster",
  "google_container_node_pool",
  "google_dns_managed_zone",
  "google_dns_record_set",
  "google_firestore_database",
  "google_kms_crypto_key",
  "google_kms_crypto_key_iam_member",
  "google_kms_key_ring",
  "google_logging_project_bucket_config",
  "google_monitoring_alert_policy",
  "google_monitoring_notification_channel",
  "google_project_iam_member",
  "google_project_service",
  "google_project_service_identity",
  "google_pubsub_subscription",
  "google_pubsub_topic",
  "google_redis_instance",
  "google_secret_manager_secret",
  "google_service_account",
  "google_service_networking_connection",
  "google_sql_database",
  "google_sql_database_instance",
  "google_sql_user",
  "google_storage_bucket",
  "google_storage_bucket_iam_member",
  "google_storage_bucket_object",
]);

/** The data sources they read; `archive_file` has its own strict check below. */
export const ALLOWED_DATA = new Set(["archive_file", "google_bigquery_default_service_account", "google_project", "google_storage_project_service_account"]);

/** Data sources that hand out a token or an identity of the caller: refused even if someone lists them above. */
export const DENIED_DATA = new Set([
  "google_client_config",
  "google_service_account_access_token",
  "google_service_account_id_token",
  "google_service_account_jwt",
  "google_client_openid_userinfo",
]);
const TOKEN_LIKE = /client_config|access_token|id_token|jwt|openid|userinfo|credential|secret_version|kms_secret|service_account_key/;
for (const type of ALLOWED_DATA) if (DENIED_DATA.has(type) || TOKEN_LIKE.test(type)) throw new Error(`${type} may not be an allowed data source`);

/** Attributes that read a local path or carry a credential: refused in any resource, at any depth. */
const LOCAL_PATH_ATTRIBUTES = new Set(["source", "source_file", "source_dir", "source_content", "source_content_filename", "credentials", "access_token", "impersonate_service_account", "key_file", "private_key_path"]);
/** What a bucket object may set: its content is the archive the plan zipped, by its `source`, and nothing written inline. */
const BUCKET_OBJECT_ATTRIBUTES = new Set(["name", "bucket", "source", "content_type", "depends_on"]);

const TOP_LEVEL = { terraform: 0, provider: 1, variable: 1, locals: 0, resource: 2, data: 2, output: 1 };
const PROVIDER_ATTRIBUTES = new Set(["project", "region", "zone", "default_labels"]);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// Compared in lower case, and refused as a bare identifier wherever it appears: HCL reads a call with a newline,
// a comment or a template between the name and its parenthesis, so the name alone is what is refused.
const FUNCTIONS_THAT_READ_THE_DISK = new Set([
  "templatestring",
  "file",
  "filebase64",
  "filebase64sha256",
  "filebase64sha512",
  "filemd5",
  "filesha1",
  "filesha256",
  "filesha512",
  "fileexists",
  "fileset",
  "templatefile",
  "abspath",
  "pathexpand",
]);
const FORBIDDEN_STRINGS = new Set(["local-exec", "remote-exec"]);
const MAX_FILE = 256 * 1024;
const MAX_FILES_PER_PLAN = 64;
const MAX_TOTAL = 2 * 1024 * 1024;
const MAX_DEPTH = 4;

/** Whether the text has a control character other than tab, newline and return, or one that reorders or hides text. */
function hasHiddenCharacter(text) {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const control = (code < 0x20 && code !== 9 && code !== 10 && code !== 13) || code === 0x7f;
    const invisible = (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2060 && code <= 0x2064) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff || code === 0x61c || code === 0x180e || (code >= 0x80 && code <= 0x9f) || code === 0x2028 || code === 0x2029;
    if (control || invisible) return true;
  }
  return false;
}

/** The plans are not what the generator writes. */
export class PlanRejected extends Error {}

const reject = (where, why) => {
  throw new PlanRejected(`${where}: ${why}`);
};

/**
 * Tokens of one file: `{ t, v, line }`, with `t` one of `id`, `num`, `str`, `p` (punctuation) and `nl`; a string
 * carries `inner`, the tokens of its interpolations. A heredoc, an unterminated string or comment, or a
 * character that HCL has no use for is refused.
 */
function tokenize(text, where) {
  // HCL ends a line at \n only, which a lone \r in a comment would make a question of: refused.
  if (/\r(?!\n)/.test(text)) reject(where, "a carriage return that is not part of a line ending");
  let line = 1;
  const scan = (start, inInterpolation) => {
    const tokens = [];
    let i = start;
    let depth = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === "\n") {
        tokens.push({ t: "nl", v: "\n", line });
        line++;
        i++;
      } else if (c === " " || c === "\t" || c === "\r") {
        i++;
      } else if (c === "#" || (c === "/" && text[i + 1] === "/")) {
        while (i < text.length && text[i] !== "\n") i++;
      } else if (c === "/" && text[i + 1] === "*") {
        const end = text.indexOf("*/", i + 2);
        if (end === -1) reject(`${where}:${line}`, "a comment is never closed");
        for (const ch of text.slice(i, end)) if (ch === "\n") line++;
        i = end + 2;
      } else if (/[A-Za-z_]/.test(c)) {
        let j = i + 1;
        while (j < text.length && /[A-Za-z0-9_-]/.test(text[j])) j++;
        tokens.push({ t: "id", v: text.slice(i, j), line });
        i = j;
      } else if (/[0-9]/.test(c)) {
        const m = /^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i, i + 40));
        tokens.push({ t: "num", v: m[0], line });
        i += m[0].length;
      } else if (c === '"') {
        const startLine = line;
        let j = i + 1;
        const inner = [];
        let closed = false;
        while (j < text.length) {
          const d = text[j];
          if (d === "\\") {
            // Only the escapes HCL reads: anything else is an error there, and is refused here.
            const e = text[j + 1];
            const hex = e === "u" ? 4 : e === "U" ? 8 : 0;
            if (hex > 0 ? !new RegExp(`^[0-9A-Fa-f]{${hex}}$`).test(text.slice(j + 2, j + 2 + hex)) : e === undefined || !'nrt"\\'.includes(e)) reject(`${where}:${line}`, "an escape in a string that HCL does not read");
            j += 2 + hex;
          } else if (d === "\r") {
            reject(`${where}:${line}`, "a string runs over a line");
          } else if (d === '"') {
            closed = true;
            break;
          } else if (d === "\n") {
            reject(`${where}:${line}`, "a string runs over a line");
          } else if ((d === "$" || d === "%") && text[j + 1] === d && text[j + 2] === "{") {
            // `$${` and `%%{` are text; after a third `$` HCL and this tokenizer might not agree on where the escape is.
            if (text[j - 1] === d) reject(`${where}:${line}`, `a run of three or more ${d} before a brace`);
            j += 3;
          } else if ((d === "$" || d === "%") && text[j + 1] === "{") {
            const sub = scan(j + 2, true);
            // Each interpolation is bracketed, so the last token of one is never read as followed by the first of the next.
            inner.push({ t: "p", v: "${", line: startLine }, ...sub.tokens, { t: "p", v: "}", line: startLine });
            j = sub.end + 1;
          } else {
            j++;
          }
        }
        if (!closed) reject(`${where}:${startLine}`, "a string is never closed");
        tokens.push({ t: "str", v: text.slice(i + 1, j), line: startLine, inner });
        i = j + 1;
      } else if (c === "<" && text[i + 1] === "<") {
        reject(`${where}:${line}`, "a heredoc");
      } else if (inInterpolation && c === "}" && depth === 0) {
        return { tokens, end: i };
      } else {
        const op = ["...", "==", "!=", "<=", ">=", "&&", "||", "=>", "::"].find((o) => text.startsWith(o, i));
        if (op !== undefined) {
          tokens.push({ t: "p", v: op, line });
          i += op.length;
        } else if ("{}[]()=,.:?!<>+-*/%&|^~".includes(c)) {
          if (c === "{") depth++;
          if (c === "}") depth--;
          tokens.push({ t: "p", v: c, line });
          i++;
        } else {
          reject(`${where}:${line}`, `a character HCL does not use (code ${c.codePointAt(0)})`);
        }
      }
    }
    if (inInterpolation) reject(`${where}:${line}`, "an interpolation is never closed");
    return { tokens, end: i };
  };
  return scan(0, false).tokens;
}

/** Items of a body: `{ kind: "attr", name, value, line }` and `{ kind: "block", type, labels, body, line }`. */
function parseBody(tokens, start, nested, where) {
  const items = [];
  let i = start;
  const at = () => `${where}:${tokens[i]?.line ?? "end"}`;
  for (;;) {
    while (tokens[i]?.t === "nl") i++;
    const first = tokens[i];
    if (first === undefined) {
      if (nested) reject(at(), "a block is never closed");
      return { items, end: i };
    }
    if (nested && first.t === "p" && first.v === "}") return { items, end: i + 1 };
    if (first.t !== "id") reject(at(), "a block or an attribute was expected");
    i++;
    const next = tokens[i];
    if (next?.t === "p" && next.v === "=") {
      i++;
      const value = [];
      let depth = 0;
      for (; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.t === "p" && "{[(".includes(token.v)) depth++;
        if (token.t === "p" && "}])".includes(token.v)) {
          if (depth === 0) {
            if (token.v === "}" && nested) break;
            reject(at(), "a bracket is closed that was never opened");
          }
          depth--;
        }
        if (token.t === "nl" && depth === 0) break;
        if (!(token.t === "nl")) value.push(token);
      }
      if (value.length === 0) reject(at(), `attribute ${first.v} has no value`);
      if (depth !== 0) reject(at(), "a bracket is never closed");
      items.push({ kind: "attr", name: first.v, value, line: first.line });
    } else {
      const labels = [];
      while (tokens[i]?.t === "str" || tokens[i]?.t === "id") {
        if (tokens[i].t === "str" && tokens[i].inner.length > 0) reject(at(), "a block label has an interpolation");
        labels.push(tokens[i].v);
        i++;
      }
      if (!(tokens[i]?.t === "p" && tokens[i].v === "{")) reject(at(), `${first.v} is neither a block nor an attribute`);
      const inner = parseBody(tokens, i + 1, true, where);
      i = inner.end;
      items.push({ kind: "block", type: first.v, labels, body: inner.items, line: first.line });
      const after = tokens[i];
      if (after !== undefined && after.t !== "nl" && !(nested && after.t === "p" && after.v === "}")) reject(at(), "something follows a block on its line");
    }
  }
}

/** The one string a value is, with no interpolation; `undefined` otherwise. */
function plainString(value) {
  return value.length === 1 && value[0].t === "str" && value[0].inner.length === 0 ? value[0].v : undefined;
}

/** `{ a = "x", b = "y" }` of strings, as an object; anything else is refused. */
function stringObject(value, where) {
  if (!(value[0]?.v === "{" && value[0].t === "p" && value.at(-1)?.v === "}" && value.at(-1).t === "p")) reject(where, "an object of strings was expected");
  const out = {};
  const inside = value.slice(1, -1);
  for (let i = 0; i < inside.length; ) {
    const [key, eq, str] = [inside[i], inside[i + 1], inside[i + 2]];
    if (key?.t !== "id" || eq?.t !== "p" || eq.v !== "=" || str?.t !== "str" || str.inner.length > 0) reject(where, "an object of strings was expected");
    if (key.v in out) reject(where, `${key.v} is set twice`);
    out[key.v] = str.v;
    i += 3;
    if (inside[i]?.t === "p" && inside[i].v === ",") i++;
  }
  return out;
}

function checkTerraformBlock(block, where) {
  for (const item of block.body) {
    const here = `${where}:${item.line}`;
    if (item.kind === "attr") {
      if (item.name !== "required_version" || plainString(item.value) === undefined) reject(here, `terraform may set only a required_version of one string, not ${item.name}`);
    } else if (item.type !== "required_providers" || item.labels.length > 0) {
      reject(here, `terraform may hold only required_providers, not ${item.type}`);
    } else {
      for (const entry of item.body) {
        const entryAt = `${where}:${entry.line}`;
        if (entry.kind !== "attr") reject(entryAt, "required_providers may hold only provider entries");
        const allowed = Object.hasOwn(ALLOWED_PROVIDERS, entry.name) ? ALLOWED_PROVIDERS[entry.name] : undefined;
        if (allowed === undefined) reject(entryAt, `provider ${entry.name} is not allowed`);
        const given = stringObject(entry.value, entryAt);
        if (given.source !== allowed.source || given.version !== allowed.version || Object.keys(given).length !== 2) {
          reject(entryAt, `provider ${entry.name} must be exactly source "${allowed.source}" and version "${allowed.version}"`);
        }
      }
    }
  }
}

function checkProviderBlock(block, where) {
  if (!Object.hasOwn(ALLOWED_PROVIDERS, block.labels[0]) || block.labels[0] === "archive") reject(`${where}:${block.line}`, `provider ${block.labels[0]} is not configured here`);
  for (const item of block.body) {
    if (item.kind !== "attr" || !PROVIDER_ATTRIBUTES.has(item.name)) reject(`${where}:${item.line}`, `a provider may set only ${[...PROVIDER_ATTRIBUTES].join(", ")}`);
  }
}

/** Every attribute of a body and of the blocks in it, with the block types that lead to it. */
function* attributesOf(items) {
  for (const item of items) {
    if (item.kind === "attr") yield item;
    else yield* attributesOf(item.body);
  }
}

/** The value tokens of every attribute of a body, nested blocks included. */
const valuesOf = (items) => [...attributesOf(items)].map((item) => item.value);

/** Whether a value is exactly `data.archive_file.<name>.output_path` of an archive the file declares. */
function isOwnArchiveOutput(value, archives) {
  const [a, b, c, d, e, f, g] = value;
  return (
    value.length === 7 &&
    [a, c, e, g].every((t) => t.t === "id") &&
    [b, d, f].every((t) => t.t === "p" && t.v === ".") &&
    a.v === "data" &&
    c.v === "archive_file" &&
    archives.has(e.v) &&
    g.v === "output_path"
  );
}

function checkObjectBlock(block, where, archives) {
  const [type] = block.labels;
  const here = `${where}:${block.line}`;
  if (block.type === "data" && type === "archive_file") {
    // The only thing a plan may zip is the placeholder next to it, into the directory Terraform keeps its data in.
    const seen = new Map();
    for (const item of block.body) {
      if (item.kind !== "attr") reject(`${where}:${item.line}`, "archive_file may hold attributes only");
      seen.set(item.name, item.value.length === 1 && item.value[0].t === "str" ? item.value[0].v : undefined);
    }
    const sourceDir = seen.get("source_dir");
    const outputPath = seen.get("output_path");
    const sourceOk = typeof sourceDir === "string" && /^\$\{path\.module\}\/src\/[a-z0-9-]+$/.test(sourceDir);
    const outputOk = typeof outputPath === "string" && /^\$\{path\.module\}\/\.terraform\/[a-z0-9-]+\.zip$/.test(outputPath);
    const only = [...seen.keys()].every((k) => k === "type" || k === "source_dir" || k === "output_path");
    if (seen.get("type") !== "zip" || !sourceOk || !outputOk || !only) reject(here, "archive_file may only zip its own src/<name> directory into .terraform/<name>.zip");
    return;
  }
  if (block.type === "data") {
    if (type !== undefined && (DENIED_DATA.has(type) || TOKEN_LIKE.test(type))) reject(here, `data ${type} hands out a token or the caller's identity`);
    if (type === undefined || !ALLOWED_DATA.has(type)) reject(here, `data ${type ?? ""} is not a data source the generator writes`);
  } else if (type === undefined || !ALLOWED_RESOURCES.has(type)) {
    reject(here, `resource ${type ?? ""} is not a resource type the generator writes`);
  }
  if (type === "google_storage_bucket_object") {
    for (const item of block.body) {
      const at = `${where}:${item.line}`;
      if (item.kind !== "attr" || !BUCKET_OBJECT_ATTRIBUTES.has(item.name)) reject(at, "a bucket object may set only name, bucket, source and content_type, and a block or an inline content is refused");
      if (item.name === "source" && !isOwnArchiveOutput(item.value, archives)) reject(at, "a bucket object's source may only be the output_path of an archive_file of the plan");
    }
    return;
  }
  for (const item of attributesOf(block.body)) {
    if (LOCAL_PATH_ATTRIBUTES.has(item.name)) reject(`${where}:${item.line}`, `the attribute ${item.name}, which reads a local path or carries a credential`);
  }
}

/** The references in a value that reach outside the plan: `path` (the runner's directories) and any data source not allowed. */
function checkReferences(list, where) {
  const sig = list.filter((t) => t.t !== "nl");
  sig.forEach((token, i) => {
    const next = sig[i + 1];
    if (token.t === "id" && token.v === "path" && next?.t === "p" && (next.v === "." || next.v === "[")) reject(`${where}:${token.line}`, "a reference to path");
    if (token.t === "id" && token.v === "data" && !(next?.t === "p" && next.v === "=")) {
      const [dot, type, dot2, name] = sig.slice(i + 1, i + 5);
      const shaped = dot?.v === "." && type?.t === "id" && dot2?.v === "." && name?.t === "id";
      if (!shaped) reject(`${where}:${token.line}`, "a reference to a data source that is not written plainly");
      if (DENIED_DATA.has(type.v) || TOKEN_LIKE.test(type.v)) reject(`${where}:${token.line}`, `a reference to data ${type.v}, which hands out a token or the caller's identity`);
      if (!ALLOWED_DATA.has(type.v)) reject(`${where}:${token.line}`, `a reference to data ${type.v}, which the generator does not write`);
    }
    if (token.inner !== undefined) checkReferences(token.inner, where);
  });
}

/** Names that matter wherever they are: a provisioner, a function that reads the disk or belongs to a provider, a command string. */
function checkNames(list, where) {
  const sig = list.filter((t) => t.t !== "nl");
  for (const token of sig) {
    const at = `${where}:${token.line}`;
    if (token.t === "id" && token.v === "provisioner") reject(at, "a provisioner");
    if (token.t === "id" && FUNCTIONS_THAT_READ_THE_DISK.has(token.v.toLowerCase())) reject(at, `the function ${token.v}`);
    if (token.t === "p" && token.v === "::") reject(at, "a function of a provider");
    if (token.t === "str" && [...FORBIDDEN_STRINGS].some((word) => token.v.toLowerCase().includes(word))) reject(at, "a string naming local-exec or remote-exec");
    if (token.inner !== undefined) checkNames(token.inner, where);
  }
}

/** What may be in the text of one `*.tf` file of a plan, or an error naming the first thing that may not. */
export function validateSource(text, where) {
  if (hasHiddenCharacter(text)) reject(where, "a control or direction-changing character");
  const tokens = tokenize(text, where);
  checkNames(tokens, where);
  const { items } = parseBody(tokens, 0, false, where);
  const archives = new Set(items.filter((item) => item.kind === "block" && item.type === "data" && item.labels[0] === "archive_file" && item.labels.length === 2).map((item) => item.labels[1]));
  for (const item of items) {
    const here = `${where}:${item.line}`;
    if (item.kind !== "block") reject(here, "an attribute outside a block");
    if (!Object.hasOwn(TOP_LEVEL, item.type)) reject(here, `a ${item.type} block is not allowed`);
    if (item.labels.length !== TOP_LEVEL[item.type]) reject(here, `a ${item.type} block takes ${TOP_LEVEL[item.type]} label${TOP_LEVEL[item.type] === 1 ? "" : "s"}`);
    if (item.type === "terraform") checkTerraformBlock(item, where);
    if (item.type === "provider") checkProviderBlock(item, where);
    if (item.type === "resource" || item.type === "data") checkObjectBlock(item, where, archives);
    if (item.type === "locals" && item.body.some((b) => b.kind !== "attr")) reject(here, "locals may hold attributes only");
    // The archive_file blocks are the one place `${path.module}` is written, and are held to their own pattern above.
    if (!(item.type === "data" && item.labels[0] === "archive_file")) for (const value of valuesOf(item.body)) checkReferences(value, where);
  }
}

const sha256 = (content) => createHash("sha256").update(content).digest("hex");

/** The files under `dir` as `{ rel, content }`, or an error: only directories and regular files of plain names, nothing past the limits. */
function readTree(dir, rel, depth, found) {
  if (depth > MAX_DEPTH) reject(rel, "too deep");
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const here = `${rel}/${name}`;
    if (!NAME.test(name)) reject(here, "the name is not a plain one");
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      readTree(path, here, depth + 1, found);
    } else if (stat.isFile() && stat.nlink === 1) {
      if (stat.size > MAX_FILE) reject(here, "over the size limit");
      found.push({ rel: here, content: readFileSync(path) });
    } else {
      reject(here, "not a regular file or a directory (a link, perhaps)");
    }
  }
}

/**
 * Checks the plans under `root`. Returns `{ files, plans, digest }`: how many files and plans were read, and the
 * SHA-256 of their paths and contents. Throws `PlanRejected` at the first thing that is not what the generator writes.
 */
export function validatePlans(root) {
  let stat;
  try {
    stat = lstatSync(root);
  } catch {
    return reject("the plans", "there is no such directory");
  }
  if (!stat.isDirectory()) reject("the plans", "not a directory");
  const top = readdirSync(root).sort();
  if (top.join() !== [...PLAN_IDS].sort().join()) reject("the plans", `expected exactly ${[...PLAN_IDS].sort().join(", ")}`);
  const all = [];
  for (const id of PLAN_IDS) {
    const found = [];
    const planStat = lstatSync(join(root, id));
    if (!planStat.isDirectory()) reject(id, "not a directory");
    readTree(join(root, id), id, 1, found);
    if (found.length > MAX_FILES_PER_PLAN) reject(id, "too many files");
    for (const file of found) {
      const inside = file.rel.slice(id.length + 1);
      if (/^[A-Za-z0-9_-]+\.tf$/.test(inside) && !/(^|_)override\.tf$/.test(inside)) {
        let text;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(file.content);
        } catch {
          reject(file.rel, "not UTF-8");
        }
        validateSource(text, file.rel);
      } else if (/^[A-Za-z0-9_-]+\.tfvars$/.test(inside)) {
        const text = new TextDecoder("utf-8").decode(file.content);
        if (hasHiddenCharacter(text)) reject(file.rel, "a control or direction-changing character");
        const { items } = parseBody(tokenize(text, file.rel), 0, false, file.rel);
        if (items.some((item) => item.kind !== "attr")) reject(file.rel, "a tfvars file may hold attributes only");
      } else if (Object.hasOwn(PINNED_SOURCES, file.rel)) {
        if (sha256(file.content) !== PINNED_SOURCES[file.rel]) reject(file.rel, "a placeholder source that is not the generator's");
      } else {
        reject(file.rel, "a file that is not a *.tf, a *.tfvars or one of the generator's placeholder sources");
      }
    }
    all.push(...found);
  }
  if (all.reduce((sum, f) => sum + f.content.length, 0) > MAX_TOTAL) reject("the plans", "over the size limit");
  const digest = createHash("sha256");
  for (const file of all) digest.update(`${file.rel}\0${sha256(file.content)}\n`);
  return { files: all.length, plans: PLAN_IDS.length, digest: `sha256:${digest.digest("hex")}` };
}

/** Text that came from the artifact, fit for a workflow command: printable ASCII only, and short. */
const safe = (text) => String(text).replace(/[^\x20-\x7e]/g, "?").replace(/::/g, ": ").slice(0, 300);

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2];
  if (dir === undefined || process.argv.length !== 3) {
    console.error("usage: node scripts/sandbox-gcp-validate.mjs <dir of the plans>");
    process.exit(2);
  }
  try {
    const { files, plans, digest } = validatePlans(dir);
    console.log(`The ${plans} plans (${files} files) are what the generator writes.`);
    console.log(`digest ${digest}`);
  } catch (error) {
    if (!(error instanceof PlanRejected)) throw error;
    console.log(`::error::The plans are not what the generator writes, and nothing was run on them: ${safe(error.message)}`);
    process.exit(1);
  }
}
