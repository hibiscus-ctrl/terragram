import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { shareLinkOpens } from "../src/features/workspace/share-link.ts";

/**
 * The decision `resolveShareLink` makes about a stored link before it serves a
 * workspace to an anonymous reviewer. The owner check is defence in depth behind
 * the RLS write policy: a link row its workspace's owner did not create is a
 * planted one, and it must not open the workspace even if it reached the table.
 */

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-10-10T12:00:00Z");

const link = (over: Partial<Parameters<typeof shareLinkOpens>[0]> = {}) => ({
  created_by: OWNER,
  expires_at: "2026-10-20T12:00:00Z",
  revoked_at: null,
  ...over,
});

describe("shareLinkOpens", () => {
  it("opens a live link the workspace's owner created", () => {
    assert.equal(shareLinkOpens(link(), OWNER, NOW), true);
  });

  it("refuses a link created by anyone but the workspace's owner", () => {
    assert.equal(shareLinkOpens(link({ created_by: OTHER }), OWNER, NOW), false);
  });

  it("refuses a revoked link", () => {
    assert.equal(shareLinkOpens(link({ revoked_at: "2026-10-09T12:00:00Z" }), OWNER, NOW), false);
  });

  it("refuses an expired link", () => {
    assert.equal(shareLinkOpens(link({ expires_at: "2026-10-10T11:59:59Z" }), OWNER, NOW), false);
  });
});
