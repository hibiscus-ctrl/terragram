/**
 * Register a dedicated Enterprise instance in the CORE registry + mint its
 * telemetry token. Run against the core project (terragram.dev's Supabase) — the
 * same Management-API path as the db:* scripts (no Docker / local pg).
 *
 * Usage (loads .env.local via the npm script):
 *   npm run instance:create -- --slug acme --region uk --label "Acme Corp"
 *
 * Prints the telemetry token ONCE (not recoverable). Set it on the customer's
 * dedicated instance as TERRAGRAM_TELEMETRY_TOKEN, alongside
 * TERRAGRAM_TELEMETRY_URL=https://terragram.dev/api/instance-telemetry.
 */
import { createHash, randomBytes } from "node:crypto";
import { projectRef, runSql } from "./supabase-query.mjs";

const args = process.argv.slice(2);
const val = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);

const slug = (val("--slug") || "").trim();
const region = (val("--region") || "uk").trim().toLowerCase();
const label = (val("--label") || "").trim() || null;

if (!/^[a-z0-9-]{2,40}$/.test(slug)) {
  console.error("Pass --slug <kebab-case> (a-z, 0-9, '-', 2–40 chars).");
  process.exit(1);
}
if (region !== "uk" && region !== "eu") {
  console.error("--region must be 'uk' or 'eu'.");
  process.exit(1);
}

const secret = `tmtel_${randomBytes(24).toString("base64url")}`;
const hash = createHash("sha256").update(secret).digest("hex");
const esc = (s) => String(s).replace(/'/g, "''");
const labelSql = label ? `'${esc(label)}'` : "null";

try {
  await runSql(
    `insert into public.managed_instances (slug, label, region, token_hash) ` +
      `values ('${esc(slug)}', ${labelSql}, '${region}', '${hash}');`,
  );
  console.log(`Registered instance '${slug}' (${region}) in project ${projectRef()}.\n`);
  console.log("Set these on the customer's dedicated instance (shown once — not recoverable):");
  console.log("  TERRAGRAM_TELEMETRY_URL=https://terragram.dev/api/instance-telemetry");
  console.log(`  TERRAGRAM_TELEMETRY_TOKEN=${secret}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
