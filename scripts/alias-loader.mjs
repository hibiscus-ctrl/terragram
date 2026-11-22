/**
 * Node resolve hook that teaches plain Node the `@/` tsconfig alias.
 *
 *   node --import ./scripts/register-alias.mjs --test tests
 *
 * `@/*` is a tsconfig path: Next resolves it because it bundles, `tsc` because it
 * reads the same config — and plain `node --test` resolved NEITHER, which forced
 * every module the unit suite loads to spell its value imports as relative
 * specifiers with an explicit `.ts`. That split ran to ~45 parent-escaping
 * imports, a comment in a dozen files explaining it, and a gate computing the
 * import-graph closure to enforce both halves. This hook replaces all of it:
 * `@/` resolves everywhere, so the alias is simply the rule.
 *
 * Resolution mirrors tsconfig's: `@/x` → `src/x`, trying the bare path, `.ts`,
 * `.tsx`, then `/index.ts`. A specifier that resolves to nothing falls through to
 * Node's own resolver so the error names the real specifier, not this hook.
 */
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const srcDir = fileURLToPath(new URL("../src/", import.meta.url));

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const base = join(srcDir, specifier.slice(2));
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return nextResolve(pathToFileURL(candidate).href, context);
      }
    }
  }
  return nextResolve(specifier, context);
}
