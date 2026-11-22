// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

import { buildGraphModel } from "./graph-build.ts";
import { KIND_LABELS, MODEL_KIND_IDS } from "./kinds.ts";
import type { ManagedModelId } from "./managed-models.ts";
import { type Cloud, CLOUDS, type InfraModel } from "./model.ts";
import type { ModelClient } from "./ports.ts";

/**
 * A screenshot or photo of an architecture diagram → model, through managed
 * inference. This is the first workspace feature with NO deterministic fallback:
 * reading a picture needs a vision model, so when managed inference is off or the
 * org is not entitled the honest answer is "not available here", never a guess.
 *
 * The model is asked for boxes and arrows, not for a finished architecture — kinds
 * from the same closed vocabulary the emitter understands, a label per box, and a
 * connection list by box reference. Everything after that is the same
 * `graph-build` path the Mermaid importer uses, so a drawn arrow and a
 * photographed one keep the same promises.
 */

export const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

/** Anthropic's per-image ceiling is 5 MB; leave headroom for base64 framing. */
export const MAX_IMAGE_BYTES = 4_500_000;

export type DiagramImage = { data: string; mediaType: ImageMediaType };

export type DiagramReadResult = {
  model: InfraModel;
  untranslated: string[];
  reply: string;
  /** The cloud the picture depicts, when its icons or labels say — a page of AWS
   *  icons is an AWS design whatever the workspace toggle was set to. */
  cloud: Cloud | null;
};

const TOOL_NAME = "emit_diagram";

const toolOutputSchema = z.object({
  reply: z.string().default(""),
  cloud: z.enum(CLOUDS).nullable().default(null),
  components: z
    .array(
      z.object({
        ref: z.string().min(1).max(40),
        label: z.string().max(160).default(""),
        kind: z.string().nullable().default(null),
        flag_reason: z.string().max(400).optional(),
      }),
    )
    .default([]),
  connections: z.array(z.object({ from: z.string(), to: z.string() })).default([]),
});

export function buildImageRequest(model: string, image: DiagramImage) {
  const system = [
    "You are Terragram's diagram reader for the UK public sector.",
    "The user has supplied a picture of a cloud architecture diagram. Read every box and every",
    "arrow. Always call the emit_diagram tool.",
    "For each box give a short 'ref' (a1, a2, …), its 'label' as written in the picture, and a 'kind'",
    `chosen only from this vocabulary: ${MODEL_KIND_IDS.map((k) => `${k} = ${KIND_LABELS[k]}`).join("; ")};`,
    "use kind 'internet' for a box that means users, clients or the public internet, and kind null",
    "when the box is not a cloud component in that vocabulary (a legacy system, a team, a note).",
    "Report each arrow once in 'connections' as { from, to } by ref, in the direction drawn; for",
    "a line with no arrowhead use the direction traffic would flow.",
    "Never invent boxes or arrows that are not in the picture, and never merge two boxes into one.",
    "If the picture is not an architecture diagram, return no components and say so in 'reply'.",
    "Set 'flag_reason' when a label is illegible or a kind is a genuine guess.",
    "Set 'cloud' to 'aws' or 'azure' when the picture's icons or labels name one, else null.",
  ].join(" ");

  return {
    model,
    max_tokens: 2048,
    system,
    tools: [
      {
        name: TOOL_NAME,
        description: "Emit the boxes and arrows read from the diagram picture.",
        input_schema: {
          type: "object",
          properties: {
            reply: { type: "string", description: "One or two sentences on what the picture shows." },
            cloud: {
              type: ["string", "null"],
              enum: [...CLOUDS, null],
              description: "The cloud the diagram's icons or labels depict, or null.",
            },
            components: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  ref: { type: "string", description: "Short handle used by connections." },
                  label: { type: "string", description: "The box's text as written." },
                  kind: { type: ["string", "null"], enum: [...MODEL_KIND_IDS, "internet", null] },
                  flag_reason: { type: "string", description: "Why this reading is uncertain." },
                },
                required: ["ref", "label", "kind"],
              },
            },
            connections: {
              type: "array",
              items: {
                type: "object",
                properties: { from: { type: "string" }, to: { type: "string" } },
                required: ["from", "to"],
              },
            },
          },
          required: ["reply", "cloud", "components", "connections"],
        },
      },
    ],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
          { type: "text", text: "Read this architecture diagram." },
        ],
      },
    ],
  };
}

/** Turn the model's boxes and arrows into a workspace model. Exported for tests. */
export function modelFromReading(output: unknown): DiagramReadResult | null {
  const parsed = toolOutputSchema.safeParse(output);
  if (!parsed.success) return null;
  const boxes = parsed.data.components.map((c) => ({
    ref: c.ref,
    label: c.label || c.ref,
    kind: c.kind,
    flagReason: c.flag_reason ?? null,
  }));
  const built = buildGraphModel(boxes, parsed.data.connections);
  return { ...built, reply: parsed.data.reply.trim(), cloud: parsed.data.cloud };
}

/**
 * Read a diagram picture through the `ModelClient`. `model` is already resolved
 * (see `resolveManagedModel`): the diagram reader reaches the same gateway as a chat
 * turn, so it cannot be the path that forwards an unserved model id.
 */
export async function runManagedDiagramRead(args: {
  client: ModelClient;
  image: DiagramImage;
  model: ManagedModelId;
}): Promise<DiagramReadResult> {
  const block = await args.client.toolCall(buildImageRequest(args.model, args.image));
  const result = modelFromReading(block);
  if (!result) throw new Error("managed inference returned an unusable diagram reading");
  return result;
}
