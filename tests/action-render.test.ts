// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { InfraModel, ModelEdge, ModelNode } from "terragram-engine/model";

import { mermaidText, renderDiagram } from "../action/src/mermaid.ts";
import { diffModels, hasModelChanges } from "../action/src/model-diff.ts";
import { type ReportInput, markdownText, renderReport } from "../action/src/report.ts";
import { unifiedDiff } from "../action/src/text-diff.ts";

/**
 * The pure parts of the Action: the model diff, its Mermaid rendering, the line diff and
 * the report text. The text a model file carries is hostile input here, so most of the
 * cases below are about what a label cannot do.
 */

const node = (id: string, label = id, extra: Partial<ModelNode> = {}): ModelNode => ({
  id,
  category: "compute",
  kind: "app-service",
  label,
  flag: null,
  ...extra,
});
const edge = (source: string, target: string, origin: ModelEdge["origin"] = "derived"): ModelEdge => ({
  id: `${source}-${target}`,
  source,
  target,
  origin,
});
const model = (nodes: ModelNode[], edges: ModelEdge[] = []): InfraModel => ({ nodes, edges, topology: "derived" });

const base = model([node("web", "Web"), node("db", "Database", { kind: "postgres" }), node("old", "Old queue")], [
  edge("web", "db"),
  edge("web", "old"),
]);
const head = model(
  [node("web", "Web app"), node("db", "Database", { kind: "postgres" }), node("cache", "Cache", { kind: "redis-cache" })],
  [edge("web", "db"), edge("web", "cache")],
);

describe("diffModels", () => {
  it("sorts nodes and edges into added, removed, changed and unchanged by identity", () => {
    const diff = diffModels(base, head);
    assert.deepEqual(diff.nodes.added.map((n) => n.id), ["cache"]);
    assert.deepEqual(diff.nodes.removed.map((n) => n.id), ["old"]);
    assert.deepEqual(diff.nodes.changed.map((c) => [c.before.label, c.after.label]), [["Web", "Web app"]]);
    assert.deepEqual(diff.nodes.unchanged.map((n) => n.id), ["db"]);
    assert.deepEqual(diff.edges.added.map((e) => e.target), ["cache"]);
    assert.deepEqual(diff.edges.removed.map((e) => e.target), ["old"]);
    assert.equal(diff.edges.unchanged.length, 1);
  });

  it("counts a changed kind, attribute or review flag, but not a move on the canvas", () => {
    const moved = model([node("a", "A", { position: { x: 1, y: 2 } })]);
    assert.equal(hasModelChanges(diffModels(model([node("a", "A")]), moved)), false);
    for (const changed of [
      node("a", "A", { kind: "function" }),
      node("a", "A", { attributes: { "Compute tier": "P3v3" } }),
      node("a", "A", { flag: { reason: "check the size" } }),
    ]) {
      assert.equal(diffModels(model([node("a", "A")]), model([changed])).nodes.changed.length, 1);
    }
  });

  it("calls an edge whose origin flipped changed, and identical models unchanged", () => {
    const flipped = diffModels(model([node("a"), node("b")], [edge("a", "b")]), model([node("a"), node("b")], [edge("a", "b", "user")]));
    assert.equal(flipped.edges.changed.length, 1);
    assert.equal(hasModelChanges(diffModels(base, base)), false);
  });
});

describe("renderDiagram", () => {
  it("draws added green, removed red and dashed, changed amber", () => {
    const { mermaid, scope } = renderDiagram(diffModels(base, head));
    assert.equal(scope, "full");
    assert.ok(mermaid);
    assert.match(mermaid, /^flowchart LR\n/);
    const lines = mermaid.split("\n");
    // Nodes are sorted by id: cache, db, old, web -> n0..n3.
    assert.ok(lines.includes('  n0["Cache<br/>redis-cache"]'));
    assert.ok(lines.includes("  class n0 added"));
    assert.ok(lines.includes("  class n2 removed"));
    assert.ok(lines.includes("  class n3 changed"));
    assert.match(mermaid, /classDef added fill:#d1fae5,stroke:#047857/);
    assert.match(mermaid, /classDef removed .*stroke-dasharray:5 5/);
    assert.match(mermaid, /classDef changed fill:#fef3c7,stroke:#b45309/);
    // Edges: unchanged web->db, added web->cache, removed web->old (dashed arrow).
    assert.ok(lines.includes("  n3 --> n1"));
    assert.ok(lines.includes("  n3 --> n0"));
    assert.ok(lines.includes("  n3 -.-> n2"));
    assert.ok(lines.includes("  linkStyle 1 stroke:#047857,stroke-width:2px"));
    assert.ok(lines.includes("  linkStyle 2 stroke:#b91c1c,stroke-width:2px"));
  });

  it("draws nothing when nothing changed", () => {
    assert.deepEqual(renderDiagram(diffModels(base, base)), { mermaid: null, scope: "none" });
  });

  it("keeps a label from ending the fence, opening markup or breaking the node", () => {
    const hostile = 'x"]\n```\n<script>alert(1)</script> | [y](z) `a` {b} #c';
    const text = mermaidText(hostile);
    assert.doesNotMatch(text, /["`<>|[\](){}\n]/);
    const { mermaid } = renderDiagram(diffModels(model([]), model([node("a", hostile)])));
    assert.ok(mermaid);
    assert.equal(mermaid.split("```").length, 1);
    assert.equal(mermaid.split("\n").filter((l) => l.startsWith("  n0[")).length, 1);
  });

  it("shortens a long label, and skips an edge to a node the model does not have", () => {
    assert.ok(mermaidText("a".repeat(500)).length <= 61);
    const { mermaid } = renderDiagram(diffModels(model([]), model([node("a")], [edge("a", "ghost")])));
    assert.ok(mermaid);
    assert.doesNotMatch(mermaid, /-->/);
  });

  it("falls back to the changed part, then to no diagram, when Mermaid's limits would be passed", () => {
    const many = Array.from({ length: 300 }, (_, i) => node(`n${String(i).padStart(3, "0")}`, `Component ${i}`));
    const ring = many.map((n, i) => edge(n.id, (many[(i + 1) % many.length] as ModelNode).id));
    const extra = Array.from({ length: 200 }, (_, i) => edge((many[i] as ModelNode).id, (many[(i + 7) % many.length] as ModelNode).id));
    const bigBase = model(many, [...ring, ...extra]);
    const bigHead = model([...many, node("zzz", "New")], [...ring, ...extra, edge("n000", "zzz")]);
    const result = renderDiagram(diffModels(bigBase, bigHead));
    assert.equal(result.scope, "changes");
    assert.ok(result.mermaid && result.mermaid.length < 2000);
    assert.match(result.mermaid, /class n\d+ added/);
  });
});

describe("unifiedDiff", () => {
  it("is empty for equal text, whatever the line endings", () => {
    assert.equal(unifiedDiff("a\nb\n", "a\r\nb\r\n", "a/x", "b/x"), "");
  });

  it("matches the unified format for a change in the middle", () => {
    const before = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n";
    const after = "1\n2\n3\n4\nfive\n6\n7\n8\n9\n10\n";
    assert.equal(
      unifiedDiff(before, after, "a/f.tf", "b/f.tf"),
      "--- a/f.tf\n+++ b/f.tf\n@@ -2,7 +2,7 @@\n 2\n 3\n 4\n-5\n+five\n 6\n 7\n 8\n",
    );
  });

  it("splits distant changes into hunks and merges close ones", () => {
    const before = Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join("\n");
    const far = before.replace("l3\n", "L3\n").replace("l28\n", "L28\n");
    assert.equal(unifiedDiff(before, far, "a", "b").split("\n").filter((l) => l.startsWith("@@")).length, 2);
    const near = before.replace("l3\n", "L3\n").replace("l8\n", "L8\n");
    assert.equal(unifiedDiff(before, near, "a", "b").split("\n").filter((l) => l.startsWith("@@")).length, 1);
  });

  it("shows a new file against /dev/null and a deleted tail", () => {
    assert.equal(unifiedDiff("", "a\nb\n", "/dev/null", "b/new.tf"), "--- /dev/null\n+++ b/new.tf\n@@ -0,0 +1,2 @@\n+a\n+b\n");
    assert.equal(unifiedDiff("a\nb\nc\n", "a\n", "a/x", "b/x"), "--- a/x\n+++ b/x\n@@ -1,3 +1,1 @@\n a\n-b\n-c\n");
  });

  it("applies cleanly: patching the old text with the diff gives the new text", () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let round = 0; round < 25; round++) {
      const a = Array.from({ length: 40 }, (_, i) => `line ${i}`);
      const b = a.filter(() => next() > 0.2).flatMap((l) => (next() > 0.85 ? [l, `added ${round} ${l}`] : [l]));
      const diff = unifiedDiff(`${a.join("\n")}\n`, `${b.join("\n")}\n`, "a", "b", 40);
      const rebuilt: string[] = [];
      for (const line of diff.split("\n").slice(2)) {
        if (line.startsWith("@@") || line === "") continue;
        if (line[0] !== "-") rebuilt.push(line.slice(1));
      }
      assert.deepEqual(rebuilt, b, `round ${round}`);
    }
  });
});

describe("renderReport", () => {
  const input: ReportInput = {
    mode: "check",
    modelPath: "diagram.json",
    terraformDir: "infra/",
    cloud: "aws",
    base: { state: "compared" },
    diff: diffModels(base, head),
    diagram: renderDiagram(diffModels(base, head)),
    warnings: ["Odd box: No matching component in the component vocabulary."],
    terraformChanged: ["main.tf"],
    files: [{ name: "main.tf", status: "different", diff: "--- a/infra/main.tf\n+++ b/infra/main.tf\n@@ -1,1 +1,1 @@\n-a\n+b\n" }],
    written: [],
    contentHash: "sha256:abc",
    signed: false,
  };

  it("has the diagram, the counts, the warnings, the receipt hash and the drift diff", () => {
    const text = renderReport(input);
    assert.match(text, /```mermaid\nflowchart LR/);
    assert.match(text, /\| Nodes \| 1 \| 1 \| 1 \|/);
    assert.match(text, /\| Edges \| 1 \| 1 \| 0 \|/);
    assert.match(text, /\| Feasibility warnings \| 1 \|/);
    assert.match(text, /\| Terraform files changed by this model change \| 1 \|/);
    assert.match(text, /`sha256:abc` \(unsigned\)/);
    assert.match(text, /`infra\/` differs from `diagram\.json` in 1 file/);
    assert.match(text, /```diff\n--- a\/infra\/main\.tf/);
  });

  it("says so when the base could not be read, and draws nothing", () => {
    const text = renderReport({ ...input, base: { state: "unavailable", reason: "no base" }, diff: null, diagram: { mermaid: null, scope: "none" } });
    assert.match(text, /could not be compared with the base: no base/);
    assert.doesNotMatch(text, /mermaid/);
  });

  it("outside a pull request leaves out the model section and the base-relative row", () => {
    const text = renderReport({ ...input, base: { state: "none" }, diff: null, diagram: { mermaid: null, scope: "none" }, files: [] });
    assert.doesNotMatch(text, /Model changes/);
    assert.doesNotMatch(text, /changed by this model change/);
    assert.match(text, /`infra\/` matches `diagram\.json`/);
  });

  it("reports what write mode wrote", () => {
    assert.match(renderReport({ ...input, mode: "write", written: ["main.tf", "variables.tf"], files: [] }), /Regenerated `infra\/`: 2 files written/);
  });

  it("keeps markup, mentions and a backtick run in a label or a diff from escaping the report", () => {
    assert.equal(markdownText("a|b <i>@octocat</i> `x`"), "a&#124;b &#60;i&#62;&#64;octocat&#60;/i&#62; &#96;x&#96;");
    const text = renderReport({
      ...input,
      files: [{ name: "main.tf", status: "different", diff: "--- a\n+++ b\n@@ -1,1 +1,1 @@\n-x\n+````\n" }],
    });
    assert.match(text, /`````diff\n/);
  });
});

describe("workflow log lines", () => {
  it("prints untrusted text only inside a stop-commands window with a fresh token", async () => {
    const { createWorkflow } = await import("../action/src/workflow.ts");
    let out = "";
    const workflow = createWorkflow({
      env: {},
      cwd: "/",
      stdout: (text: string) => {
        out += text;
      },
      git: () => ({ ok: false, stdout: "" }),
      now: () => new Date(0),
    } as unknown as Parameters<typeof createWorkflow>[0]);
    const hostile = "label\n::add-mask::x\r::set-env name=A::b\u2028  ::error::c\r\n::warning::d\nok ##[add-mask]e\r\u0085##[error]f";
    workflow.log(hostile);
    workflow.log(hostile);

    // Read the output the way the runner does: commands are off between
    // ::stop-commands::<token> and ::<token>::.
    const tokens: string[] = [];
    let stopped: string | null = null;
    for (const line of out.split("\n")) {
      if (stopped !== null) {
        if (line === `::${stopped}::`) stopped = null;
        continue;
      }
      const start = /^::stop-commands::([0-9a-f]{32})$/.exec(line);
      if (start?.[1]) {
        stopped = start[1];
        tokens.push(start[1]);
        continue;
      }
      assert.ok(!line.includes("::") && !line.includes("##["), `a command got through: ${JSON.stringify(line)}`);
    }
    assert.equal(stopped, null, "every window is closed");
    assert.equal(tokens.length, 2);
    assert.notEqual(tokens[0], tokens[1], "a fresh token per call");
    assert.ok(!out.includes("\r"));
  });
});

describe("the access changes in the report", () => {
  const n = (id: string, label: string, kind = "functions"): ModelNode => ({ id, category: "compute", kind, label, flag: null });
  const nodes = [n("fn", "Orders API"), n("role", "api-role", "entra-id"), n("data", "orders-data", "object-storage"), n("any", "Any resource (*)", "external")];
  const e = (source: string, target: string, access?: ModelEdge["access"], conditional = false): ModelEdge => ({
    id: `${source}->${target}`,
    source,
    target,
    origin: "user",
    ...(access ? { access } : {}),
    ...(conditional ? { conditional } : {}),
  });
  const baseModel = model(nodes, [e("fn", "role", "runs-as"), e("role", "data", "read"), e("role", "any", "unscoped")]);
  const report = (before: InfraModel, after: InfraModel) => {
    const diff = diffModels(before, after);
    return renderReport({
      mode: "check",
      modelPath: "diagram.json",
      terraformDir: "infra/",
      cloud: "aws",
      base: { state: "compared" },
      diff,
      diagram: renderDiagram(diff),
      warnings: [],
      terraformChanged: [],
      files: [],
      written: [],
      contentHash: "sha256:abc",
      signed: false,
    });
  };

  it("lists what widened, was added, narrowed or removed, widest first, in the words of the comment", () => {
    const head = model(nodes, [e("fn", "role", "runs-as"), e("role", "data", "write"), e("fn", "data", "admin")]);
    const text = report(baseModel, head);
    assert.match(text, /#### Access changes/);
    const lines = text.split("\n").filter((l) => /^- \*\*/.test(l));
    assert.deepEqual(lines, [
      "- **Added** Orders API (fn) has admin access to orders-data (data)",
      "- **Widened** api-role (role) to orders-data (data): read to write",
      "- **Removed** api-role (role) has unscoped access to Any resource &#40;&#42;&#41; (any)",
    ]);
  });

  it("says a narrowed grant is narrowed, and puts a new unscoped grant first", () => {
    const head = model(nodes, [e("fn", "role", "runs-as"), e("role", "data", "read"), e("role", "any", "unscoped"), e("fn", "any", "unscoped")]);
    const wider = model(nodes, [e("fn", "role", "runs-as"), e("role", "data", "admin"), e("role", "any", "unscoped")]);
    assert.match(report(wider, baseModel), /\*\*Narrowed\*\* api-role \(role\) to orders-data \(data\): admin to read/);
    const lines = report(baseModel, head).split("\n").filter((l) => /^- \*\*/.test(l));
    assert.deepEqual(lines, ["- **Added** Orders API (fn) has unscoped access to Any resource &#40;&#42;&#41; (any)"]);
  });

  it("lists a conditional grant as conditional, and a condition added or dropped as a change of its own", () => {
    const lines = (before: InfraModel, after: InfraModel) => report(before, after).split("\n").filter((l) => /^- \*\*/.test(l));
    const open = model(nodes, [e("fn", "role", "runs-as"), e("role", "data", "admin")]);
    const guarded = model(nodes, [e("fn", "role", "runs-as"), e("role", "data", "admin", true)]);
    assert.deepEqual(lines(open, guarded), ["- **Narrowed** api-role (role) to orders-data (data): admin to admin, conditional"]);
    assert.deepEqual(lines(guarded, open), ["- **Widened** api-role (role) to orders-data (data): admin, conditional to admin"]);
    assert.deepEqual(lines(model(nodes, [e("fn", "role", "runs-as")]), guarded), ["- **Added** api-role (role) has admin access to orders-data (data) (conditional)"]);
    assert.deepEqual(lines(guarded, model(nodes, [e("fn", "role", "runs-as")])), ["- **Removed** api-role (role) has admin access to orders-data (data) (conditional)"]);
    // A conditional admin grant is still listed ahead of a plain widening.
    const head = model(nodes, [e("fn", "role", "runs-as"), e("role", "data", "admin", true), e("role", "any", "unscoped"), e("fn", "any", "read")]);
    assert.deepEqual(lines(baseModel, head), [
      "- **Widened** api-role (role) to orders-data (data): read to admin, conditional",
      "- **Added** Orders API (fn) can read Any resource &#40;&#42;&#41; (any)",
    ]);
  });

  it("lists the level a conditional grant gives without its condition, and a change of it as a widening or narrowing", () => {
    const lines = (before: InfraModel, after: InfraModel) => report(before, after).split("\n").filter((l) => /^- \*\*/.test(l));
    const floor = (unconditional: ModelEdge["access"]): ModelEdge => ({ ...e("role", "data", "admin", true), ...(unconditional ? { unconditional } : {}) });
    const none = model(nodes, [e("fn", "role", "runs-as"), floor(undefined)]);
    const write = model(nodes, [e("fn", "role", "runs-as"), floor("write")]);
    const read = model(nodes, [e("fn", "role", "runs-as"), floor("read")]);
    assert.deepEqual(lines(none, write), ["- **Widened** api-role (role) to orders-data (data): admin, conditional to admin, conditional (write unconditional)"]);
    assert.deepEqual(lines(write, read), ["- **Narrowed** api-role (role) to orders-data (data): admin, conditional (write unconditional) to admin, conditional (read unconditional)"]);
    assert.deepEqual(lines(write, none), ["- **Narrowed** api-role (role) to orders-data (data): admin, conditional (write unconditional) to admin, conditional"]);
    assert.deepEqual(lines(model(nodes, [e("fn", "role", "runs-as")]), write), ["- **Added** api-role (role) has admin access to orders-data (data) (conditional; write without the condition)"]);
    assert.match(report(none, write), /\|admin, conditional \(write unconditional\)\|/);
  });

  it("is absent when no access type changed, and escapes what the model file names", () => {
    assert.doesNotMatch(report(baseModel, baseModel), /Access changes/);
    const plain = model(nodes, [e("fn", "role"), e("role", "data")]);
    assert.doesNotMatch(report(plain, model(nodes, [e("fn", "role"), e("role", "data"), e("fn", "data")])), /Access changes/);
    const hostile = [n("fn", "x](https://evil)<b>"), ...nodes.slice(1)];
    const text = report(model(hostile, [e("fn", "role")]), model(hostile, [e("fn", "role", "runs-as")]));
    assert.match(text, /\*\*Widened\*\* x&#93;&#40;https&#58;\/\/evil&#41;&#60;b&#62; \(fn\) to api-role \(role\): a plain connection to runs as/);
    assert.doesNotMatch(text, /<b>/);
  });

  it("keeps the widest grants when the list is cut: a new unscoped, then admin, then other widenings", () => {
    const many = Array.from({ length: 14 }, (_, i) => n(`t${i}`, `target ${i}`, "object-storage"));
    const all = [...nodes, ...many];
    // 14 grants widened from read to write, a new admin grant and a new unscoped grant
    const before = model(all, [e("fn", "role", "runs-as"), ...many.map((t) => e("role", t.id, "read"))]);
    const after = model(all, [
      e("fn", "role", "runs-as"),
      ...many.map((t) => e("role", t.id, "write")),
      e("fn", "data", "admin"),
      e("fn", "any", "unscoped"),
    ]);
    const lines = report(before, after).split("\n").filter((l) => /^- /.test(l));
    assert.equal(lines.length, 13, "12 lines and the count of what was cut");
    assert.equal(lines[0], "- **Added** Orders API (fn) has unscoped access to Any resource &#40;&#42;&#41; (any)");
    assert.equal(lines[1], "- **Added** Orders API (fn) has admin access to orders-data (data)");
    assert.match(lines[2] ?? "", /^- \*\*Widened\*\*/);
    assert.equal(lines[12], "- and 4 more not shown: 4 widened (widest: write)");
  });

  it("ranks a grant widened to unscoped or admin above one widened to write", () => {
    const before = model(nodes, [e("fn", "role", "runs-as"), e("role", "data", "read"), e("fn", "data", "read")]);
    const after = model(nodes, [e("fn", "role", "runs-as"), e("role", "data", "write"), e("fn", "data", "unscoped")]);
    const lines = report(before, after).split("\n").filter((l) => /^- \*\*/.test(l));
    assert.deepEqual(lines, [
      "- **Widened** Orders API (fn) to orders-data (data): read to unscoped",
      "- **Widened** api-role (role) to orders-data (data): read to write",
    ]);
  });

  it("ranks impersonating a drawn identity at the widest access that identity has, and at admin when that is not known", () => {
    const lines = (before: InfraModel, after: InfraModel) => report(before, after).split("\n").filter((l) => /^- \*\*/.test(l));
    const plain = [e("role", "any", "unscoped")];
    // fn may now act as a role that holds unscoped access: that is as wide as the role, ahead of a plain admin grant.
    const wide = lines(model(nodes, plain), model(nodes, [...plain, e("fn", "role", "runs-as"), e("fn", "data", "admin")]));
    assert.match(wide[0] ?? "", /^- \*\*Added\*\* Orders API \(fn\) runs as api-role \(role\)/);
    assert.match(wide[1] ?? "", /has admin access to orders-data/);
    // A role with nothing drawn on it cannot be shown to be narrow: it ranks as admin, above a write grant.
    const unknown = lines(model(nodes, []), model(nodes, [e("fn", "data", "write"), e("fn", "role", "runs-as")]));
    assert.match(unknown[0] ?? "", /runs as api-role/);
    // A role that can only read ranks as read, below a write grant.
    const narrow = lines(model(nodes, [e("role", "data", "read")]), model(nodes, [e("role", "data", "read"), e("fn", "role", "runs-as"), e("fn", "any", "write")]));
    assert.match(narrow[0] ?? "", /can write to Any resource/);
    assert.match(narrow[1] ?? "", /runs as api-role/);
  });

  it("puts a grant to anyone on the internet ahead of every other line", () => {
    const anyone = n("principal-aws-anyone", "Anyone (*)", "external");
    const all = [...nodes, anyone];
    const lines = report(model(all, []), model(all, [e("fn", "any", "unscoped"), e("fn", "data", "admin"), e("principal-aws-anyone", "data", "read")]))
      .split("\n")
      .filter((l) => /^- \*\*/.test(l));
    assert.match(lines[0] ?? "", /^- \*\*Added\*\* Anyone/);
    assert.match(lines[1] ?? "", /unscoped access/);
  });

  it("says how many lines were cut and of which kinds, and the widest of them", () => {
    const many = Array.from({ length: 16 }, (_, i) => n(`t${i}`, `target ${i}`, "object-storage"));
    const all = [...nodes, ...many];
    const before = model(all, [e("fn", "role", "runs-as"), ...many.slice(0, 4).map((t) => e("role", t.id, "write"))]);
    const after = model(all, [e("fn", "role", "runs-as"), ...many.slice(4).map((t) => e("role", t.id, "read"))]);
    const lines = report(before, after).split("\n").filter((l) => /^- /.test(l));
    assert.equal(lines.length, 13);
    // 12 added reads are shown; the 4 removed writes are what was cut, and the last line says so.
    assert.equal(lines[12], "- and 4 more not shown: 4 removed (widest: write)");
  });

  it("names each node by its id as well as its label, so two nodes called alike can be told apart", () => {
    const twins = [n("fn", "Orders API"), n("role", "Managed identity", "entra-id"), n("role-2", "Managed identity", "entra-id"), n("data", "orders-data", "object-storage")];
    const lines = report(model(twins, []), model(twins, [e("role", "data", "admin"), e("role-2", "data", "admin")]))
      .split("\n")
      .filter((l) => /^- \*\*/.test(l));
    assert.deepEqual(lines, [
      "- **Added** Managed identity (role) has admin access to orders-data (data)",
      "- **Added** Managed identity (role-2) has admin access to orders-data (data)",
    ]);
  });

  it("does not let a node id open markup, a link or a mention, or break the line, in a line about a node's own access or its change", () => {
    const hostile = "a`b\n[x](https://evil.example)<i>@octocat";
    const first = n(hostile, "Role", "entra-id");
    const selfLines = report(model([first], []), model([{ ...first, selfAccess: "admin" }], [])).split("\n").filter((l) => /widen its own access/.test(l));
    const changed = report(model([first], []), model([{ ...first, kind: "functions" }], [])).split("\n").filter((l) => /changed:/.test(l));
    assert.equal(selfLines.length, 1);
    assert.equal(changed.length, 1);
    for (const line of [...selfLines, ...changed]) assert.doesNotMatch(line, /[<>[\]`@]|:\/\//, line);
  });

  it("neutralises links, autolinks and mentions in names taken from the model file", () => {
    const labels = ["https://evil.example/x", "see www.evil.example", "WWW.EVIL.EXAMPLE", "ftp://evil.example", "@octocat and @org/team", "a@evil.example", "mailto:a@evil.example", "<https://evil.example>", "[x](https://evil.example)", "&#64;octocat &commat;octocat"];
    for (const label of labels) {
      const text = markdownText(label);
      assert.doesNotMatch(text, /:\/\//, label);
      assert.doesNotMatch(text, /www\./i, label);
      assert.doesNotMatch(text, /@/, label);
      assert.doesNotMatch(text, /[<>[\]()]/, label);
      assert.doesNotMatch(text, /&(?!#\d+;)/, label);
    }
    assert.equal(markdownText("see www.evil.example"), "see www&#46;evil.example");
    assert.equal(markdownText("https://evil.example"), "https&#58;//evil.example");
    for (const label of labels) {
      const hostile = [n("fn", label), ...nodes.slice(1)];
      const text = report(model(hostile, [e("fn", "role")]), model(hostile, [e("fn", "role", "runs-as")]));
      const line = text.split("\n").find((l) => l.startsWith("- **Widened**")) ?? "";
      assert.doesNotMatch(line, /:\/\/|www\.|@|[<>[\]]/i, label);
    }
  });
});
