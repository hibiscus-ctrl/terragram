// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

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
import type { MessagesRequest, ModelClient } from "./ports.ts";

/**
 * Managed inference for Chat → Model: the request the model is given, and the reading
 * of its answer. It forces a single tool call so the model returns a structured set of
 * components rather than prose we'd have to parse. The component vocabulary is the
 * SAME one the Terraform generator understands, so managed output stays coherent
 * with the deterministic emitter. Everything else in the engine (parse, emit,
 * evidence) is deterministic and needs no inference.
 *
 * Transport, credentials and spend caps are the `ModelClient` the host passes in.
 */

/**
 * The model specifier a managed turn resolves to: the user's choice, else the
 * deployment's configured default, else Sonnet.
 *
 * Both inputs are checked against the served list rather than trusted. The proxy
 * forwards any id containing a `.` as a raw Bedrock id, so an unvalidated string
 * arriving here could name a `us.` profile and move a UK customer's inference out
 * of the country; and an id the proxy cannot serve is answered by its default under
 * the name that was asked for, which is a receipt that lies. An unrecognised
 * `configured` value is therefore ignored rather than forwarded — a deployment typo
 * degrades to the default instead of failing every managed turn.
 *
 * `configured` is the host's own setting (for example an environment variable it reads).
 */
export function resolveManagedModel(override?: string, configured?: string): ManagedModelId {
  const chosen = migrateManagedModelId(override);
  if (isManagedModelId(chosen)) return chosen;
  const fromDeployment = migrateManagedModelId(configured);
  if (isManagedModelId(fromDeployment)) return fromDeployment;
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

function buildRequest(model: string, prompt: string, prev: InfraModel) {
  const present = prev.nodes
    .filter((n) => n.kind !== "internet")
    .map((n) => `${n.kind} (${n.label})`)
    .join(", ");

  const system = [
    "You are an architecture translator for the UK public sector.",
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

/**
 * Translate a plain-English instruction into the model through the `ModelClient`.
 * Throws on transport/parse failure so the caller can fall back to the deterministic
 * engine. `model` is already resolved (see `resolveManagedModel`).
 */
export async function runManagedCompose(args: {
  client: ModelClient;
  prompt: string;
  prev?: InfraModel;
  model: ManagedModelId;
}): Promise<ComposeResult> {
  const prev = args.prev ?? EMPTY_MODEL;
  const block = await args.client.toolCall(buildRequest(args.model, args.prompt, prev));
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
    inferenceModel: args.model,
    ...(parsed.data.cloud ? { cloud: parsed.data.cloud } : {}),
  };
}

/** The tool the request forced — the only block worth reading back. */
export function toolNameOf(request: MessagesRequest): string {
  const choice = request.tool_choice as { name?: unknown } | undefined;
  return typeof choice?.name === "string" ? choice.name : TOOL_NAME;
}

/**
 * Pull the forced tool call's input out of an Anthropic Messages response. For
 * `ModelClient` implementations that speak the Messages API directly.
 */
export function extractToolUse(data: unknown, toolName: string): unknown {
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
