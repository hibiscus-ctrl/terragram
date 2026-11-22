import { z } from "zod";

import { overManagedCap } from "@/features/billing/managed-meter";
import { isModelProxyConfigured, mintProxyToken, type ProxyToken } from "@/features/billing/proxy";
import {
  assembleModel,
  type ComponentRequest,
  type ComposeResult,
  describeTurn,
} from "./engine.ts";
import { KIND_BY_ID, KIND_LABELS, MODEL_KIND_IDS } from "./kinds.ts";
import {
  DEFAULT_MANAGED_MODEL,
  isManagedModelId,
  type ManagedModelId,
  migrateManagedModelId,
} from "./managed-models.ts";
import { CLOUDS, EMPTY_MODEL, type InfraModel } from "./model.ts";

/**
 * Managed UK inference for Chat → Model. Reuses the same EU Bedrock gateway the
 * engine already talks to (`tmpx_` HMAC token → the proxy's Anthropic `/v1/messages`
 * endpoint) and forces a single tool call so the model returns a structured set of
 * components rather than prose we'd have to parse. The component vocabulary is the
 * SAME one the Terraform generator understands, so managed output stays coherent
 * with the deterministic emitter. Everything else in the workspace (parse, emit,
 * evidence) is deterministic and needs no inference.
 */

/**
 * The model specifier a managed turn resolves to: the user's choice, else this
 * deployment's configured default, else Sonnet.
 *
 * Both inputs are checked against the served list rather than trusted. The proxy
 * forwards any id containing a `.` as a raw Bedrock id, so an unvalidated string
 * arriving here could name a `us.` profile and move a UK customer's inference out
 * of the country; and an id the proxy cannot serve is answered by its default under
 * the name that was asked for, which is a receipt that lies. An unrecognised
 * `TERRAGRAM_WORKSPACE_MODEL` is therefore ignored rather than forwarded — a
 * deployment typo degrades to the default instead of failing every managed turn.
 */
export function resolvedModel(override?: string): ManagedModelId {
  const chosen = migrateManagedModelId(override);
  if (isManagedModelId(chosen)) return chosen;
  const configured = migrateManagedModelId(process.env.TERRAGRAM_WORKSPACE_MODEL);
  if (isManagedModelId(configured)) return configured;
  return DEFAULT_MANAGED_MODEL;
}
const TOOL_NAME = "emit_infrastructure";

/** Structured output the managed model must return via the forced tool call. */
const toolOutputSchema = z.object({
  reply: z.string().default(""),
  /** The cloud the brief named, when it named one. */
  cloud: z.enum(CLOUDS).nullable().default(null),
  components: z
    .array(
      z.object({
        kind: z.string(),
        label: z.string().optional(),
        /** Attribute choices the model inferred. Validated against the registry's
         *  field options downstream — an unknown key or value is dropped, never
         *  emitted, because the provider would reject it. */
        attributes: z.record(z.string(), z.string()).optional(),
        /** The model's own reason for being unsure, raised as a review flag. */
        flag_reason: z.string().max(400).optional(),
      }),
    )
    .default([]),
});

/**
 * The attribute vocabulary offered to the managed model: every kind's inspector
 * fields and their permitted values, so the model picks from the same closed set the
 * emitter understands rather than inventing SKU names.
 */
function attributeVocabulary(): string {
  return [...KIND_BY_ID.values()]
    .filter((def) => def.fields.length > 0)
    .map((def) => {
      const fields = def.fields
        .map((f) => (f.options ? `${f.key} one of [${f.options.join(" | ")}]` : `${f.key} free text`))
        .join("; ");
      return `${def.kind}: ${fields}`;
    })
    .join(". ");
}

/** Injected for tests so the client can run without a live gateway. */
export type InferenceDeps = {
  fetchImpl?: typeof fetch;
  mint?: (orgId: string, model?: string | null, budgetPence?: number) => ProxyToken;
  /** Full managed spend this cycle, pence. Injected so the cap is testable without a DB. */
  cycleSpendPence?: (orgId: string) => Promise<number>;
  /** The org's cycle ceiling, pence. */
  capPence?: (orgId: string) => Promise<number>;
};

/**
 * Record the `managed_mint` ledger row for a token just minted, with the budget it
 * carried. Required rather than defaulted: the binding needs Next's `after()` so
 * the runtime awaits the write, which is the caller's (a route's) to supply.
 */
export type MintLedger = (orgId: string, budgetPence: number) => void;

/** Thrown when the org has spent its managed allowance. Distinct from a transport
 *  failure so the caller can tell "we refused" from "the gateway broke". */
export class ManagedCapReachedError extends Error {
  constructor() {
    super("managed-model spend cap reached for this cycle");
    this.name = "ManagedCapReachedError";
  }
}

/**
 * The two spend-cap reads, from the caller's deps or the billing module.
 *
 * The billing module is imported on use rather than at the top of this file: it
 * pulls in the service-role Supabase client, and keeping that out of the module
 * graph is what lets the compose logic be exercised by a plain unit test.
 */
async function capReads(deps: InferenceDeps | undefined): Promise<{
  cycleSpendPence: (orgId: string) => Promise<number>;
  capPence: (orgId: string) => Promise<number>;
}> {
  if (deps?.cycleSpendPence && deps?.capPence) {
    return { cycleSpendPence: deps.cycleSpendPence, capPence: deps.capPence };
  }
  const billing = await import("@/features/billing/managed-usage");
  return {
    cycleSpendPence: deps?.cycleSpendPence ?? billing.managedCycleSpendPence,
    capPence: deps?.capPence ?? billing.managedCapPence,
  };
}

function buildRequest(model: string, prompt: string, prev: InfraModel) {
  const present = prev.nodes
    .filter((n) => n.kind !== "internet")
    .map((n) => `${n.kind} (${n.label})`)
    .join(", ");

  const system = [
    "You are Terragram's architecture translator for the UK public sector.",
    "Turn the user's plain-English description into cloud infrastructure components,",
    `choosing only from this vocabulary: ${MODEL_KIND_IDS.map((k) => `${k} = ${KIND_LABELS[k]}`).join("; ")}.`,
    "Always call the emit_infrastructure tool. Include every component the design needs",
    "(keep the ones already present unless the user asks to remove them). Keep 'reply' to",
    "one or two plain sentences describing what changed. Never invent kinds outside the vocabulary.",
    `Set 'attributes' only from these permitted values — ${attributeVocabulary()}.`,
    "When the description leaves a sizing or behaviour choice genuinely open, set",
    "'flag_reason' on that component saying what a reviewer needs to confirm. Prefer",
    "flagging over guessing: an unreviewed guess is the failure this product exists to prevent.",
    "Set 'cloud' to 'aws' or 'azure' only when the user names the cloud or a service that",
    "belongs to exactly one of them; otherwise null.",
  ].join(" ");

  return {
    model,
    max_tokens: 1024,
    system,
    tools: [
      {
        name: TOOL_NAME,
        description: "Emit the infrastructure components the description requires.",
        input_schema: {
          type: "object",
          properties: {
            reply: { type: "string", description: "One or two sentences on what changed." },
            cloud: {
              type: ["string", "null"],
              enum: [...CLOUDS, null],
              description: "The cloud the user named, or null when they did not.",
            },
            components: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: [...MODEL_KIND_IDS] },
                  label: { type: "string", description: "Optional friendlier display name." },
                  attributes: {
                    type: "object",
                    description:
                      "Attribute choices for this component, using only the permitted keys and values.",
                    additionalProperties: { type: "string" },
                  },
                  flag_reason: {
                    type: "string",
                    description:
                      "What a reviewer must confirm, when the description leaves a choice genuinely open.",
                  },
                },
                required: ["kind"],
              },
            },
          },
          required: ["reply", "cloud", "components"],
        },
      },
    ],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [
      {
        role: "user",
        content: present
          ? `Current components: ${present}.\n\nInstruction: ${prompt}`
          : prompt,
      },
    ],
  };
}

/** Whether the managed engine can run in this deployment (proxy configured). */
export function isManagedInferenceConfigured(): boolean {
  return isModelProxyConfigured();
}

/**
 * One managed call with a forced tool: enforce the spend cap, mint a token carrying
 * the remaining budget, post the request to the gateway and return the tool's
 * input. Shared by chat → model and the diagram reader so both pay the same way
 * and neither can mint without the cap.
 */
export async function managedToolCall(args: {
  orgId: string;
  request: { model: string } & Record<string, unknown>;
  recordMint: MintLedger;
  deps?: InferenceDeps | undefined;
}): Promise<unknown> {
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const mint = args.deps?.mint ?? mintProxyToken;
  const { cycleSpendPence: cycleSpend, capPence: cap } = await capReads(args.deps);

  // The spend cap, enforced here because this is the only place a token is minted.
  // Both reads fail CLOSED: an unreadable ledger refuses the call rather than
  // minting blind, because a managed call spends real Bedrock money.
  const [spendPence, capPence] = await Promise.all([cycleSpend(args.orgId), cap(args.orgId)]);
  if (overManagedCap(spendPence, capPence)) throw new ManagedCapReachedError();

  // The remaining budget rides in the signed claims so the gateway enforces the cap
  // for the token's whole TTL — without it, a token minted one pence under the cap
  // could spend unbounded for an hour.
  const budgetPence = Math.max(0, capPence - spendPence);
  const credential = mint(args.orgId, args.request.model, budgetPence);

  // Mint ledger (reconciliation signal): a mint with no `managed_cost` report in
  // the window is the "gateway spent but never reported" smell the reconcile job
  // looks for. Recorded after the mint returns, so a mint that threw leaves no row.
  // Guarded here rather than trusting every binding to be best-effort: a throw
  // escaping would fail a managed call whose token is already signed.
  try {
    args.recordMint(args.orgId, budgetPence);
  } catch {
    // Nothing to do: the row is a reconciliation hint, not the call's business.
  }

  const url = `${credential.endpoint.replace(/\/$/, "")}/v1/messages`;

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${credential.token}`,
    },
    body: JSON.stringify(args.request),
  });

  if (!response.ok) {
    throw new Error(`managed inference failed: ${response.status}`);
  }

  const data: unknown = await response.json();
  return extractToolUse(data, toolNameOf(args.request));
}

/**
 * Translate a plain-English instruction into the model via managed inference.
 * Throws on transport/parse failure so the caller can fall back to the stub.
 */
export async function runManagedCompose(args: {
  orgId: string;
  prompt: string;
  prev?: InfraModel;
  model?: string;
  recordMint: MintLedger;
  deps?: InferenceDeps;
}): Promise<ComposeResult> {
  const prev = args.prev ?? EMPTY_MODEL;
  const model = resolvedModel(args.model);
  const block = await managedToolCall({
    orgId: args.orgId,
    request: buildRequest(model, args.prompt, prev),
    recordMint: args.recordMint,
    deps: args.deps,
  });
  const parsed = toolOutputSchema.safeParse(block);
  if (!parsed.success) {
    throw new Error("managed inference returned an unusable response");
  }

  const components: ComponentRequest[] = parsed.data.components.map((c) => ({
    kind: c.kind,
    ...(c.label ? { label: c.label } : {}),
    ...(c.attributes ? { attributes: c.attributes } : {}),
    ...(c.flag_reason ? { flagReason: c.flag_reason } : {}),
  }));
  const { model: nextModel, added } = assembleModel(components, prev, components.length > 0);
  const reply = parsed.data.reply.trim() || describeTurn(added, nextModel);
  return {
    model: nextModel,
    reply,
    added,
    engine: "managed",
    // The model that actually ran, not the one configured — they differ the moment
    // a user picks one, and the receipt records this rather than re-resolving later.
    inferenceModel: model,
    ...(parsed.data.cloud ? { cloud: parsed.data.cloud } : {}),
  };
}

/** The tool the request forced — the only block worth reading back. */
function toolNameOf(request: Record<string, unknown>): string {
  const choice = request.tool_choice as { name?: unknown } | undefined;
  return typeof choice?.name === "string" ? choice.name : TOOL_NAME;
}

/** Pull the forced tool call's input out of an Anthropic Messages response. */
function extractToolUse(data: unknown, toolName: string): unknown {
  if (typeof data !== "object" || data === null) return null;
  const content = (data as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const block = content.find(
    (c): c is { type: string; name: string; input: unknown } =>
      typeof c === "object" &&
      c !== null &&
      (c as { type?: unknown }).type === "tool_use" &&
      (c as { name?: unknown }).name === toolName,
  );
  return block?.input ?? null;
}
