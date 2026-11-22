/**
 * `escapeLikePattern` — the guard that keeps a request-supplied value from being
 * read as a LIKE *pattern* by a PostgREST `.ilike()` filter.
 *
 * The bug this pins: `.ilike()` is parameterised (so this was never SQL
 * injection), but its operand is still pattern syntax. The sign-in SCIM
 * reconciliation matched `scim_users.user_name` against the account's email
 * unescaped, so `a_b@acme.test` also matched `axb@acme.test`'s SCIM record.
 *
 * Run with `node --experimental-strip-types --test tests`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { escapeLikePattern } from "../src/libs/supabase/like-pattern.ts";

describe("escapeLikePattern", () => {
  it("escapes the two LIKE wildcards so they match literally", () => {
    assert.equal(escapeLikePattern("%"), "\\%");
    assert.equal(escapeLikePattern("_"), "\\_");
    assert.equal(escapeLikePattern("%admin%"), "\\%admin\\%");
    assert.equal(escapeLikePattern("a_b"), "a\\_b");
  });

  it("escapes the escape character itself, and does it FIRST", () => {
    // If `\` were escaped after `%`, the backslash this pass introduces would be
    // re-escaped and the `%` would go back to being a wildcard.
    assert.equal(escapeLikePattern("\\"), "\\\\");
    assert.equal(escapeLikePattern("\\%"), "\\\\\\%");
  });

  it("leaves an ordinary value untouched", () => {
    // The real operands: a GitHub login, an email, an org slug.
    assert.equal(escapeLikePattern("acme-platform"), "acme-platform");
    assert.equal(escapeLikePattern("someone@example.com"), "someone@example.com");
    assert.equal(escapeLikePattern(""), "");
  });

  it("is idempotent in effect — re-escaping a value never re-enables a wildcard", () => {
    const once = escapeLikePattern("%");
    const twice = escapeLikePattern(once);
    // Double-escaping over-escapes (a literal backslash appears), but crucially
    // the `%` stays escaped — it can never revert to a wildcard.
    assert.ok(twice.endsWith("\\%"));
  });
});
