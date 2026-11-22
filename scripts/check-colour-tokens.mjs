/**
 * Colour-token gate: DESIGN.md's No Raw Gray Rule, made executable. "No ad-hoc
 * grays, no ad-hoc hex. Every neutral is a named warm token."
 *
 *   node scripts/check-colour-tokens.mjs
 *
 * Three forms are caught in `src/**\/*.{ts,tsx}`:
 *
 *   1. Tailwind arbitrary colour classes — `bg-[#f5f5f5]`, `text-[#c2b8a8]`,
 *      `hover:border-[#322a1c]` and so on.
 *   2. Hex string literals that feed an inline `style` or an SVG attribute.
 *   3. Tailwind's stock cold neutrals — `text-gray-500`, `bg-slate-100`,
 *      `border-zinc-200`, `stone`, `neutral` — which DESIGN.md names as forbidden
 *      because they fail AA on the cream and are not warm.
 *
 * All of them belong in `src/styles/globals.css`. `scripts/check-contrast.mjs`
 * then measures what is declared there — which only means anything if this file
 * holds, because a colour written inline is a colour that gate cannot see.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const srcDir = join(root, "src");

/**
 * Files that legitimately carry literal hex, each with the reason. `values`
 * narrows an entry to those exact hexes (case-insensitive); without it the whole
 * file is exempt, which is for files that never reach the stylesheet at all.
 * Keep this list short and keep the reason attached — an entry with no reason is
 * how the drift comes back.
 */
const ALLOW = new Map([
  [
    "app/global-error.tsx",
    {
      reason:
        "The global error boundary replaces the entire document, including <head>. It renders " +
        "when the app has failed hard enough that the stylesheet may never have loaded, so " +
        "every colour is inline by necessity: a var() would resolve to nothing.",
    },
  ],
  [
    "app/icon.tsx",
    {
      reason:
        "The favicon, rendered by Satori (next/og ImageResponse), not by a browser: there is " +
        "no document and no custom properties to resolve against.",
    },
  ],
  [
    "app/opengraph-image.tsx",
    {
      reason: "The social card, rendered by Satori like app/icon.tsx; no cascade to resolve a var() in.",
    },
  ],
  [
    "app/layout.tsx",
    {
      values: ["#faf8f4"],
      reason:
        "`viewport.themeColor` is a <meta> value the OS browser chrome reads before any CSS is " +
        "parsed; it has to be a literal (it is --background).",
    },
  ],
  [
    "app/(auth)/auth-ui.tsx",
    {
      values: ["#ea4335", "#4285f4", "#fbbc05", "#34a853"],
      reason:
        "Google's four brand colours inside their sign-in mark. Third-party brand assets are " +
        "reproduced exactly and are not ours to theme.",
    },
  ],
  [
    "components/workspace/diagram-svg.ts",
    {
      reason:
        "The diagram export is a standalone SVG file the user downloads. It never reaches our " +
        "cascade, so a var() would resolve to nothing; the literals mirror the tokens.",
    },
  ],
  [
    "features/emails/invite.ts",
    {
      reason:
        "The invite email is HTML rendered by the recipient's mail client. It never reaches our " +
        "cascade, so a var() would resolve to nothing; the literals mirror the tokens they name.",
    },
  ],
  [
    "features/workspace/model.ts",
    {
      values: ["#047857", "#2563eb", "#7c3aed", "#b45309", "#0e7490", "#665e4f"],
      reason:
        "CATEGORY_META.color — the --cat-* legend hues — also feeds the standalone SVG export " +
        "(components/workspace/diagram-svg.ts), where a var() would resolve to nothing.",
    },
  ],
  // Colours that are not tokens YET. Each is a palette decision for DESIGN.md
  // rather than a mechanical swap, so it is excused by value until it lands.
  [
    "components/site-footer.tsx",
    {
      values: ["#322a1c", "#1c1710", "#c2b8a8", "#9b907e", "#2c2417"],
      reason:
        "The footer band runs a darker ink than --surface (#1c1710, rules #322a1c / #2c2417, " +
        "chip text #c2b8a8, column headings #9b907e). Not yet tokens.",
    },
  ],
  [
    "app/error.tsx",
    {
      values: ["#f6e7df"],
      reason: "The error-boundary glyph tile tint (shared with global-error.tsx). Not yet a token.",
    },
  ],
  [
    "app/(app)/error.tsx",
    {
      values: ["#f6e7df"],
      reason: "The error-boundary glyph tile tint (shared with global-error.tsx). Not yet a token.",
    },
  ],
  [
    "components/workspace/canvas.tsx",
    {
      values: ["#e6e0d3"],
      reason: "The canvas dot-grid colour (React Flow <Background color>). Not yet a token.",
    },
  ],
  [
    "components/workspace/graph.ts",
    {
      values: ["#dad3c4"],
      reason:
        "The derived-edge stroke, the same value the SVG export and the scrollbar thumb in " +
        "globals.css use. Not yet a token.",
    },
  ],
]);

/* ---------------------------------------------------------------- patterns -- */

/** `bg-[#rrggbb]`, `text-[#fff]`, `hover:border-[#rrggbbaa]`, … */
const ARBITRARY_COLOUR = /\[#[0-9a-fA-F]{3,8}\]/g;
/** `"#rrggbb"` / `'#rrggbb'` — a hex literal in TypeScript, headed for a style. */
const HEX_LITERAL = /["'`]#[0-9a-fA-F]{3,8}["'`]/g;
/** `text-gray-500`, `hover:bg-slate-100`, `border-zinc-200/50`, … */
const RAW_GRAY = /\b[a-z]+(?:-[a-z]+)*-(?:gray|slate|zinc|neutral|stone)-\d{2,3}\b/g;

/* -------------------------------------------------------------------- run -- */

const walk = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();

/**
 * Blank out `//` and block comments, preserving length and newlines so line
 * numbers and the echoed source line stay accurate. A comment recording the
 * ad-hoc hex a token replaced is the opposite of a violation.
 */
function maskComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, lead) => lead + " ".repeat(m.length - lead.length));
}

const hexOf = (match) => match.replace(/[^#0-9a-fA-F]/g, "").toLowerCase();

const errors = [];

for (const file of walk(srcDir)) {
  const rel = relative(srcDir, file).split(sep).join("/");
  const allow = ALLOW.get(rel);
  if (allow && !allow.values) continue;
  const allowed = new Set(allow?.values ?? []);

  const raw = readFileSync(file, "utf8");
  const lines = maskComments(raw).split(/\r?\n/);
  const rawLines = raw.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const [re, kind] of [
      [ARBITRARY_COLOUR, "arbitrary colour class"],
      [HEX_LITERAL, "hex literal"],
      [RAW_GRAY, "raw Tailwind gray"],
    ]) {
      re.lastIndex = 0;
      for (const match of line.matchAll(re)) {
        if (kind !== "raw Tailwind gray" && allowed.has(hexOf(match[0]))) continue;
        errors.push(
          `  src/${rel}:${i + 1}  ${kind}  ${match[0]}\n      ${rawLines[i].trim().slice(0, 110)}`,
        );
      }
    }
  });
}

if (errors.length) {
  console.error(
    `check-colour-tokens: ${errors.length} raw colour${errors.length === 1 ? "" : "s"} outside the token system.\n`,
  );
  console.error(errors.join("\n\n"));
  console.error(
    "\nUse the token DESIGN.md prescribes (a warm neutral is `muted-foreground` / the `ink-*`" +
      "\nramp, never a stock gray). If the shade is missing, add it to :root and @theme inline" +
      "\nin src/styles/globals.css and use the utility (or var(--name) for an inline style)." +
      "\nIf it genuinely cannot be a token, add it to ALLOW in scripts/check-colour-tokens.mjs" +
      "\nWITH the reason.\n",
  );
  process.exit(1);
}

console.log("check-colour-tokens: every colour in src/ resolves to a design token.");
