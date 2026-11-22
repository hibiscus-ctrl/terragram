import { z } from "zod";

import { DEFAULT_MANAGED_MODEL, MANAGED_MODEL_IDS } from "./managed-models.ts";
import { CLOUDS } from "./model.ts";
import { WORKSPACE_MODES } from "./modes.ts";

/**
 * Per-user workspace preferences.
 *
 * Every control here changes something observable. The settings page used to be a
 * page of switches wired to `useState` and a "Settings saved" toast — in a product
 * whose whole claim is that it does not do things behind your back, a control that
 * lies about having done something is worse than no control at all. The "stream
 * responses" toggle is gone for the same reason: there is no progressive reveal to
 * turn off.
 */

const EDGE_ROUTINGS = ["smoothstep", "step", "straight"] as const;
export type EdgeRouting = (typeof EDGE_ROUTINGS)[number];

const LABEL_FACES = ["mono", "sans"] as const;
export type LabelFace = (typeof LABEL_FACES)[number];

const TERRAFORM_TOOLS = ["terraform", "opentofu"] as const;

export const workspaceSettingsSchema = z.object({
  /** Applies to new workspaces. */
  defaultMode: z.enum(WORKSPACE_MODES).default("chat-diagram"),
  /** Applies to new workspaces. */
  defaultCloud: z.enum(CLOUDS).default("azure"),
  /** Applies to new workspaces. */
  defaultTool: z.enum(TERRAFORM_TOOLS).default("terraform"),
  /** When off, the engine picks a fallback and flags the node instead of asking. */
  askAmbiguous: z.boolean().default(true),
  /** Gates the starter prompts in the compose empty state. */
  showSuggestions: z.boolean().default(true),
  /** When off, dagre never moves a node that already has a position. */
  autoLayout: z.boolean().default(true),
  edgeRouting: z.enum(EDGE_ROUTINGS).default("smoothstep"),
  labelFace: z.enum(LABEL_FACES).default("mono"),
  /** Which managed model a managed turn runs on. Inert where managed inference is
   *  off — the deterministic engine takes no model, which is why the settings page
   *  hides this control there rather than offering a choice that changes nothing. */
  inferenceModel: z.enum(MANAGED_MODEL_IDS).default(DEFAULT_MANAGED_MODEL),
});

export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>;

export const DEFAULT_SETTINGS: WorkspaceSettings = workspaceSettingsSchema.parse({});

/** Parse a stored settings blob, falling back to defaults field by field. */
export function parseSettings(value: unknown): WorkspaceSettings {
  const parsed = workspaceSettingsSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}
