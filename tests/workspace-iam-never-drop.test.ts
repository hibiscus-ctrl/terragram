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

describe("a policy the reader cannot see may rewrite its own holder", () => {
  const selfOf = (model: InfraModel, id = "entra-id") => model.nodes.find((n) => n.id === id)?.selfAccess;

  it("records unscoped access to itself for a policy that is a variable or a file", () => {
    for (const policy of ["var.policy", `file("policy.json")`, "data.aws_iam_policy_document.gone.json"]) {
      const { model } = read(`${BASE}
resource "aws_iam_role_policy" "fn" {
  role   = aws_iam_role.fn.id
  policy = ${policy}
}
`);
      assert.ok(typed(model).includes(`entra-id -> ${ANY_RESOURCE_ID}: unscoped`), policy);
      assert.equal(selfOf(model), "unscoped", policy);
    }
  });

  it("records it for a managed policy the table does not know, and for generated inline policies", () => {
    const unknown = read(`${BASE}
resource "aws_iam_role_policy_attachment" "x" {
  role       = aws_iam_role.fn.name
  policy_arn = "arn:aws:iam::123456789012:policy/Custom"
}
`);
    assert.equal(selfOf(unknown.model), "unscoped");
    const generated = read(`${BASE}
resource "aws_iam_role" "dyn" {
  name = "dyn"
  assume_role_policy = "{}"
  dynamic "inline_policy" {
    for_each = var.policies
    content {
      name   = "x"
      policy = "{}"
    }
  }
}
`);
    assert.equal(selfOf(generated.model, "entra-id-2"), "unscoped");
  });

  it("leaves a readable policy that cannot change the role without one", () => {
    const { model } = read(`${BASE}
resource "aws_iam_role_policy" "fn" {
  role   = aws_iam_role.fn.id
  policy = ${READ_DATA}
}
`);
    assert.equal(selfOf(model), undefined);
  });
});

describe("actions that change who can use a resource are admin, whatever their name says", () => {
  const levelOf = (action: string) => {
    const { model } = read(`${BASE}
resource "aws_iam_role_policy" "fn" {
  role   = aws_iam_role.fn.id
  policy = jsonencode({ Statement = [{ Effect = "Allow", Action = "${action}", Resource = aws_s3_bucket.data.arn }] })
}
`);
    return model.edges.find((e) => e.source === "entra-id" && e.target === "object-storage")?.access;
  };

  it("ranks the attribute, public-access and sharing calls as admin", () => {
    for (const action of [
      "sqs:SetQueueAttributes",
      "sns:SetTopicAttributes",
      "s3:PutBucketPublicAccessBlock",
      "s3:PutAccountPublicAccessBlock",
      "s3:PutBucketOwnershipControls",
      "ec2:ModifySnapshotAttribute",
      "ec2:ModifyImageAttribute",
      "rds:ModifyDBSnapshotAttribute",
      "rds:ModifyDBClusterSnapshotAttribute",
      "redshift:AuthorizeSnapshotAccess",
      "kms:CreateGrant",
      "lambda:AddPermission",
      "lambda:CreateFunctionUrlConfig",
      "ram:CreateResourceShare",
      "SQS:setqueueattributes",
    ]) {
      assert.equal(levelOf(action), "admin", action);
    }
  });

  it("leaves ordinary writes and reads where they were", () => {
    assert.equal(levelOf("sqs:SendMessage"), "write");
    assert.equal(levelOf("s3:PutObject"), "write");
    assert.equal(levelOf("s3:GetBucketPublicAccessBlock"), "read");
  });
});

describe("a literal ARN of a resource is a grant on it", () => {
  const edgesFor = (resource: string, action = "s3:GetObject") =>
    typed(
      read(`${BASE}
resource "aws_iam_role_policy" "fn" {
  role   = aws_iam_role.fn.id
  policy = jsonencode({ Statement = [{ Effect = "Allow", Action = "${action}", Resource = ${resource} }] })
}
`).model,
    ).filter((e) => e.startsWith("entra-id -> "));

  it("matches an object of a drawn bucket, a drawn table and a drawn queue by name", () => {
    assert.deepEqual(edgesFor(`"arn:aws:s3:::data-bucket/reports/2026.csv"`), ["entra-id -> object-storage: read"]);
    assert.deepEqual(edgesFor(`"arn:aws:s3:::data-bucket"`, "s3:ListBucket"), ["entra-id -> object-storage: read"]);
    assert.deepEqual(edgesFor(`"arn:aws:dynamodb:us-east-1:123456789012:table/orders"`, "dynamodb:PutItem"), ["entra-id -> nosql: write"]);
    assert.deepEqual(edgesFor(`"arn:aws:dynamodb:us-east-1:123456789012:table/orders/index/by-date"`, "dynamodb:Query"), ["entra-id -> nosql: read"]);
    assert.deepEqual(edgesFor(`["arn:aws:sqs:us-east-1:123456789012:jobs"]`, "sqs:SendMessage"), ["entra-id -> queue: write"]);
  });

  it("draws any resource at the action's level for an ARN no drawn resource has", () => {
    assert.deepEqual(edgesFor(`"arn:aws:s3:::other-bucket/key"`, "s3:PutObject"), [`entra-id -> ${ANY_RESOURCE_ID}: write`]);
    assert.deepEqual(edgesFor(`"arn:aws:kms:us-east-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab"`, "kms:Decrypt"), [`entra-id -> ${ANY_RESOURCE_ID}: read`]);
    assert.deepEqual(edgesFor(`"arn:aws:s3:::other-bucket/key"`, "s3:PutBucketPolicy"), [`entra-id -> ${ANY_RESOURCE_ID}: admin`]);
  });

  it("does not guess when a drawn resource's name cannot be read: an ARN it may name is any resource", () => {
    const { model } = read(`
resource "aws_s3_bucket" "dynamic" {
  bucket = var.name
}

resource "aws_iam_role" "fn" {
  name = "fn"
  assume_role_policy = "{}"
}

resource "aws_iam_role_policy" "fn" {
  role   = aws_iam_role.fn.id
  policy = jsonencode({ Statement = [{ Effect = "Allow", Action = "s3:GetObject", Resource = "arn:aws:s3:::somewhere/key" }] })
}
`);
    assert.deepEqual(typed(model), [`entra-id -> ${ANY_RESOURCE_ID}: read`]);
  });
});
