/**
 * Monetization rule: public repos are always free; a PRIVATE repo requires the
 * `privateRepos` capability. Unknown visibility (`null` — not yet learned) is
 * treated as not-locked, so we never wrongly paywall a repo we haven't confirmed
 * is private. Takes the resolved CAPABILITIES (not a raw Stripe plan) — call
 * `resolveEntitlements(org).capabilities`.
 */
export function isRepoLocked(
  repo: { private: boolean | null },
  caps: Pick<Capabilities, "privateRepos">,
): boolean {
  return repo.private === true && !caps.privateRepos;
}

/**
 * The product tiers, and the capability matrix that defines what each unlocks.
 * This is the SINGLE source of truth for "what can this org do", fed from the org's
 * Stripe plan — see {@link resolveEntitlements}. Only the hosted conveniences are
 * gated here.
 */
export type ProductTier = "free" | "team" | "enterprise";

export interface Capabilities {
  /** persist + view findings for PRIVATE repos. */
  privateRepos: boolean;
  /** the full maintained crosswalk pack (beyond the free starter framework). */
  fullCrosswalk: boolean;
  /** the hosted, immutable auditor evidence store. */
  hostedEvidence: boolean;
  /** cross-repository fleet aggregation + trends. */
  fleetAggregation: boolean;
  /** the read-only auditor role. */
  auditorRole: boolean;
  /** SSO / SAML / SCIM. */
  sso: boolean;
}

const TIER_CAPABILITIES: Record<ProductTier, Capabilities> = {
  free: {
    privateRepos: false,
    fullCrosswalk: false,
    hostedEvidence: false,
    fleetAggregation: false,
    auditorRole: false,
    sso: false,
  },
  team: {
    privateRepos: true,
    fullCrosswalk: true,
    hostedEvidence: true,
    fleetAggregation: true,
    auditorRole: true,
    sso: true,
  },
  enterprise: {
    privateRepos: true,
    fullCrosswalk: true,
    hostedEvidence: true,
    fleetAggregation: true,
    auditorRole: true,
    sso: true,
  },
};

export function capabilitiesForTier(tier: ProductTier): Capabilities {
  return TIER_CAPABILITIES[tier];
}

/**
 * Derive the product tier from `crosswalk_tier` (Cloud). Pure. Managed models are
 * NOT a tier — they're an orthogonal metered add-on keyed off `orgs.plan='payg'`
 * (gated in `/api/proxy-token`), available on any plan. So the tier ladder is just
 * Free → Team → Enterprise.
 */
export function tierFromStripe(crosswalkTier: string | null | undefined): ProductTier {
  const t = (crosswalkTier ?? "").trim().toLowerCase();
  if (t === "enterprise") return "enterprise";
  if (t === "team") return "team";
  return "free";
}

export interface Entitlements {
  tier: ProductTier;
  capabilities: Capabilities;
}

/**
 * Resolve an org's entitlements from its Stripe `crosswalk_tier`. Every gate
 * consults this so the whole app shares one capability model.
 */
export function resolveEntitlements(org: {
  plan?: string | null;
  crosswalk_tier?: string | null;
}): Entitlements {
  const tier = tierFromStripe(org.crosswalk_tier);
  return { tier, capabilities: capabilitiesForTier(tier) };
}
