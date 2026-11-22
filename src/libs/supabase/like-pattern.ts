/**
 * LIKE-metacharacter escaping for PostgREST `.like()` / `.ilike()` filters.
 *
 * PostgREST's `ilike` operator passes its operand to SQL `ILIKE`, where `%` and
 * `_` are WILDCARDS, not literals. It is parameterised — this is not SQL
 * injection — but the *pattern language* is still reachable by whoever controls
 * the operand. The sign-in SCIM reconciliation looks `scim_users` up by the
 * account's email, and `_` is legal in an address: unescaped, `a_b@acme.test`
 * also matches `axb@acme.test`, linking someone else's SCIM seat (and its org
 * membership) to this account.
 *
 * Every such lookup wants an EXACT, case-insensitive match — `ilike` is used only
 * because the stored value keeps its original casing while the lookup key may not.
 * `escapeLikePattern` preserves exactly that: case-insensitivity stays, wildcard
 * semantics go away.
 *
 * Escaping is `\`-prefixing, which matches Postgres's default LIKE escape
 * character. `\` itself must be escaped FIRST, or escaping `%` would produce a
 * backslash that the next pass re-escapes into a literal one.
 */

/**
 * Escape `%`, `_` and `\` in a value destined for a `.like()` / `.ilike()` filter,
 * so it matches literally instead of as a wildcard pattern.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
