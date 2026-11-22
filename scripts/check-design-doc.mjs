/**
 * Design-doc gate: every colour `DESIGN.md` names must be the colour that
 * `src/styles/globals.css` actually declares.
 *
 *   node scripts/check-design-doc.mjs
 *
 * `check-colour-tokens.mjs` proves every colour in `src/` comes from a token and
 * `check-contrast.mjs` measures those tokens against WCAG. Neither reads
 * `DESIGN.md`, so the doc is free to drift — and it had: `input` and `ink-faint`
 * were darkened in the CSS for contrast and the doc kept advertising the old,
 * failing values. `DESIGN.md` reads as the palette's source of truth, so the
 * next person to add a swatch copies a value the CSS has already moved past.
 *
 * `globals.css` is authoritative. This gate never rewrites it — a failure here
 * means update the DOC.
 *
 * Two rules:
 *
 *   1. Every entry in the front-matter `colors:` map must exist as a `--name`
 *      declaration in `globals.css`, with an identical value.
 *   2. Every six-digit hex written in the PROSE must be a value the front-matter
 *      declares. Prose names colours in passing ("Fired Terracotta (`#a8512a`)"),
 *      and that is where stale values hide.
 *
 * Coverage is deliberately NOT checked: the doc curates the core palette, not
 * every border and tint family in the CSS.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const doc = fileURLToPath(new URL("../DESIGN.md", import.meta.url));
const css = fileURLToPath(new URL("../src/styles/globals.css", import.meta.url));

/**
 * Hex values the prose may name although they are not in the `colors:` map,
 * each with the reason. Keep this list short: an entry with no reason is how
 * drift returns.
 */
const PROSE_ALLOW = new Map([
  [
    "#f5f5f5",
    "The No Raw Gray Rule's counter-example — quoted precisely because it is " +
      "forbidden. A cold grey that must never become a token.",
  ],
  [
    "#dad3c4",
    "The canvas edge stroke. It is inlined in components/workspace/graph.ts and the " +
      "SVG export (scripts/check-colour-tokens.mjs excuses both by value) and is not " +
      "a token yet, so the prose names the literal the code paints.",
  ],
]);

const source = readFileSync(doc, "utf8");
const frontMatterEnd = source.indexOf("\n---", 3);
if (frontMatterEnd === -1) {
  console.error("check-design-doc: DESIGN.md has no closing front-matter fence.");
  process.exit(1);
}
const frontMatter = source.slice(0, frontMatterEnd);
const prose = source.slice(frontMatterEnd);

/** `--name: #hex` from globals.css, first declaration wins (`:root` before any override). */
const live = new Map();
for (const m of readFileSync(css, "utf8").matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})/g)) {
  if (!live.has(m[1])) live.set(m[1], m[2].toLowerCase());
}

const declared = new Set();
const errors = [];
let entries = 0;

for (const m of frontMatter.matchAll(/^ {2}([a-z0-9-]+):\s*"(#[0-9a-fA-F]{3,8})"/gm)) {
  const [, name, value] = m;
  const hex = value.toLowerCase();
  declared.add(hex);
  entries += 1;
  const actual = live.get(name);
  if (actual === undefined) {
    errors.push(`  DESIGN.md colors.${name}: "${value}" — no --${name} in src/styles/globals.css.`);
  } else if (actual !== hex) {
    errors.push(`  DESIGN.md colors.${name}: "${value}" — globals.css declares --${name}: ${actual}.`);
  }
}

// `prose` starts at the closing fence, so its line 1 is this far into the file.
const proseStartLine = frontMatter.split(/\r?\n/).length;

prose.split(/\r?\n/).forEach((line, i) => {
  for (const m of line.matchAll(/#[0-9a-fA-F]{6}\b/g)) {
    const hex = m[0].toLowerCase();
    if (declared.has(hex) || PROSE_ALLOW.has(hex)) continue;
    errors.push(
      `  DESIGN.md:${proseStartLine + i}  ${m[0]} is named in prose but is not in the colors: map.\n      ${line.trim().slice(0, 110)}`,
    );
  }
});

if (errors.length) {
  console.error(
    `check-design-doc: ${errors.length} colour${errors.length === 1 ? "" : "s"} in DESIGN.md disagree${errors.length === 1 ? "s" : ""} with src/styles/globals.css.\n`,
  );
  console.error(errors.join("\n"));
  console.error(
    "\nglobals.css is authoritative — check:contrast gates it. Update DESIGN.md to match," +
      "\nnot the other way round. A prose hex that is deliberately NOT a token (a" +
      "\ncounter-example) goes in PROSE_ALLOW in scripts/check-design-doc.mjs WITH its reason.\n",
  );
  process.exit(1);
}

console.log(`check-design-doc: ${entries} colours in DESIGN.md, every one matching globals.css.`);
