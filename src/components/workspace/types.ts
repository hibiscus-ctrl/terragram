/** UI-only workspace types shared across the workspace client components. */

/** The flow: compose/parse the model → review the gate → generate → see the result.
 *  `generating` is the transient step shown while the signed receipt is built. */
export type WorkspaceStep = "input" | "review" | "generating" | "result";

/** Error/edge states triggered from the "Demo states" menu. */
export type DemoState = "ambiguous" | "unparseable" | "timeout";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Assistant-only: "N nodes flagged for review" chip. */
  flags?: number;
  /** Assistant-only: clarify options the user can click to resolve ambiguity. */
  options?: string[];
};
