// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ANY_RESOURCE_ID } from "terragram-engine/iam";
import { parseTerraform } from "terragram-engine/parse";

import { managedPolicyGrants } from "../packages/engine/src/aws-managed-policies.ts";

/**
 * The AWS managed policy table holds the IAM reads (`iam:Get*`, `iam:List*`, the console reads) that the
 * published policy documents grant, so IAM shows as read wherever a policy gives it.
 */

function read(source: string) {
  const result = parseTerraform(source);
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result.model;
}

const AWS = `
resource "aws_iam_role" "fn" {
  name = "fn"
  assume_role_policy = "{}"
}

resource "aws_lambda_function" "api" {
  function_name = "api"
  role          = aws_iam_role.fn.arn
}
`;

describe("IAM reads in the AWS managed policy table", () => {
  const rows = (name: string) => managedPolicyGrants(`arn:aws:iam::aws:policy/${name}`) ?? [];
  const attach = (name: string) => `${AWS}
resource "aws_iam_role" "other" {
  name = "other"
  assume_role_policy = "{}"
}
resource "aws_iam_role_policy_attachment" "a" {
  role       = aws_iam_role.fn.name
  policy_arn = "arn:aws:iam::aws:policy/${name}"
}
`;

  it("holds the iam:Get*/List* reads the published documents grant", () => {
    // Every policy in the table whose document allows an iam read on Resource * (or a service-wide list), read on 2026-11-27.
    for (const name of [
      "AWSKeyManagementServicePowerUser",
      "AWSLambda_FullAccess",
      "AWSLambda_ReadOnlyAccess",
      "AmazonCognitoPowerUser",
      "AmazonDynamoDBFullAccess",
      "AmazonDynamoDBReadOnlyAccess",
      "CloudFrontFullAccess",
      "CloudWatchFullAccess",
      "IAMReadOnlyAccess",
    ]) {
      assert.ok(rows(name).some(([service, level]) => service === "iam" && level === "read"), name);
    }
    // The policies that grant everything at a level cover IAM in their one row.
    for (const name of ["SecurityAudit", "ReadOnlyAccess", "job-function/ViewOnlyAccess"]) assert.deepEqual(rows(name), [["*", "read"]], name);
  });

  it("shows IAM as read on another role and on any resource, never above what the policy grants", () => {
    const edges = (name: string) => read(attach(name)).edges.filter((e) => e.access && e.access !== "runs-as").map((e) => `${e.target}: ${e.access}${e.conditional ? " (conditional)" : ""}`);
    const lambda = edges("AWSLambda_ReadOnlyAccess");
    assert.ok(lambda.includes("entra-id-2: read"), "the other role is read");
    assert.ok(lambda.includes(`${ANY_RESOURCE_ID}: read`));
    assert.equal(lambda.some((e) => /admin|write|unscoped/.test(e)), false);
    assert.ok(edges("AmazonDynamoDBReadOnlyAccess").includes("entra-id-2: read"));
  });

  it("keeps a conditional PassRole grant beside the read, which stays unconditional", () => {
    const model = read(attach("AWSLambda_FullAccess"));
    const edge = model.edges.find((e) => e.target === "entra-id-2");
    assert.equal(edge?.access, "admin");
    assert.equal(edge?.conditional, true);
    assert.equal(edge?.unconditional, "read", "an unconditional read is not hidden behind the conditional admin");
  });
});
