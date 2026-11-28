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

describe("a role's access to itself through a literal ARN or a grant that is not bounded", () => {
  const put = (resource: string, extra = "") => inline(`{ Effect = "Allow", Action = "iam:PutRolePolicy", Resource = ${resource}${extra} }`);
  const anyEdge = (model: InfraModel) => model.edges.some((e) => e.target === ANY_RESOURCE_ID);

  it("counts a literal ARN of the role as the role itself", () => {
    for (const arn of [
      "arn:aws:iam::123456789012:role/fn",
      "arn:aws:iam::123456789012:role/service-role/FN",
      "arn:aws-us-gov:iam::123456789012:role/fn",
      "arn:aws:iam::${data.aws_caller_identity.current.account_id}:role/fn",
      "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:role/fn",
    ]) {
      const model = read(put(`"${arn}"`));
      assert.deepEqual(selfOf(model), ["entra-id: admin"], arn);
      assert.equal(anyEdge(model), false, `${arn} is the role, not everything`);
    }
  });

  it("does not count a literal ARN of a role that is not drawn, and says nothing about it", () => {
    const model = read(put(`"arn:aws:iam::123456789012:role/other"`));
    assert.deepEqual(selfOf(model), []);
    assert.equal(anyEdge(model), false);
  });

  it("treats a literal ARN as broad when a drawn role's name cannot be read", () => {
    const model = read(`${put(`"arn:aws:iam::123456789012:role/other"`)}
resource "aws_iam_role" "dyn" {
  name_prefix        = "dyn-"
  assume_role_policy = "{}"
}
`);
    assert.equal(anyEdge(model), true, "the ARN may be the role whose name is not known");
    assert.deepEqual(selfOf(model), ["entra-id: admin"]);
  });

  it("marks a grant over every resource, and one over every role, that can change IAM", () => {
    for (const resource of [`"*"`, `"arn:aws:iam::*:role/*"`, `"role/*"`, `"arn:aws:iam::123456789012:role/*"`, "var.role_arn"]) {
      const model = read(put(resource));
      assert.deepEqual(selfOf(model), ["entra-id: admin"], resource);
      assert.equal(anyEdge(model), true, resource);
    }
    assert.deepEqual(selfOf(read(put(`"*"`, `, Condition = { StringEquals = { "aws:RequestedRegion" = "eu-west-1" } }`))), ["entra-id: admin (conditional)"]);
  });

  it("marks a service wildcard and an action it cannot read, and leaves a grant that cannot change IAM", () => {
    const over = (action: string) => selfOf(read(inline(`{ Effect = "Allow", Action = ${action}, Resource = "*" }`)));
    assert.deepEqual(over(`"*"`), ["entra-id: admin"]);
    assert.deepEqual(over(`"iam:*"`), ["entra-id: admin"]);
    assert.deepEqual(over(`["s3:GetObject", "i*:Put*"]`), ["entra-id: admin"]);
    assert.deepEqual(over("var.actions"), ["entra-id: unscoped"]);
    assert.deepEqual(selfOf(read(inline(`{ Effect = "Allow", NotAction = "s3:*", Resource = "*" }`))), ["entra-id: unscoped"]);
    assert.deepEqual(over(`"s3:*"`), []);
    assert.deepEqual(over(`["s3:GetObject", "iam:GetRole", "iam:List*"]`), []);
  });

  it("marks AdministratorAccess and IAMFullAccess past the drawn-target cap, and not PowerUserAccess", () => {
    const attach = (policy: string, extra = "") => `${AWS}${extra}
resource "aws_iam_role_policy_attachment" "a" {
  role       = aws_iam_role.fn.name
  policy_arn = "arn:aws:iam::aws:policy/${policy}"
}
`;
    assert.deepEqual(selfOf(read(attach("AdministratorAccess"))), ["entra-id: admin"]);
    assert.deepEqual(selfOf(read(attach("PowerUserAccess"))), []);
    assert.deepEqual(selfOf(read(attach("ReadOnlyAccess"))), []);
    const many = Array.from({ length: 30 }, (_, i) => `resource "aws_iam_policy" "p${i}" {\n  name   = "p${i}"\n  policy = "{}"\n}\n`).join("");
    assert.deepEqual(selfOf(read(attach("IAMFullAccess", many))), ["entra-id: admin"]);
  });

  it("is the same level whether the grant names the role or everything, so swapping one for the other removes nothing", () => {
    const own = read(put(`aws_iam_role.fn.arn`));
    const broad = read(put(`"*"`));
    assert.deepEqual(selfOf(own), selfOf(broad));
    assert.doesNotMatch(report(own, broad), /\*\*Removed\*\*/);
    assert.doesNotMatch(report(own, read(put(`"arn:aws:iam::123456789012:role/fn"`))), /\*\*(Removed|Added|Widened|Narrowed)\*\*/);
  });
});

describe("what a role's conditional access to itself gives without the condition", () => {
  const conditionalUnscoped = `{ Effect = "Allow", NotAction = "s3:*", Resource = aws_iam_role.fn.arn, Condition = { StringEquals = { "aws:RequestedRegion" = "eu-west-1" } } }`;
  const unconditionalAdmin = `{ Effect = "Allow", Action = "iam:PutRolePolicy", Resource = aws_iam_role.fn.arn }`;
  const onlyConditional = read(inline(conditionalUnscoped));
  const withFloor = read(inline(`${conditionalUnscoped}, ${unconditionalAdmin}`));
  const plainAdmin = read(inline(unconditionalAdmin));

  it("is carried and worded like an edge's", () => {
    const node = withFloor.nodes.find((n) => n.selfAccess);
    assert.deepEqual([node?.selfAccess, node?.selfConditional, node?.selfUnconditional], ["unscoped", true, "admin"]);
    assert.equal(selfAccessPhrase(node ?? {}), "has unscoped access to itself (conditional; admin without the condition)");
    assert.match(modelToSvg(withFloor), />self: unscoped, conditional \(admin unconditional\)</);
    assert.equal(onlyConditional.nodes.find((n) => n.selfAccess)?.selfUnconditional, undefined);
    assert.equal(plainAdmin.nodes.find((n) => n.selfAccess)?.selfUnconditional, undefined);
    assert.equal(infraModelSchema.safeParse(withFloor).success, true);
  });

  it("is a widening when what holds without the condition goes up, even if the level goes down", () => {
    assert.match(report(onlyConditional, withFloor), /\*\*Widened\*\* Managed Identity: has unscoped access to itself \(conditional\) to has unscoped access to itself \(conditional; admin without the condition\)/);
    assert.match(report(onlyConditional, plainAdmin), /\*\*Widened\*\* Managed Identity: .* to has admin access to itself$/m);
    assert.doesNotMatch(report(onlyConditional, plainAdmin), /Narrowed/);
    assert.match(report(plainAdmin, onlyConditional), /\*\*Widened\*\*/, "a stronger level behind a condition is wider than a plain admin");
    assert.match(report(withFloor, onlyConditional), /\*\*Narrowed\*\*/);
  });
});

describe("a node whose only change is its access to itself", () => {
  const plain = read(inline(`{ Effect = "Allow", Action = "iam:GetRole", Resource = aws_iam_role.fn.arn }`));
  const admin = read(inline(`{ Effect = "Allow", Action = "iam:PutRolePolicy", Resource = aws_iam_role.fn.arn }`));
  const conditional = read(inline(`{ Effect = "Allow", Action = "iam:PutRolePolicy", Resource = aws_iam_role.fn.arn, Condition = { Bool = { "aws:SecureTransport" = "true" } } }`));

  it("is said in those words, not as a change of kind", () => {
    const added = report(plain, admin);
    assert.match(added, /- `entra-id` can now widen its own access: admin$/m);
    assert.match(report(plain, conditional), /- `entra-id` may now widen its own access: admin, conditional$/m);
    assert.match(report(admin, plain), /- `entra-id` no longer can widen its own access \(was admin\)$/m);
    assert.match(report(admin, conditional), /- `entra-id` may widen its own access: admin to admin, conditional$/m);
    for (const text of [added, report(admin, plain), report(admin, conditional)]) assert.doesNotMatch(text, /changed: /);
  });

  it("still says a real change of kind or label", () => {
    const renamed = structuredClone(admin);
    const node = renamed.nodes.find((n) => n.selfAccess);
    assert.ok(node);
    node.label = "Renamed";
    assert.match(report(admin, renamed), /`entra-id` changed: "Managed Identity" to "Renamed"/);
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
