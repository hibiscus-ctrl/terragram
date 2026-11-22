import { readdirSync } from "node:fs";
import path from "node:path";

/** Every file under `dir` whose name matches `pattern`, as sorted full paths. */
export function filesUnder(dir: string, pattern = /\.tsx?$/): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}
