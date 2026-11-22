/**
 * Registers the `@/` alias resolver on Node's module system. Passed via
 * `--import` so it applies to the main module AND every worker thread the test
 * runner spawns — a `--loader` flag would also work but is deprecated in favour
 * of this shape.
 */
import { register } from "node:module";

register("./alias-loader.mjs", import.meta.url);
