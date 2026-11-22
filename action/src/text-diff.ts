// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A line diff and its unified rendering, for the "Terraform differs from the model"
 * report. Myers' O(ND) algorithm; a pair of files too far apart for it to finish within
 * a bound is reported as one block that replaces the other, which is still correct,
 * only less minimal.
 */

type Op = { kind: "eq" | "del" | "ins"; line: string };

const MAX_EDIT_DISTANCE = 3000;

function lines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function wholesale(a: string[], b: string[]): Op[] {
  return [...a.map((line): Op => ({ kind: "del", line })), ...b.map((line): Op => ({ kind: "ins", line }))];
}

function myers(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;

  search: for (let d = 0; d <= max; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0))) x = v[offset + k + 1] ?? 0;
      else x = (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break search;
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
  }
  if (found < 0) return wholesale(a, b);

  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1] as Int32Array;
    const at = (k: number) => prev[k + d - 1] ?? 0;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: "eq", line: a[x - 1] as string });
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      ops.push({ kind: "ins", line: b[y - 1] as string });
      y -= 1;
    } else {
      ops.push({ kind: "del", line: a[x - 1] as string });
      x -= 1;
    }
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: "eq", line: a[x - 1] as string });
    x -= 1;
    y -= 1;
  }
  return ops.toReversed();
}

/**
 * `diff -u` style output (3 lines of context), or "" when the texts are equal. Line
 * endings are not compared: CRLF and LF are the same text here.
 */
export function unifiedDiff(
  before: string,
  after: string,
  beforeName: string,
  afterName: string,
  context = 3,
): string {
  const a = lines(before.replaceAll("\r\n", "\n"));
  const b = lines(after.replaceAll("\r\n", "\n"));
  const ops = myers(a, b);
  if (ops.every((op) => op.kind === "eq")) return "";

  // Each op's line numbers (1-based) in the old and the new text.
  let oldLine = 1;
  let newLine = 1;
  const placed = ops.map((op) => {
    const at = { op, oldLine, newLine };
    if (op.kind !== "ins") oldLine += 1;
    if (op.kind !== "del") newLine += 1;
    return at;
  });

  const out = [`--- ${beforeName}`, `+++ ${afterName}`];
  const changes = placed.flatMap((p, i) => (p.op.kind === "eq" ? [] : [i]));
  let i = 0;
  while (i < changes.length) {
    // Grow a hunk while the next change is within twice the context of the last one.
    let last = changes[i] as number;
    let j = i + 1;
    while (j < changes.length && (changes[j] as number) - last <= 2 * context + 1) {
      last = changes[j] as number;
      j += 1;
    }
    const start = Math.max(0, (changes[i] as number) - context);
    const end = Math.min(placed.length - 1, last + context);
    const slice = placed.slice(start, end + 1);
    const oldCount = slice.filter((p) => p.op.kind !== "ins").length;
    const newCount = slice.filter((p) => p.op.kind !== "del").length;
    const first = slice[0] as (typeof placed)[number];
    // An empty side is addressed by the line before it, as `diff -u` does.
    const oldStart = oldCount === 0 ? first.oldLine - 1 : first.oldLine;
    const newStart = newCount === 0 ? first.newLine - 1 : first.newLine;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const p of slice) out.push(`${p.op.kind === "eq" ? " " : p.op.kind === "del" ? "-" : "+"}${p.op.line}`);
    i = j;
  }
  return `${out.join("\n")}\n`;
}
