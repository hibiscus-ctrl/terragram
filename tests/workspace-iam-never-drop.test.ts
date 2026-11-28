// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ANY_RESOURCE_ID } from "terragram-engine/iam";
import type { InfraModel } from "terragram-engine/model";
import { parseTerraform } from "terragram-engine/parse";

/**
 * The rule these tests hold the reader to: a grant it cannot fully resolve still appears,
 * as an unscoped edge. It is never dropped and never narrowed to what could be read.
 */

function read(source: string) {
  const result = parseTerraform(source);
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result;
}

/** `source -> target: access` for every typed edge, with `conditional` marked. */
function typed(model: InfraModel): string[] {
  return model.edges.filter((e) => e.access).map((e) => `${e.source} -> ${e.target}: ${e.access}${e.conditional ? ", conditional" : ""}`);
}

const BASE = `
resource "aws_s3_bucket" "data" {
  bucket = "data-bucket"
}

resource "aws_dynamodb_table" "orders" {
  name = "orders"
}

resource "aws_sqs_queue" "jobs" {
  name = "jobs"
}

resource "aws_iam_role" "fn" {
  name = "fn"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{ Action = "sts:AssumeRole", Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" } }]
  })
}

resource "aws_lambda_function" "api" {
  function_name = "api"
  role          = aws_iam_role.fn.arn
}
`;

const READ_DATA = `jsonencode({ Statement = [{ Effect = "Allow", Action = "s3:GetObject", Resource = aws_s3_bucket.data.arn }] })`;

describe("a policy whose holder cannot be named is still a grant", () => {
  it("draws a role policy on a role named by a string or a variable from a stand-in", () => {
    for (const role of [`"ci"`, "var.role", "data.aws_iam_role.ci.name", `"${"$"}{var.prefix}-ci"`]) {
      const { model } = read(`${BASE}
resource "aws_iam_role_policy" "ci" {
  role   = ${role}
  policy = ${READ_DATA}
}
`);
      assert.ok(typed(model).includes("principal-aws-role -> object-storage: unscoped"), `${role}: ${typed(model).join(" | ")}`);
      assert.equal(model.nodes.find((n) => n.id === "principal-aws-role")?.label, "An IAM role (not drawn)");
    }
  });

  it("draws an attachment to a role named by a variable or a list that holds one", () => {
    const { model } = read(`${BASE}
resource "aws_iam_role_policy_attachment" "ci" {
  role       = var.role
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

resource "aws_iam_policy_attachment" "many" {
  name       = "many"
  roles      = [aws_iam_role.fn.name, var.other]
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}
`);
    const edges = typed(model);
    assert.ok(edges.some((e) => e.startsWith(`principal-aws-role -> ${ANY_RESOURCE_ID}`)), edges.join(" | "));
    assert.ok(edges.includes(`entra-id -> ${ANY_RESOURCE_ID}: admin`), "the drawn role in the list keeps its own edge");
    assert.equal(edges.filter((e) => e.startsWith("principal-aws-role -> ")).length >= 1, true);
  });

  it("keeps a policy on a drawn role named by a literal that matches it as that role's", () => {
    const { model } = read(`${BASE}
resource "aws_iam_role_policy" "fn" {
  role   = "fn"
  policy = ${READ_DATA}
}
`);
    assert.ok(typed(model).includes("entra-id -> object-storage: read"), typed(model).join(" | "));
    assert.equal(model.nodes.some((n) => n.id === "principal-aws-role"), false);
  });

  it("reads a dynamic inline_policy block as an unscoped grant of the role", () => {
    const { model } = read(`${BASE}
resource "aws_iam_role" "dyn" {
  name = "dyn"
  assume_role_policy = "{}"
  dynamic "inline_policy" {
    for_each = var.policies
    content {
      name   = inline_policy.value.name
      policy = inline_policy.value.json
    }
  }
}
`);
    assert.ok(typed(model).includes(`entra-id-2 -> ${ANY_RESOURCE_ID}: unscoped`), typed(model).join(" | "));
  });

  it("reads user policies the same way", () => {
    const { model } = read(`${BASE}
resource "aws_iam_user_policy" "u" {
  user   = var.user
  policy = ${READ_DATA}
}
`);
    assert.ok(typed(model).includes("principal-aws-user -> object-storage: unscoped"), typed(model).join(" | "));
  });
});
