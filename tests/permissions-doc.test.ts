/**
 * Holds `docs/permissions.md` to the code, so "what each role can do" is never a
 * document someone forgot to update.
 *
 * Pinned:
 *  - the capability table IS `CAPABILITIES` — every row, label and tick;
 *  - the page table names exactly the capability each account-dashboard page's
 *    `guardPage(…)` call (and the Stripe portal route's check) uses, and no page
 *    escapes that check;
 *  - each org-scoped action's first guard requires its listed capability in code;
 *  - every exported server action is listed exactly once: org-scoped with its
 *    capability, or not org-scoped (and then it has no org guard);
 *  - the audit-event table IS `AUDIT_EVENTS`, and no catalogued event is dead.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  CAPABILITIES,
  type Capability,
  ORG_ROLES,
  ROLE_LABEL,
} from "../src/features/account/controllers/permissions.ts";
import { AUDIT_EVENTS } from "../src/features/platform/audit-events.ts";

const DOC = readFileSync("docs/permissions.md", "utf8").replace(/\r\n/g, "\n");

/** Every .ts/.tsx file under `dir`, as a forward-slashed path from the repo root. */
function filesUnder(dir: string, pattern = /\.tsx?$/): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .map((f) => join(dir, f).replace(/\\/g, "/"))
    .filter((f) => pattern.test(f))
    .sort();
}

/** The table rows between `<!-- name:start -->` and `<!-- name:end -->`. */
function tableRows(name: string): string[][] {
  const start = DOC.indexOf(`<!-- ${name}:start -->`);
  const end = DOC.indexOf(`<!-- ${name}:end -->`);
  assert.ok(start >= 0 && end > start, `docs/permissions.md has no ${name} table markers`);
  return DOC.slice(start, end)
    .split("\n")
    .filter((l) => l.startsWith("|") && !/^\|[-:| ]+\|$/.test(l))
    .slice(1) // header
    .map((l) =>
      l
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim()),
    );
}

const backticked = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");

/** `source` with comments blanked, so a commented-out call cannot satisfy an
 *  assertion. Crude (a `//` inside a string is cut too), which only errs toward
 *  failing. */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const SRC = filesUnder("src");

/** Exported async functions of every module with a top-level "use server". */
function serverActions(): Array<{ file: string; name: string }> {
  return SRC.flatMap((file) => {
    const text = readFileSync(file, "utf8");
    if (!/^"use server";/m.test(text)) return [];
    return [...text.matchAll(/^export async function (\w+)/gm)].map((m) => ({
      file,
      name: m[1] ?? "",
    }));
  });
}

describe("docs/permissions.md: the capability matrix", () => {
  const rows = tableRows("capability-matrix");

  it("has one row per capability, in the matrix's order", () => {
    assert.deepEqual(
      rows.map((r) => backticked(r[0] ?? "")[0]),
      Object.keys(CAPABILITIES),
    );
  });

  it("describes each capability with its label and ticks exactly its roles", () => {
    const header = DOC.slice(DOC.indexOf("<!-- capability-matrix:start -->"))
      .split("\n")
      .find((l) => l.startsWith("| Capability"));
    assert.equal(
      header,
      `| Capability | What it covers | ${ORG_ROLES.map((r) => ROLE_LABEL[r]).join(" | ")} |`,
      "role columns follow ORG_ROLES",
    );
    for (const row of rows) {
      const id = backticked(row[0] ?? "")[0] as Capability;
      const cap = CAPABILITIES[id];
      assert.equal(row[1], cap.label, `${id}: label`);
      assert.deepEqual(
        ORG_ROLES.filter((_, i) => row[2 + i] === "✓"),
        [...cap.roles],
        `${id}: roles`,
      );
      for (const [i, role] of ORG_ROLES.entries()) {
        assert.ok(["✓", ""].includes(row[2 + i] ?? "?"), `${id}/${role}: a cell is ✓ or empty`);
      }
    }
  });
});

describe("docs/permissions.md: pages", () => {
  const PAGE_DIR = "src/app/(app)/(dashboard)";
  const PORTAL_ROUTE = "src/app/(account)/manage-subscription/route.ts";
  const docPages = new Map<string, Capability>();
  for (const [pages, capability] of tableRows("page-capabilities")) {
    for (const page of backticked(pages ?? "")) {
      docPages.set(page, backticked(capability ?? "")[0] as Capability);
    }
  }

  it("names every account-dashboard page with the capability its guardPage call uses", () => {
    const guarded = filesUnder(PAGE_DIR, /\/page\.tsx$/).map((f) => {
      const match = /guardPage\("([a-z.]+)"\)/.exec(stripComments(readFileSync(f, "utf8")));
      assert.ok(match, `${f} has no literal guardPage("…") call`);
      return [f.slice(PAGE_DIR.length + 1).replace(/\/page\.tsx$/, ""), match[1]] as const;
    });
    assert.ok(guarded.length >= 2, `found only ${guarded.length} guarded pages`);
    for (const [page, capability] of guarded) {
      assert.equal(docPages.get(page), capability, `page ${page}`);
    }
    assert.equal(docPages.size, guarded.length + 1, "the doc lists no page the code doesn't guard (+ the portal route)");
  });

  it("gives the Stripe portal route the Billing page's capability", () => {
    const route = stripComments(readFileSync(PORTAL_ROUTE, "utf8"));
    assert.match(route, /\bcan\(membership\.role, "billing\.manage"\)/);
    assert.equal(docPages.get("manage-subscription"), "billing.manage");
  });
});

/**
 * The body of the `async function <name>(` in `source`: from its signature to the
 * first line that closes it at the signature's own indentation. Formatting-based
 * rather than a parser; a mismatch fails loudly (undefined), never silently.
 */
function functionBody(source: string, name: string): string | undefined {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^\\s*(?:export )?async function ${name}\\(`).test(l));
  if (start < 0) return undefined;
  const indent = /^\s*/.exec(lines[start] ?? "")?.[0] ?? "";
  const end = lines.findIndex((l, i) => i > start && l.trimEnd() === `${indent}}`);
  return end < 0 ? undefined : lines.slice(start, end + 1).join("\n");
}

const GUARD_CALL = /\b(?:guardMemberAction|guard)\(/;

/** The options object literal of the first guard call in `body`, comments stripped. */
function firstGuardOptions(body: string): string | undefined {
  const code = stripComments(body);
  const call = GUARD_CALL.exec(code);
  if (!call) return undefined;
  const open = code.indexOf("{", call.index);
  if (open < 0 || code.slice(call.index + call[0].length, open).trim() !== "") return undefined;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return code.slice(open, i + 1);
  }
  return undefined;
}

/**
 * The body an action's guard runs in: the exported function itself, or — when that
 * only delegates — the same-named function in the `*-core.ts` module it imports.
 */
function guardedBody(file: string, name: string): { where: string; body: string } {
  const source = readFileSync(file, "utf8");
  const body = functionBody(source, name);
  assert.ok(body, `${file}#${name}: no \`export async function ${name}(\` found`);
  if (GUARD_CALL.test(stripComments(body))) return { where: file, body };
  assert.ok(body.includes(`.${name}(`), `${file}#${name} has no guard call and does not delegate to a core`);
  const hits = [...source.matchAll(/from\s+"@\/([^"]+-core)"/g)].flatMap((m) => {
    const core = `src/${m[1]}.ts`;
    const coreBody = functionBody(readFileSync(core, "utf8"), name);
    return coreBody ? [{ where: core, body: coreBody }] : [];
  });
  assert.equal(hits.length, 1, `${file}#${name}: expected exactly one imported core defining ${name}`);
  return hits[0];
}

describe("docs/permissions.md: server actions", () => {
  const actions = serverActions();
  const fileOf = new Map(actions.map((a) => [a.name, a.file]));

  const scoped = new Map<string, Capability>();
  for (const [capability, names] of tableRows("action-capabilities")) {
    for (const name of backticked(names ?? "")) {
      scoped.set(name, backticked(capability ?? "")[0] as Capability);
    }
  }
  const unscoped = new Map<string, string>();
  for (const [module, names] of tableRows("unscoped-actions")) {
    for (const name of backticked(names ?? "")) unscoped.set(name, backticked(module ?? "")[0] ?? "");
  }

  it("server action names are unique, so the doc can name them alone", () => {
    assert.equal(fileOf.size, actions.length);
  });

  it("lists every exported server action exactly once", () => {
    const listed = [...scoped.keys(), ...unscoped.keys()].sort();
    assert.deepEqual(listed, actions.map((a) => a.name).sort());
  });

  it("each org-scoped action's first guard requires its listed capability", () => {
    for (const [name, capability] of scoped) {
      const file = fileOf.get(name);
      assert.ok(file, `${name} is not an exported server action`);
      const { where, body } = guardedBody(file, name);
      const options = firstGuardOptions(body);
      assert.ok(options, `${where}#${name}: no guard call with an options literal found`);
      const required = /\brequire:\s*allows\("([a-z.]+)"\)/.exec(options);
      assert.ok(required, `${where}#${name}: the guard has no \`require: allows("…")\``);
      assert.equal(required[1], capability, `${name}: the guard requires ${required[1]}, the doc says ${capability}`);
    }
  });

  it("puts each action that is not org-scoped under its own module, with no org guard", () => {
    for (const [name, module] of unscoped) {
      assert.equal(fileOf.get(name), module, `${name} is listed under ${module}`);
      const body = functionBody(readFileSync(module, "utf8"), name) ?? "";
      assert.doesNotMatch(stripComments(body), /\bguardMemberAction\(/, `${name} guards on an org role — list it with its capability`);
    }
  });
});

describe("docs/permissions.md: the audit trail", () => {
  it("lists exactly the catalogued events, with their descriptions, in order", () => {
    const rows = tableRows("audit-events").map(([event, when]) => [backticked(event ?? "")[0], when]);
    assert.deepEqual(rows, Object.entries(AUDIT_EVENTS));
  });

  it("has no dead entry: every catalogued event is recorded somewhere", () => {
    const sources = SRC.filter((f) => !f.endsWith("platform/audit-events.ts"))
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    for (const event of Object.keys(AUDIT_EVENTS)) {
      assert.ok(sources.includes(`"${event}"`), `${event} is catalogued but never recorded`);
    }
  });
});
