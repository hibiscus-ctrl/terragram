// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { modelToSvg } from "terragram-engine/diagram-svg";
import { explainModel } from "terragram-engine/explain";
import { parseHcl } from "terragram-engine/hcl";
import { ANY_RESOURCE_ID, readIam } from "terragram-engine/iam";
import { type InfraModel, infraModelSchema, selfAccessPhrase } from "terragram-engine/model";
import { parseTerraform } from "terragram-engine/parse";

import { renderDiagram } from "../action/src/mermaid.ts";
import { diffModels } from "../action/src/model-diff.ts";
import { renderReport } from "../action/src/report.ts";

/**
 * A node whose own grants reach the node itself (a role whose policy may rewrite the role, a
 * service account that may mint tokens for itself) can widen its own access. Nothing draws an
 * edge from a node to itself, so the model carries it on the node; the policy text never
 * reaches it, only the level.
 */

function read(source: string) {
  const result = parseTerraform(source);
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result.model;
}

const selfOf = (model: InfraModel) => model.nodes.filter((n) => n.selfAccess).map((n) => `${n.id}: ${n.selfAccess}${n.selfConditional ? " (conditional)" : ""}`);

const AWS = `
resource "aws_s3_bucket" "data" {
  bucket = "x"
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

const inline = (statement: string) => `${AWS}
resource "aws_iam_role_policy" "p" {
  role   = aws_iam_role.fn.id
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [${statement}]
  })
}
`;

describe("a role that may change itself", () => {
  for (const action of ["iam:PutRolePolicy", "iam:AttachRolePolicy", "iam:UpdateAssumeRolePolicy", "iam:*"]) {
    it(`is marked admin when its inline policy allows ${action} on its own ARN`, () => {
      const model = read(inline(`{ Effect = "Allow", Action = "${action}", Resource = aws_iam_role.fn.arn }`));
      assert.deepEqual(selfOf(model), ["entra-id: admin"]);
      assert.equal(model.edges.some((e) => e.source === e.target), false, "no edge from a node to itself");
      assert.equal(infraModelSchema.safeParse(model).success, true);
    });
  }

  it("is marked when the policy is a policy document, a list of actions and several resources", () => {
    const model = read(`${AWS}
data "aws_iam_policy_document" "d" {
  statement {
    actions   = ["s3:GetObject", "iam:PutRolePolicy"]
    resources = [aws_s3_bucket.data.arn, aws_iam_role.fn.arn]
  }
}

resource "aws_iam_role_policy" "p" {
  role   = aws_iam_role.fn.id
  policy = data.aws_iam_policy_document.d.json
}
`);
    assert.deepEqual(selfOf(model), ["entra-id: admin"]);
    assert.equal(model.edges.find((e) => e.target === "object-storage")?.access, "admin", "the bucket is reached at the same level");
  });

  it("is not marked for a read or a write on itself, which cannot widen anything", () => {
    assert.deepEqual(selfOf(read(inline(`{ Effect = "Allow", Action = ["iam:GetRole", "iam:ListRolePolicies"], Resource = aws_iam_role.fn.arn }`))), []);
    assert.deepEqual(selfOf(read(inline(`{ Effect = "Allow", Action = "s3:PutObject", Resource = aws_iam_role.fn.arn }`))), []);
  });

  it("is not marked for a grant on another role", () => {
    const model = read(`${AWS}
resource "aws_iam_role" "other" {
  name = "other"
  assume_role_policy = "{}"
}
resource "aws_iam_role_policy" "p" {
  role   = aws_iam_role.fn.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = "iam:PutRolePolicy", Resource = aws_iam_role.other.arn }] })
}
`);
    assert.deepEqual(selfOf(model), []);
    assert.ok(model.edges.some((e) => e.source === "entra-id" && e.access === "admin"), "the other role is still an admin edge");
  });

  it("keeps a condition, and an action it cannot read is unscoped, never dropped", () => {
    const conditional = read(inline(`{ Effect = "Allow", Action = "iam:PutRolePolicy", Resource = aws_iam_role.fn.arn, Condition = { StringEquals = { "aws:RequestedRegion" = "eu-west-1" } } }`));
    assert.deepEqual(selfOf(conditional), ["entra-id: admin (conditional)"]);
    const unclear = read(inline(`{ Effect = "Allow", NotAction = "s3:*", Resource = aws_iam_role.fn.arn }`));
    assert.deepEqual(selfOf(unclear), ["entra-id: unscoped"]);
    const variable = read(inline(`{ Effect = "Allow", Action = var.actions, Resource = aws_iam_role.fn.arn }`));
    assert.deepEqual(selfOf(variable), ["entra-id: unscoped"]);
  });

  it("is marked by a managed policy that covers IAM, and by an unconditional grant over a conditional one", () => {
    const attached = read(`${AWS}
resource "aws_iam_role_policy_attachment" "a" {
  role       = aws_iam_role.fn.name
  policy_arn = "arn:aws:iam::aws:policy/IAMFullAccess"
}
`);
    assert.deepEqual(selfOf(attached), ["entra-id: admin"]);
    // The conditional PassRole row of a full-access policy is conditional on itself too.
    const passRole = read(`${AWS}
resource "aws_iam_role_policy_attachment" "a" {
  role       = aws_iam_role.fn.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess"
}
`);
    assert.deepEqual(selfOf(passRole), ["entra-id: admin (conditional)"]);
  });

  it("is reported by readIam apart from its edges, and merged to one entry", () => {
    const blocks = parseHcl(inline(`{ Effect = "Allow", Action = ["iam:PutRolePolicy", "iam:AttachRolePolicy"], Resource = [aws_iam_role.fn.arn, aws_iam_role.fn.arn] }`));
    const reading = readIam(blocks, (address) => (address === "aws_iam_role.fn" ? "fn" : undefined));
    assert.deepEqual(reading.self.map((e) => [e.source, e.target, e.access]), [["fn", "fn", "admin"]]);
    assert.equal(reading.edges.some((e) => e.source === e.target), false);
    assert.equal(reading.edges.some((e) => e.target === ANY_RESOURCE_ID), false);
  });
});

describe("other clouds' accounts that may change themselves", () => {
  const GCP = `
resource "google_project" "app" {
  name       = "App"
  project_id = "app"
}

resource "google_service_account" "api" {
  account_id = "api"
}
`;
  const own = (role: string) => `${GCP}
resource "google_service_account_iam_member" "self" {
  service_account_id = google_service_account.api.name
  role               = "${role}"
  member             = "serviceAccount:\${google_service_account.api.email}"
}
`;

  it("marks a service account with token-creator or admin on itself", () => {
    for (const role of ["roles/iam.serviceAccountTokenCreator", "roles/iam.serviceAccountAdmin", "roles/iam.serviceAccountKeyAdmin"]) {
      assert.deepEqual(selfOf(read(own(role))), ["entra-id: admin"], role);
    }
  });

  it("does not mark acting as itself, a read, or a role on another account", () => {
    assert.deepEqual(selfOf(read(own("roles/iam.serviceAccountUser"))), []);
    assert.deepEqual(selfOf(read(own("roles/iam.serviceAccountViewer"))), []);
    const other = `${own("roles/iam.serviceAccountTokenCreator")}
resource "google_service_account" "peer" {
  account_id = "peer"
}
resource "google_service_account_iam_member" "peer" {
  service_account_id = google_service_account.peer.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:\${google_service_account.api.email}"
}
`;
    assert.deepEqual(selfOf(read(other)), ["entra-id: admin"], "the grant on the peer is an edge, the grant on itself is the flag");
    assert.equal(read(other).edges.find((e) => e.source === "entra-id" && e.target === "entra-id-2")?.access, "runs-as");
  });

  it("keeps a condition and marks a role it cannot read as unscoped", () => {
    const conditional = `${GCP}
resource "google_service_account_iam_member" "self" {
  service_account_id = google_service_account.api.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:\${google_service_account.api.email}"
  condition {
    title      = "t"
    expression = "request.time < timestamp(\\"2030-01-01T00:00:00Z\\") && resource.name.startsWith(\\"x\\")"
  }
}
`;
    assert.deepEqual(selfOf(read(conditional)), ["entra-id: admin (conditional)"]);
    assert.deepEqual(selfOf(read(own("organizations/1/roles/custom"))), ["entra-id: unscoped"]);
  });

  it("marks an Azure identity with an administrator role over itself", () => {
    const model = read(`
resource "azurerm_user_assigned_identity" "app" {
  name = "app"
}

resource "azurerm_role_assignment" "self" {
  scope                = azurerm_user_assigned_identity.app.id
  role_definition_name = "Owner"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}
`);
    assert.deepEqual(selfOf(model), ["entra-id: admin"]);
    const reader = read(`
resource "azurerm_user_assigned_identity" "app" {
  name = "app"
}

resource "azurerm_role_assignment" "self" {
  scope                = azurerm_user_assigned_identity.app.id
  role_definition_name = "Reader"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}
`);
    assert.deepEqual(selfOf(reader), []);
  });
});

describe("where a node's access to itself is shown", () => {
  const model = read(inline(`{ Effect = "Allow", Action = "iam:PutRolePolicy", Resource = aws_iam_role.fn.arn, Condition = { Bool = { "aws:SecureTransport" = "true" } } }`));
  const plain = read(inline(`{ Effect = "Allow", Action = "iam:GetRole", Resource = aws_iam_role.fn.arn }`));

  it("is in the explanation, in fixed words", () => {
    const text = explainModel(model, "aws", "eu-west-1");
    assert.match(text, /Can widen its own access: .* has admin access to itself \(conditional\)\./);
    assert.doesNotMatch(explainModel(plain, "aws", "eu-west-1"), /own access/);
  });

  it("is on the card in the SVG, and not on a card without it", () => {
    assert.match(modelToSvg(model), />self: admin, conditional</);
    assert.doesNotMatch(modelToSvg(plain), /self:/);
  });

  it("is a line of its own in the Access changes list, ranked with the edges, and in the diagram", () => {
    const diff = diffModels(plain, model);
    assert.ok(diff.nodes.changed.length > 0);
    const text = report(plain, model);
    assert.match(text, /#### Access changes/);
    assert.match(text, /- \*\*Added\*\* Managed Identity has admin access to itself \(conditional\)/);
    assert.match(renderDiagram(diff).mermaid ?? "", /has admin access to itself \(conditional\)/);
    const widened = report(model, read(inline(`{ Effect = "Allow", Action = "iam:PutRolePolicy", Resource = aws_iam_role.fn.arn }`)));
    assert.match(widened, /- \*\*Widened\*\* Managed Identity: has admin access to itself \(conditional\) to has admin access to itself$/m);
    assert.match(report(model, plain), /- \*\*Removed\*\* Managed Identity has admin access to itself \(conditional\)/);
    assert.doesNotMatch(report(model, model), /Access changes/);
  });

  it("never carries the policy's words", () => {
    const text = [explainModel(model, "aws", "eu-west-1"), modelToSvg(model), JSON.stringify(model), report(plain, model)].join("\n");
    for (const leaked of ["PutRolePolicy", "iam:", "SecureTransport", "arn:aws"]) assert.equal(text.includes(leaked), false, leaked);
  });

  it("has fixed wording", () => {
    assert.equal(selfAccessPhrase({}), undefined);
    assert.equal(selfAccessPhrase({ selfAccess: "unscoped" }), "has unscoped access to itself");
  });
});

function report(before: InfraModel, after: InfraModel): string {
  const diff = diffModels(before, after);
  return renderReport({
    mode: "check",
    modelPath: "diagram.json",
    terraformDir: "infra/",
    cloud: "aws",
    base: { state: "compared" },
    diff,
    diagram: renderDiagram(diff),
    warnings: [],
    terraformChanged: [],
    files: [],
    written: [],
    contentHash: "sha256:abc",
    signed: false,
  });
}
