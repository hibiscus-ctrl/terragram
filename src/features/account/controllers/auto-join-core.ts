/**
 * Which orgs a sign-in may auto-join by EMAIL MATCH — pending invites
 * (`acceptPendingInvites`) and SCIM records (`reconcileScimMemberships`) — decided
 * from how the user authenticated.
 *
 * Both paths grant membership on nothing but "this account's confirmed email equals
 * the invited/provisioned address", with no token possession. That is sound only
 * while the email was confirmed by someone other than the party that benefits:
 * a mailbox round trip (email/password, magic link) or an OAuth provider's own
 * verified-email claim (GitHub, Google).
 *
 * A SAML identity breaks that. Supabase Auth marks the email a SAML assertion
 * carries as verified and does not check it against the provider's registered
 * domains (IdP-initiated sign-ins are accepted too), so the email on an `sso:`
 * account is whatever the org's own IdP chose to assert. Every Team org's Admin
 * controls such an IdP. Trusting it cross-org would let an Admin assert
 * `invitee@victim.com` and pick up that address's pending invites — and SCIM
 * seats — in orgs they do not belong to.
 *
 * The rule: an SSO account auto-joins ONLY the org that owns the SSO provider it
 * signed in through. That org's IdP is the authority its own invites and SCIM
 * records already trust, so nothing it grants is new; invites from any other org
 * still work, through the explicit invite-token link. Anything SSO-shaped whose
 * provider cannot be pinned down auto-joins nothing.
 */

export type AutoJoinScope =
  /** Email confirmed by a mailbox round trip or an OAuth provider: match any org. */
  | { kind: "any" }
  /** SAML account: match only the org owning this Supabase SSO provider. */
  | { kind: "sso-provider"; providerId: string }
  /** SSO-shaped but the provider is ambiguous or missing: match nothing. */
  | { kind: "none" };

/** The fields of a Supabase `User` the scope reads. Both are server-held — not
 *  JWT claims — so the caller passes the full `User` from `getUser()`/the code
 *  exchange, never the render-path `AuthenticatedUser`. */
export type AutoJoinUser = {
  app_metadata?: { provider?: unknown; providers?: unknown } | null;
  identities?: { provider?: unknown }[] | null;
};

const SSO_PROVIDER_RE = /^sso:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function providerNames(user: AutoJoinUser): string[] {
  const names: unknown[] = [
    user.app_metadata?.provider,
    ...(Array.isArray(user.app_metadata?.providers) ? user.app_metadata.providers : []),
    ...(user.identities ?? []).map((i) => i?.provider),
  ];
  return names.filter((n): n is string => typeof n === "string");
}

/**
 * Supabase names a SAML identity `sso:<provider uuid>`. ANY sso-prefixed
 * provider on the account narrows the scope — an account is never trusted more
 * because it also carries a password identity.
 */
export function autoJoinScope(user: AutoJoinUser): AutoJoinScope {
  const names = providerNames(user);
  const sso = names.filter((n) => n.toLowerCase().startsWith("sso"));
  if (sso.length === 0) return { kind: "any" };
  const ids = new Set(
    sso.map((n) => SSO_PROVIDER_RE.exec(n)?.[1]?.toLowerCase() ?? null),
  );
  const [providerId] = ids;
  if (ids.size !== 1 || !providerId) return { kind: "none" };
  return { kind: "sso-provider", providerId };
}

/**
 * Resolve the scope to the org filter an email-match lookup must apply:
 * `{ orgId: null }` = any org, `{ orgId }` = that org only, `null` = auto-join
 * nothing. `findOrgBySsoProvider` maps a Supabase SSO provider to the org whose
 * `org_sso` mapping owns it.
 */
export async function resolveAutoJoinOrg(
  user: AutoJoinUser,
  findOrgBySsoProvider: (providerId: string) => Promise<string | null>,
): Promise<{ orgId: string | null } | null> {
  const scope = autoJoinScope(user);
  if (scope.kind === "any") return { orgId: null };
  if (scope.kind === "none") return null;
  const orgId = await findOrgBySsoProvider(scope.providerId);
  return orgId ? { orgId } : null;
}
