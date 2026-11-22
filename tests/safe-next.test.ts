/**
 * `safeNextPath`: the post-sign-in landing path must stay on this site, whatever
 * spelling of an off-site URL a crafted link uses.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { safeNextPath } from "../src/utils/safe-next.ts";

describe("safeNextPath", () => {
  it("keeps a same-site path, with its query and fragment", () => {
    assert.equal(safeNextPath("/invite/abc_DEF-123"), "/invite/abc_DEF-123");
    assert.equal(safeNextPath("/workspace?mode=chat#top"), "/workspace?mode=chat#top");
  });

  it("refuses an empty value and anything that is not a path", () => {
    for (const raw of [null, undefined, "", "workspace", "https://evil.test/", "javascript:alert(1)"]) {
      assert.equal(safeNextPath(raw), null, String(raw));
    }
  });

  it("refuses every protocol-relative spelling a browser would follow off-site", () => {
    for (const raw of ["//evil.test", "/\\evil.test", "/\t/evil.test", "/\n/evil.test", "\\/evil.test"]) {
      assert.equal(safeNextPath(raw), null, JSON.stringify(raw));
    }
  });
});
