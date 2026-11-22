// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which resources a diagram of an estate leaves out because they only join other
 * resources together. A role policy attachment says which policy a role has, which the
 * line from the role to the policy says better; a `random_id` or a `null_resource` is
 * Terraform's plumbing, not infrastructure. Drawn, they bury the structure.
 *
 * A hidden resource is not dropped from the picture's meaning: when a resource refers
 * to a hidden one that refers on to a third, the diagram draws a line from the first to
 * the third, and the footer says how many resources were hidden and of which types.
 *
 * The rule is data, so a caller can read it, extend it or replace it:
 *
 *   projectGraph(doc, { glue: { ...DEFAULT_GLUE, keep: ["aws_lambda_permission"] } })
 *   projectGraph(doc, { glue: false })   // hide nothing
 */
export type GlueRule = {
  /** Resource types hidden by exact name. */
  types: readonly string[];
  /**
   * Globs for types hidden by shape, matched against the whole type: `*` stands for any run of
   * characters and nothing else is special. Globs, not regular expressions, so a pattern from
   * a command line or a config can never cost more than linear time.
   */
  patterns: readonly string[];
  /** Types never hidden, whatever the other two say. */
  keep: readonly string[];
};

export const DEFAULT_GLUE: Readonly<GlueRule> = {
  types: [
    // IAM grants and memberships: the edge between the principal and the policy says it.
    "aws_iam_group_membership",
    "aws_iam_group_policy",
    "aws_iam_role_policy",
    "aws_iam_user_group_membership",
    "aws_iam_user_policy",
    // Permissions that only let one resource call another.
    "aws_lambda_permission",
    "aws_sns_topic_policy",
    "aws_sqs_queue_policy",
  ],
  patterns: [
    // Attachments and associations: a route table association, a policy attachment,
    // a volume attachment, a security group association.
    "*_attachment",
    "*_association",
    // IAM bindings on a Google resource.
    "google_*_iam_binding",
    "google_*_iam_member",
    "google_*_iam_policy",
    // Terraform's own plumbing.
    "random_*",
    "time_*",
    "null_resource",
    "terraform_data",
    // Data sources, if a document ever names one.
    "data.*",
  ],
  keep: [],
};

/** A function that says whether a resource of this type is glue under the rule. */
export function glueMatcher(rule: Readonly<GlueRule> | false): (type: string) => boolean {
  if (rule === false) return () => false;
  const types = new Set(rule.types);
  const keep = new Set(rule.keep);
  const patterns = rule.patterns.map((glob) => glob.split("*"));
  return (type) => !keep.has(type) && (types.has(type) || patterns.some((parts) => globMatches(parts, type)));
}

/** Whether `text` matches a glob already split on `*`: the whole text, in one linear pass. */
function globMatches(parts: readonly string[], text: string): boolean {
  const first = parts[0] ?? "";
  if (parts.length === 1) return text === first;
  const last = parts[parts.length - 1] ?? "";
  if (!text.startsWith(first) || text.length < first.length + last.length) return false;
  let at = first.length;
  const end = text.length - last.length;
  for (const part of parts.slice(1, -1)) {
    const found = text.indexOf(part, at);
    if (found < 0 || found + part.length > end) return false;
    at = found + part.length;
  }
  return text.endsWith(last);
}

