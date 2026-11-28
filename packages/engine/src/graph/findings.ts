// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from "zod";

import { describeIssues, GraphDocumentError } from "./schema.ts";

/**
 * Findings to lay over a graph: a check that failed, a rule a resource breaks.
 *
 * graph/v1 names a resource by its type and ID and a scope by its account, and may carry a
 * Terraform address on a resource or module call (see `redaction.addresses`). So a finding
 * is placed by what it can say:
 *
 * - `type` and `id` (and `account`, `environment` or `root`, when given): the finding is on that resource;
 * - an `address` only, as a Terraform review reports it: the one resource or module call
 *   of the graph that has that address (narrowed by `account`, `environment` and `root`, since the
 *   same address recurs in each root, and in each root of an environment). An address the graph does not keep (it was hashed or
 *   dropped), or that more than one node has, is turned into a type and ID by the caller's
 *   `resolveAddress` when it passes one to `projectGraph`, and is otherwise unplaced;
 * - `account` alone, with no address, type or ID: the finding is on that account's scope, which is
 *   where infraharvest's own gate findings land (they name a root's account, not a resource). A
 *   finding that names an address which does not narrow to one node stays unplaced even when it
 *   also names an account: it is about a resource, and on the scope it would read as account-wide.
 *
 * Unplaced findings are counted and said so in the picture, never guessed at.
 */

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export type GraphFinding = {
  severity: Severity;
  title: string;
  type?: string;
  id?: string;
  account?: string;
  /** The environment of the root the finding is in, when the review names it. */
  environment?: string;
  /** The root the finding is in, as the graph names its roots (a path in the output directory, or its hash). */
  root?: string;
  region?: string;
  address?: string;
};

const text = z.string().min(1);

/** The findings file the CLI reads next to infraharvest's: what a review or refactor run reports. */
const reviewFindingsSchema = z.object({
  findings: z
    .array(
      z.object({
        severity: z.enum(SEVERITIES),
        title: text.optional(),
        rule_id: text.optional(),
        type: text.optional(),
        id: text.optional(),
        account: text.optional(),
        environment: text.optional(),
        root: text.optional(),
        region: text.optional(),
        resource: text.optional(),
        address: text.optional(),
      }),
    )
    .default([]),
});

/** The part of infraharvest's `ocsf-findings/v1` that placing a finding reads. */
const ocsfFindingsSchema = z.object({
  schema: z.literal("infraharvest/ocsf-findings/v1"),
  events: z.array(
    z.object({
      severity: z.enum(["Low", "Medium", "High"]),
      message: text,
      finding_info: z.object({ title: text, types: z.array(text).default([]) }),
      cloud: z.object({ account: z.object({ uid: text }).optional(), region: text.optional() }).optional(),
    }),
  ),
});

function fail(error: z.ZodError): never {
  throw new GraphDocumentError(`not a findings document:\n${describeIssues(error)}`);
}

/**
 * Findings from infraharvest's OCSF export (`ocsf-findings/v1`): one for each failed or
 * skipped check of a root, placed on the root's account.
 */
export function findingsFromOcsf(input: unknown): GraphFinding[] {
  const parsed = ocsfFindingsSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error);
  const severity = { Low: "low", Medium: "medium", High: "high" } as const;
  return parsed.data.events.map((event) => {
    const reasons = event.finding_info.types.length > 0 ? ` (${event.finding_info.types.join(", ")})` : "";
    return {
      severity: severity[event.severity],
      title: `${event.finding_info.title}${reasons}`,
      ...(event.cloud?.account && { account: event.cloud.account.uid }),
      ...(event.cloud?.region && { region: event.cloud.region }),
    };
  });
}

/**
 * Findings from a JSON file with a `findings` array (or Infraweaver's `introduced_findings`,
 * whose `resource` is a Terraform address): each has a severity and a title or rule ID,
 * and says where it is as in {@link GraphFinding}.
 */
export function findingsFromReview(input: unknown): GraphFinding[] {
  const object = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const source = object.findings === undefined && object.introduced_findings !== undefined
    ? { findings: object.introduced_findings }
    : input;
  const parsed = reviewFindingsSchema.safeParse(source);
  if (!parsed.success) return fail(parsed.error);
  return parsed.data.findings.map((f) => {
    const address = f.address ?? f.resource;
    return {
      severity: f.severity,
      title: f.title ?? f.rule_id ?? "finding",
      ...(f.type && { type: f.type }),
      ...(f.id && { id: f.id }),
      ...(f.account && { account: f.account }),
      ...(f.environment && { environment: f.environment }),
      ...(f.root && { root: f.root }),
      ...(f.region && { region: f.region }),
      ...(address && { address }),
    };
  });
}

/** Read a findings document of either kind, told apart by its `schema` field. */
export function parseFindings(input: unknown): GraphFinding[] {
  const value = typeof input === "string" ? parseJson(input) : input;
  const schema = typeof value === "object" && value !== null ? (value as { schema?: unknown }).schema : undefined;
  return typeof schema === "string" && schema.startsWith("infraharvest/ocsf-findings/")
    ? findingsFromOcsf(value)
    : findingsFromReview(value);
}

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    throw new GraphDocumentError("the findings document is not valid JSON");
  }
}

export type FindingTally = {
  count: number;
  worst: Severity;
  bySeverity: Partial<Record<Severity, number>>;
};

/** Count findings: how many, the worst severity, and how many of each. Null when there are none. */
export function tally(findings: readonly Severity[]): FindingTally | null {
  if (findings.length === 0) return null;
  const bySeverity: Partial<Record<Severity, number>> = {};
  for (const severity of SEVERITIES) {
    const n = findings.filter((s) => s === severity).length;
    if (n > 0) bySeverity[severity] = n;
  }
  const worst = SEVERITIES.find((severity) => bySeverity[severity] !== undefined) ?? "info";
  return { count: findings.length, worst, bySeverity };
}

/** The sum of tallies (a box and the cards it stands for, say); null when there is nothing in any of them. */
export function mergeTallies(tallies: readonly (FindingTally | null)[]): FindingTally | null {
  const severities: Severity[] = [];
  for (const t of tallies) {
    if (t === null) continue;
    for (const severity of SEVERITIES) for (let i = 0; i < (t.bySeverity[severity] ?? 0); i++) severities.push(severity);
  }
  return tally(severities);
}
