/**
 * The managed models a user may choose between.
 *
 * **Every entry must have an `eu.` Bedrock inference profile.** Managed inference
 * runs through the EU/UK gateway and the proxy's IAM grant is scoped to the `eu`
 * prefix, so a model without one is not a slower or pricier option — it is a model
 * the proxy cannot serve. What happens then is worse than an error: the proxy falls
 * through to its DEFAULT model and answers under the name the caller asked for,
 * metered at the default's rate. The user is quietly served something they did not
 * pick, and the receipt records the model they did.
 *
 * That is why Claude Fable is absent (Bedrock publishes only `us.` and `global.`
 * profiles for Fable 5 and 5.1, plus a mandatory data-retention opt-in), and why
 * Haiku is too. Both were verified against the AWS model cards, not assumed; re-check
 * the card before adding anything, because "it exists on Bedrock" is not the same
 * claim as "it exists on Bedrock in the EU".
 *
 * Keep this list in step with the proxy's `BEDROCK_MODEL_MAP`: an id here with no key
 * there is served as something else. Pure — no imports, no I/O — so the gate is
 * testable without a proxy.
 */

/** The ids, as a tuple, so the zod enum and the type both derive from one list. */
export const MANAGED_MODEL_IDS = ["claude-sonnet-5-5", "claude-opus-5-5"] as const;

export type ManagedModelId = (typeof MANAGED_MODEL_IDS)[number];

/** What a managed turn uses when the user has expressed no preference. */
export const DEFAULT_MANAGED_MODEL: ManagedModelId = "claude-sonnet-5-5";

/**
 * Ids we used to offer, and the 5.5 model each one moves to.
 *
 * The proxy still maps the 5 ids, but they are no longer offered, so a stored
 * setting or a deployment's `TERRAGRAM_WORKSPACE_MODEL` naming one is migrated
 * here instead of refused. Refusing would be worse than it sounds: a settings blob
 * that fails to parse is replaced by the defaults wholesale, so one stale model id
 * would also reset every other preference. The tier is kept — an Opus user stays on
 * Opus — rather than dropping everyone to the default.
 */
const LEGACY_MANAGED_MODELS: Readonly<Record<string, ManagedModelId>> = {
  "claude-sonnet-5": "claude-sonnet-5-5",
  "claude-opus-5": "claude-opus-5-5",
};

/** Maps a retired id to its 5.5 successor; anything else is returned untouched. */
export function migrateManagedModelId(value: unknown): unknown {
  return typeof value === "string" && Object.hasOwn(LEGACY_MANAGED_MODELS, value)
    ? LEGACY_MANAGED_MODELS[value]
    : value;
}

export interface ManagedModel {
  id: ManagedModelId;
  label: string;
  /** Shown beside the choice. The billing page carries the actual rates — this says
   *  only which way the trade runs, so it cannot drift out of step with the card. */
  note: string;
}

export const MANAGED_MODELS: readonly ManagedModel[] = [
  {
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    note: "Fast, and the cheapest per token. Enough for most briefs.",
  },
  {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    note: "Stronger on long or ambiguous briefs. Costs more per token.",
  },
];

/**
 * Whether a value is a model we actually serve.
 *
 * The proxy treats any requested id containing a `.` as a raw Bedrock id and passes
 * it straight through, so an unchecked string arriving here could name a US-region
 * profile and quietly move a UK customer's inference out of the country. Everything
 * that can reach the proxy goes through this gate.
 */
export function isManagedModelId(value: unknown): value is ManagedModelId {
  return (
    typeof value === "string" && (MANAGED_MODEL_IDS as readonly string[]).includes(value)
  );
}
