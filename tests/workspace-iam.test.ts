// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { modelToSvg } from "terragram-engine/diagram-svg";
import { explainModel } from "terragram-engine/explain";
import { parseHcl } from "terragram-engine/hcl";
import { AWS_MANAGED_POLICIES_VERSION, MAX_MANAGED_EDGES, MAX_MANAGED_TARGETS, managedPolicyGrants, managedPolicyKeys } from "../packages/engine/src/aws-managed-policies.ts";
import { ANY_RESOURCE_ID, mergeAccess, readIam, runsAsAddresses, strongerAccess } from "terragram-engine/iam";
import type { InfraModel } from "terragram-engine/model";
import { infraModelSchema } from "terragram-engine/model";
import { parseTerraform } from "terragram-engine/parse";

import { renderDiagram } from "../action/src/mermaid.ts";
import { diffModels } from "../action/src/model-diff.ts";

/**
 * Typed edges: what a workload runs as and what its identity may reach, read from the
 * Terraform text alone. Nothing here evaluates anything; the policy text itself is never
 * in the model, only a level on an edge.
 */

function read(source: string) {
  const result = parseTerraform(source);
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result;
}

/**
 * `source -> target: access` for every typed edge, in model order. The fixtures' roles are trusted by the Lambda
 * service, and that trust edge (from the "An AWS service" stand-in) is read in workspace-iam-never-drop.test.ts:
 * these tests are about what a role's policies grant.
 */
function typed(model: InfraModel): string[] {
  return model.edges.filter((e) => e.access && e.source !== "principal-aws-service").map((e) => `${e.source} -> ${e.target}: ${e.access}`);
}

const AWS_BASE = `
resource "aws_s3_bucket" "data" {
  bucket = "x"
}

resource "aws_dynamodb_table" "orders" {
  name = "o"
}

resource "aws_sqs_queue" "jobs" {
  name = "j"
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

describe("typed edges from AWS policies", () => {
  const withPolicy = (policy: string) => `${AWS_BASE}
resource "aws_iam_role_policy" "fn" {
  role   = aws_iam_role.fn.id
  policy = ${policy}
}
`;

  it("types a workload's role, and the role's grants by the strongest level on each resource", () => {
    const { model, untranslated } = read(
      withPolicy(`jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["s3:GetObject", "s3:ListBucket"], Resource = [aws_s3_bucket.data.arn, "\${aws_s3_bucket.data.arn}/*"] },
      { Effect = "Allow", Action = ["dynamodb:PutItem", "dynamodb:Query"], Resource = aws_dynamodb_table.orders.arn },
      { Effect = "Allow", Action = "sqs:*", Resource = aws_sqs_queue.jobs.arn },
    ]
  })`),
    );
    assert.deepEqual(typed(model), [
      "functions -> entra-id: runs-as",
      "entra-id -> object-storage: read",
      "entra-id -> nosql: write",
      "entra-id -> queue: admin",
    ]);
    assert.deepEqual(untranslated, [], "a policy that became edges is not an untranslated block");
    assert.equal(model.nodes.some((n) => n.id === ANY_RESOURCE_ID), false);
  });

  it("is the same every time and keeps no policy text", () => {
    const tf = withPolicy(`jsonencode({
    Version = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["s3:GetObject"], Resource = aws_s3_bucket.data.arn }]
  })`);
    const a = JSON.stringify(read(tf).model);
    assert.equal(a, JSON.stringify(read(tf).model));
    for (const leaked of ["s3:GetObject", "2012-10-17", "Statement", "sts:AssumeRole", "lambda.amazonaws.com"]) {
      assert.equal(a.includes(leaked), false, `${leaked} must not reach the model`);
    }
  });

  it("types a wildcard resource, NotResource, an unreadable policy and a managed policy it does not know as unscoped", () => {
    const wildcard = read(withPolicy(`jsonencode({ Statement = [{ Effect = "Allow", Action = "s3:GetObject", Resource = "*" }] })`));
    assert.deepEqual(typed(wildcard.model), ["functions -> entra-id: runs-as", `entra-id -> ${ANY_RESOURCE_ID}: unscoped`]);
    assert.equal(wildcard.model.nodes.find((n) => n.id === ANY_RESOURCE_ID)?.label, "Any resource (*)");

    for (const policy of [
      `jsonencode({ Statement = [{ Effect = "Allow", Action = "s3:GetObject", NotResource = aws_s3_bucket.data.arn }] })`,
      `file("policy.json")`,
      `var.policy`,
      `jsonencode({ Statement = [{ Effect = "Allow", Action = "s3:GetObject", Resource = var.arn }] })`,
      `jsonencode({ Statement = [{ Effect = "Allow", Action = "s3:GetObject", Resource = "arn:aws:s3:::*" }] })`,
    ]) {
      const { model } = read(withPolicy(policy));
      assert.deepEqual(typed(model).slice(1), [`entra-id -> ${ANY_RESOURCE_ID}: unscoped`], policy);
    }

    const admin = read(`${AWS_BASE}
resource "aws_iam_role_policy_attachment" "admin" {
  role       = aws_iam_role.fn.name
  policy_arn = "arn:aws:iam::aws:policy/SomeNewManagedPolicy"
}
`);
    assert.deepEqual(typed(admin.model).slice(1), [`entra-id -> ${ANY_RESOURCE_ID}: unscoped`]);
  });

  it("skips Deny statements and references to resources outside the picture", () => {
    const { model } = read(
      withPolicy(`jsonencode({
    Statement = [
      { Effect = "Deny", Action = "s3:*", Resource = "*" },
      { Effect = "Allow", Action = "logs:PutLogEvents", Resource = aws_cloudwatch_log_group.elsewhere.arn },
      { Effect = "Allow", Action = "ssm:GetParameter", Resource = data.aws_ssm_parameter.p.arn },
    ]
  })`),
    );
    assert.deepEqual(typed(model), ["functions -> entra-id: runs-as"]);
  });

  it("levels an action by its name: read verbs, permission changes, wildcards and non-literals", () => {
    const level = (action: string) => {
      const { model } = read(
        withPolicy(`jsonencode({ Statement = [{ Effect = "Allow", Action = ${action}, Resource = aws_s3_bucket.data.arn }] })`),
      );
      return typed(model).find((t) => t.startsWith("entra-id -> object-storage"))?.split(": ")[1];
    };
    assert.equal(level(`"s3:Get*"`), "read");
    assert.equal(level(`"dynamodb:BatchGetItem"`), "read");
    assert.equal(level(`"sqs:ReceiveMessage"`), "read");
    assert.equal(level(`"s3:PutObject"`), "write");
    assert.equal(level(`"s3:*Object"`), "admin");
    assert.equal(level(`["s3:GetObject", "s3:PutObject"]`), "write");
    assert.equal(level(`"s3:PutBucketPolicy"`), "admin");
    assert.equal(level(`"iam:CreateRole"`), "admin");
    assert.equal(level(`"iam:ListRoles"`), "read");
    assert.equal(level(`"s3:*"`), "admin");
    assert.equal(level(`"*"`), "admin");
    assert.equal(level(`var.action`), "unscoped");
  });

  it("reads a heredoc of JSON, keeping its references", () => {
    const { model } = read(
      withPolicy(`<<-EOT
    {
      "Version": "2012-10-17",
      "Statement": [
        { "Effect": "Allow", "Action": ["s3:GetObject"], "Resource": "\${aws_s3_bucket.data.arn}/*" },
        { "Effect": "Allow", "Action": ["dynamodb:Scan"], "Resource": "\${aws_dynamodb_table.orders.arn}" }
      ]
    }
    EOT`),
    );
    assert.deepEqual(typed(model).slice(1), ["entra-id -> object-storage: read", "entra-id -> nosql: read"]);
  });

  it("reads a policy document data source and a policy attached by ARN", () => {
    const { model, untranslated } = read(`${AWS_BASE}
data "aws_iam_policy_document" "queue" {
  statement {
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.jobs.arn]
  }
  statement {
    effect    = "Deny"
    actions   = ["sqs:*"]
    resources = ["*"]
  }
}

resource "aws_iam_policy" "queue" {
  name   = "queue"
  policy = data.aws_iam_policy_document.queue.json
}

resource "aws_iam_role_policy_attachment" "queue" {
  role       = aws_iam_role.fn.name
  policy_arn = aws_iam_policy.queue.arn
}
`);
    assert.deepEqual(typed(model).slice(1), ["entra-id -> queue: write"]);
    assert.deepEqual(untranslated, []);
    assert.equal(model.nodes.some((n) => n.kind === "external" && !n.id.startsWith("principal-")), false, "the data source is read, not left as a block");
  });

  it("calls a policy document that merges others unreadable", () => {
    const { model } = read(`${AWS_BASE}
data "aws_iam_policy_document" "merged" {
  source_policy_documents = [data.aws_iam_policy_document.other.json]
}

resource "aws_iam_role_policy" "fn" {
  role   = aws_iam_role.fn.id
  policy = data.aws_iam_policy_document.merged.json
}
`);
    assert.deepEqual(typed(model).slice(1), [`entra-id -> ${ANY_RESOURCE_ID}: unscoped`]);
  });

  it("reads an inline policy on the role", () => {
    const { model } = read(`
resource "aws_s3_bucket" "data" {
  bucket = "x"
}

resource "aws_iam_role" "fn" {
  name = "fn"
  inline_policy {
    name   = "read"
    policy = jsonencode({ Statement = [{ Effect = "Allow", Action = "s3:GetObject", Resource = aws_s3_bucket.data.arn }] })
  }
}
`);
    assert.deepEqual(typed(model), ["entra-id -> object-storage: read"]);
  });

  it("follows an instance profile to the role it holds", () => {
    const { model, untranslated } = read(`
resource "aws_s3_bucket" "data" {
  bucket = "x"
}

resource "aws_iam_role" "host" {
  name = "host"
}

resource "aws_iam_instance_profile" "host" {
  name = "host"
  role = aws_iam_role.host.name
}

resource "aws_iam_role_policy" "host" {
  role   = aws_iam_role.host.id
  policy = jsonencode({ Statement = [{ Effect = "Allow", Action = "s3:PutObject", Resource = aws_s3_bucket.data.arn }] })
}

resource "aws_instance" "web" {
  ami                  = "ami-123"
  instance_type        = "t3.small"
  iam_instance_profile = aws_iam_instance_profile.host.name
}
`);
    assert.deepEqual(typed(model), ["app-service -> entra-id: runs-as", "entra-id -> object-storage: write"]);
    assert.deepEqual(untranslated, []);
  });

  it("leaves a policy on a role that is not drawn as an untranslated block", () => {
    const { untranslated } = read(`${AWS_BASE}
resource "aws_iam_role_policy" "orphan" {
  role   = aws_iam_role.not_in_this_file.id
  policy = jsonencode({ Statement = [] })
}
`);
    assert.deepEqual(untranslated, ["aws_iam_role_policy.orphan"]);
  });

  it("types an edge a plain reference already drew, rather than adding a second", () => {
    const { model } = read(`${AWS_BASE}
resource "aws_iam_role" "writer" {
  name = "writer"
}

resource "aws_iam_role_policy" "writer" {
  role   = aws_iam_role.writer.id
  policy = jsonencode({ Statement = [{ Effect = "Allow", Action = "s3:PutObject", Resource = aws_s3_bucket.data.arn }] })
}

resource "aws_s3_bucket_policy" "data" {
  bucket = aws_s3_bucket.data.id
  policy = aws_iam_role.writer.arn
}
`);
    const pairs = model.edges.map((e) => e.id);
    assert.equal(new Set(pairs).size, pairs.length);
  });
});

describe("typed edges from Azure role assignments", () => {
  const azure = (assignments: string) => `
resource "azurerm_storage_account" "data" {
  name = "data"
}

resource "azurerm_key_vault" "secrets" {
  name = "secrets"
}

resource "azurerm_user_assigned_identity" "app" {
  name = "app"
}

resource "azurerm_linux_web_app" "web" {
  name = "web"
  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }
}
${assignments}`;

  it("types the identity a web app runs as and a role assigned over one resource by the role's name", () => {
    const { model, untranslated } = read(
      azure(`
resource "azurerm_role_assignment" "blob" {
  scope                = azurerm_storage_account.data.id
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}

resource "azurerm_role_assignment" "vault" {
  scope                = azurerm_key_vault.secrets.id
  role_definition_name = "Key Vault Administrator"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}
`),
    );
    assert.deepEqual(typed(model), [
      "app-service -> entra-id: runs-as",
      "entra-id -> object-storage: read",
      "entra-id -> key-vault: admin",
    ]);
    assert.deepEqual(untranslated, []);
  });

  it("types a system-assigned app as its own principal, and Contributor as write", () => {
    const { model } = read(
      azure(`
resource "azurerm_role_assignment" "own" {
  scope                = azurerm_storage_account.data.id
  role_definition_name = "Contributor"
  principal_id         = azurerm_linux_web_app.web.identity[0].principal_id
}
`),
    );
    assert.deepEqual(typed(model).slice(1), ["app-service -> object-storage: write"]);
  });

  it("types a subscription or resource group scope, an unknown role and a role id as unscoped", () => {
    for (const [scope, role] of [
      ["data.azurerm_subscription.current.id", `role_definition_name = "Reader"`],
      ["azurerm_resource_group.main.id", `role_definition_name = "Reader"`],
      [`"/subscriptions/00000000-0000-0000-0000-000000000000"`, `role_definition_name = "Reader"`],
      ["var.scope", `role_definition_name = "Reader"`],
      ["azurerm_storage_account.data.id", `role_definition_name = "Some Custom Role"`],
      ["azurerm_storage_account.data.id", "role_definition_id = var.role"],
    ] as const) {
      const { model } = read(
        azure(`
resource "azurerm_role_assignment" "a" {
  scope        = ${scope}
  ${role}
  principal_id = azurerm_user_assigned_identity.app.principal_id
}
`),
      );
      const [grant] = typed(model).slice(1);
      assert.match(grant ?? "", /: unscoped$/, `${scope} ${role}`);
    }
  });
});

describe("the readers", () => {
  it("never evaluates: a function call, a template or a conditional is text", () => {
    const blocks = parseHcl(`
resource "aws_iam_role_policy" "p" {
  role   = aws_iam_role.r.id
  policy = templatefile("\${path.module}/policy.json", { bucket = aws_s3_bucket.b.arn })
}
`);
    const owner = (address: string) => ({ "aws_iam_role.r": "role", "aws_s3_bucket.b": "bucket" })[address];
    assert.deepEqual(readIam(blocks, owner).edges, [{ source: "role", target: ANY_RESOURCE_ID, access: "unscoped" }]);
  });

  it("finds the identities a workload runs under, through a profile", () => {
    const all = parseHcl(`
resource "aws_iam_instance_profile" "p" {
  role = aws_iam_role.r.name
}

resource "aws_ecs_task_definition" "t" {
  task_role_arn      = aws_iam_role.task.arn
  execution_role_arn = aws_iam_role.exec.arn
}

resource "aws_instance" "i" {
  iam_instance_profile = aws_iam_instance_profile.p.name
}
`);
    const [task, instance] = [all[1], all[2]];
    assert.deepEqual(runsAsAddresses([task!], all), ["aws_iam_role.task", "aws_iam_role.exec"]);
    assert.deepEqual(runsAsAddresses([instance!], all), ["aws_iam_role.r"]);
  });

  it("keeps the stronger of two access types", () => {
    assert.equal(strongerAccess(undefined, "read"), "read");
    assert.equal(strongerAccess("write", "read"), "write");
    assert.equal(strongerAccess("admin", "unscoped"), "unscoped");
    assert.equal(strongerAccess("runs-as", "read"), "read");
  });
});

describe("drawing typed edges", () => {
  const model: InfraModel = {
    nodes: [
      { id: "fn", category: "compute", kind: "functions", label: "Fn", flag: null },
      { id: "role", category: "identity", kind: "entra-id", label: "Role", flag: null },
      { id: "bucket", category: "storage", kind: "object-storage", label: "Bucket", flag: null },
    ],
    edges: [
      { id: "fn->role", source: "fn", target: "role", origin: "user", access: "runs-as" },
      { id: "role->bucket", source: "role", target: "bucket", origin: "user", access: "unscoped" },
    ],
    topology: "manual",
  };

  it("writes the type on each line of the SVG, and nothing on a plain edge", () => {
    const svg = modelToSvg(model);
    assert.match(svg, />runs as</);
    assert.match(svg, />unscoped</);
    assert.match(svg, /stroke="#b91c1c" stroke-width="2" stroke-dasharray="6 3"/);
    assert.equal(modelToSvg(model), svg);
    const plain = modelToSvg({ ...model, edges: model.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, origin: e.origin })) });
    assert.doesNotMatch(plain, /<text[^>]*>(runs as|unscoped)</);
  });

  it("labels the line in the pull request diagram and counts a changed type as a change", () => {
    const before: InfraModel = { ...model, edges: model.edges.map((e) => ({ ...e, access: "read" as const })) };
    const diff = diffModels(before, model);
    assert.equal(diff.edges.changed.length, 2);
    const { mermaid } = renderDiagram(diff);
    assert.match(mermaid ?? "", /n1 -->\|runs as\| n2/);
    assert.match(mermaid ?? "", /n2 -->\|unscoped\| n0/);
    assert.equal(diffModels(model, model).edges.unchanged.length, 2);
  });

  it("says what each typed edge means in the plain-English description", () => {
    const text = explainModel(model, "aws", "us-east-1");
    assert.match(text, /Fn runs as Role/);
    assert.match(text, /Role has unscoped access to Bucket/);
  });

  it("is part of the model document", () => {
    assert.equal(infraModelSchema.parse(model).edges[1]?.access, "unscoped");
    assert.throws(() => infraModelSchema.parse({ ...model, edges: [{ id: "a", source: "fn", target: "role", access: "root" }] }));
  });
});

describe("conditions keep the level and mark the edge", () => {
  const withStatements = (statements: string) => `${AWS_BASE}
resource "aws_iam_role_policy" "fn" {
  role   = aws_iam_role.fn.id
  policy = jsonencode({ Statement = [${statements}] })
}
`;
  /** `source -> target: access`, with " (conditional)" when marked, and the level some grant gives without a condition when it is lower. */
  const marked = (model: InfraModel) =>
    model.edges
      .filter((e) => e.access && e.access !== "runs-as")
      .map((e) => `${e.target}: ${e.access}${e.conditional ? (e.unconditional ? ` (conditional, ${e.unconditional} unconditional)` : " (conditional)") : ""}`);

  it("marks a grant behind a Condition as conditional without lowering its level", () => {
    const { model } = read(
      withStatements(`
      { Effect = "Allow", Action = "s3:*", Resource = aws_s3_bucket.data.arn, Condition = { StringEquals = { "aws:RequestedRegion" = "eu-west-1" } } },
      { Effect = "Allow", Action = "sqs:SendMessage", Resource = aws_sqs_queue.jobs.arn },`),
    );
    assert.deepEqual(marked(model), ["object-storage: admin (conditional)", "queue: write"]);
  });

  it("marks a wildcard or NotAction grant conditional but still unscoped, and never drops it", () => {
    const wildcard = read(withStatements(`{ Effect = "Allow", Action = "s3:GetObject", Resource = "*", Condition = { Bool = { "aws:SecureTransport" = "true" } } }`));
    assert.deepEqual(marked(wildcard.model), [`${ANY_RESOURCE_ID}: unscoped (conditional)`]);
    const notAction = read(withStatements(`{ Effect = "Allow", NotAction = "iam:*", Resource = aws_s3_bucket.data.arn, Condition = { Bool = { "x" = "y" } } }`));
    assert.deepEqual(marked(notAction.model), ["object-storage: unscoped (conditional)"]);
  });

  it("is conditional only when every grant at the strongest level is", () => {
    const cond = `Condition = { StringEquals = { "aws:RequestedRegion" = "eu-west-1" } }`;
    const bucket = "Resource = aws_s3_bucket.data.arn";
    const both = read(withStatements(`{ Effect = "Allow", Action = "s3:GetObject", ${bucket}, ${cond} }, { Effect = "Allow", Action = "s3:ListBucket", ${bucket} }`));
    assert.deepEqual(marked(both.model), ["object-storage: read"], "an unconditional grant at the same level wins");
    const stronger = read(withStatements(`{ Effect = "Allow", Action = "s3:PutObject", ${bucket}, ${cond} }, { Effect = "Allow", Action = "s3:GetObject", ${bucket} }`));
    assert.deepEqual(marked(stronger.model), ["object-storage: write (conditional, read unconditional)"], "the level shown is the conditional one, and the floor under it");
    const unconditionalAdmin = read(withStatements(`{ Effect = "Allow", Action = "s3:*", ${bucket} }, { Effect = "Allow", Action = "s3:GetObject", ${bucket}, ${cond} }`));
    assert.deepEqual(marked(unconditionalAdmin.model), ["object-storage: admin"]);
  });

  it("counts a condition only when it is a real one", () => {
    for (const condition of [`Condition = {}`, `Condition = { StringEquals = {} }`, `Condition = var.condition`, `Condition = "x"`, `Condition = []`]) {
      const { model } = read(withStatements(`{ Effect = "Allow", Action = "s3:PutObject", Resource = aws_s3_bucket.data.arn, ${condition} }`));
      assert.deepEqual(marked(model), ["object-storage: write"], condition);
    }
  });

  it("shows the unconditional floor under a conditional top level, however the grants are written", () => {
    const cond = `Condition = { StringEquals = { "aws:RequestedRegion" = "eu-west-1" } }`;
    const bucket = "Resource = aws_s3_bucket.data.arn";
    // An unconditional PutObject is not hidden behind a conditional PutBucketPolicy.
    const { model } = read(withStatements(`{ Effect = "Allow", Action = "s3:PutObject", ${bucket} }, { Effect = "Allow", Action = "s3:PutBucketPolicy", ${bucket}, ${cond} }`));
    assert.deepEqual(marked(model), ["object-storage: admin (conditional, write unconditional)"]);
    // Order does not matter, and the strongest unconditional level wins.
    const reversed = read(withStatements(`{ Effect = "Allow", Action = "s3:PutBucketPolicy", ${bucket}, ${cond} }, { Effect = "Allow", Action = "s3:GetObject", ${bucket} }, { Effect = "Allow", Action = "s3:PutObject", ${bucket} }`));
    assert.deepEqual(marked(reversed.model), ["object-storage: admin (conditional, write unconditional)"]);
    // Only conditional grants: no floor. An unconditional grant at the top level: not conditional at all.
    const none = read(withStatements(`{ Effect = "Allow", Action = "s3:PutBucketPolicy", ${bucket}, ${cond} }`));
    assert.deepEqual(marked(none.model), ["object-storage: admin (conditional)"]);
    // The floor survives a second policy over the same pair (a role policy plus an attached managed one).
    const twice = read(`${withStatements(`{ Effect = "Allow", Action = "s3:PutObject", ${bucket} }, { Effect = "Allow", Action = "s3:PutBucketPolicy", ${bucket}, ${cond} }`)}
resource "aws_iam_role_policy_attachment" "a" {
  role       = aws_iam_role.fn.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess"
}
`);
    assert.deepEqual(marked(twice.model).filter((m) => m.startsWith("object-storage")), ["object-storage: admin (conditional, write unconditional)"]);
    assert.match(JSON.stringify(model), /"unconditional":"write"/);
  });

  it("does not count a condition that is always true", () => {
    const alwaysTrue = [
      `Condition = { StringLike = { "aws:PrincipalArn" = "*" } }`,
      `Condition = { ArnLike = { "aws:PrincipalArn" = ["arn:aws:iam::123456789012:role/x", "*"] } }`,
      `Condition = { Null = { "aws:TokenIssueTime" = "false" } }`,
      `Condition = { StringEqualsIfExists = { "aws:RequestedRegion" = "eu-west-1" } }`,
      `Condition = { "ForAnyValue:StringLikeIfExists" = { "aws:TagKeys" = "team" } }`,
      `Condition = { Null = { "a" = "true" }, StringLike = { "b" = "*" } }`,
    ];
    for (const condition of alwaysTrue) {
      const { model } = read(withStatements(`{ Effect = "Allow", Action = "s3:PutObject", Resource = aws_s3_bucket.data.arn, ${condition} }`));
      assert.deepEqual(marked(model), ["object-storage: write"], condition);
    }
    // One real key among the always-true ones still narrows the grant.
    const real = read(withStatements(`{ Effect = "Allow", Action = "s3:PutObject", Resource = aws_s3_bucket.data.arn, Condition = { Null = { "a" = "true" }, StringEquals = { "aws:RequestedRegion" = "eu-west-1" } } }`));
    assert.deepEqual(marked(real.model), ["object-storage: write (conditional)"]);
    // The same in a policy document data source.
    const block = (test: string, values: string) => `${AWS_BASE}
data "aws_iam_policy_document" "fn" {
  statement {
    actions   = ["s3:PutObject"]
    resources = [aws_s3_bucket.data.arn]
    condition {
      test     = "${test}"
      variable = "aws:PrincipalArn"
      values   = ${values}
    }
  }
}
resource "aws_iam_role_policy" "fn" {
  role   = aws_iam_role.fn.id
  policy = data.aws_iam_policy_document.fn.json
}
`;
    assert.deepEqual(marked(read(block("StringLike", '["*"]')).model), ["object-storage: write"]);
    assert.deepEqual(marked(read(block("Null", '["false"]')).model), ["object-storage: write"]);
    assert.deepEqual(marked(read(block("StringEqualsIfExists", '["x"]')).model), ["object-storage: write"]);
    assert.deepEqual(marked(read(block("StringLike", '["arn:aws:iam::123456789012:role/x"]')).model), ["object-storage: write (conditional)"]);
  });

  it("reads a condition in a JSON heredoc and in a policy document data source", () => {
    const heredoc = read(`${AWS_BASE}
resource "aws_iam_role_policy" "fn" {
  role   = aws_iam_role.fn.id
  policy = <<EOT
{"Statement":[{"Effect":"Allow","Action":"s3:PutObject","Resource":"\${aws_s3_bucket.data.arn}/*","Condition":{"IpAddress":{"aws:SourceIp":"10.0.0.0/8"}}}]}
EOT
}
`);
    assert.deepEqual(marked(heredoc.model), ["object-storage: write (conditional)"]);

    const data = read(`${AWS_BASE}
data "aws_iam_policy_document" "fn" {
  statement {
    actions   = ["s3:PutObject"]
    resources = [aws_s3_bucket.data.arn]
    condition {
      test     = "StringEquals"
      variable = "aws:RequestedRegion"
      values   = ["eu-west-1"]
    }
  }
  statement {
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.jobs.arn]
    dynamic "condition" {
      for_each = var.conditions
      content {
        test     = condition.value.test
        variable = condition.value.variable
        values   = condition.value.values
      }
    }
  }
}
resource "aws_iam_role_policy" "fn" {
  role   = aws_iam_role.fn.id
  policy = data.aws_iam_policy_document.fn.json
}
`);
    assert.deepEqual(marked(data.model), ["object-storage: write (conditional)", "queue: write"], "a generated condition is not counted");
  });

  it("keeps the condition's text out of the model", () => {
    const { model } = read(withStatements(`{ Effect = "Allow", Action = "s3:PutObject", Resource = aws_s3_bucket.data.arn, Condition = { StringEquals = { "aws:PrincipalTag/team" = "secret-team-value" } } }`));
    const json = JSON.stringify(model);
    for (const leaked of ["secret-team-value", "PrincipalTag", "StringEquals"]) assert.equal(json.includes(leaked), false, leaked);
    assert.match(json, /"conditional":true/);
  });

  it("merges conditions by the strongest level", () => {
    assert.deepEqual(mergeAccess(undefined, { access: "read", conditional: true }), { access: "read", conditional: true });
    assert.deepEqual(mergeAccess({ access: "read", conditional: true }, { access: "read" }), { access: "read" });
    assert.deepEqual(mergeAccess({ access: "read" }, { access: "write", conditional: true }), { access: "write", conditional: true, unconditional: "read" });
    assert.deepEqual(mergeAccess({ access: "admin" }, { access: "read", conditional: true }), { access: "admin" });
    assert.deepEqual(mergeAccess({ access: "admin", conditional: true }, { access: "read" }), { access: "admin", conditional: true, unconditional: "read" });
    assert.deepEqual(mergeAccess({ access: "admin", conditional: true }, { access: "admin", conditional: true }), { access: "admin", conditional: true });
    // The floor is the strongest unconditional level over every grant, and an already merged edge keeps its own.
    const merged = mergeAccess({ access: "admin", conditional: true, unconditional: "read" }, { access: "write" });
    assert.deepEqual(merged, { access: "admin", conditional: true, unconditional: "write" });
    assert.deepEqual(mergeAccess(merged, { access: "read", conditional: true }), merged);
    assert.deepEqual(mergeAccess({ access: "admin", conditional: true, unconditional: "write" }, { access: "admin" }), { access: "admin" }, "an unconditional grant at the top level ends the condition");
    assert.deepEqual(mergeAccess({ access: "runs-as" }, { access: "write", conditional: true }), { access: "write", conditional: true }, "a runs-as link is not a level of access");
  });

  it("draws it: the SVG, the diagram, the description and the pull request diff say conditional", () => {
    const conditional: InfraModel = {
      nodes: [
        { id: "role", category: "identity", kind: "entra-id", label: "Role", flag: null },
        { id: "bucket", category: "storage", kind: "object-storage", label: "Bucket", flag: null },
      ],
      edges: [{ id: "role->bucket", source: "role", target: "bucket", origin: "user", access: "admin", conditional: true }],
      topology: "manual",
    };
    assert.match(modelToSvg(conditional), />admin, conditional</);
    assert.match(explainModel(conditional, "aws", "us-east-1"), /Role has admin access to Bucket \(conditional\)/);
    const plain: InfraModel = { ...conditional, edges: [{ id: "role->bucket", source: "role", target: "bucket", origin: "user", access: "admin" }] };
    const diff = diffModels(plain, conditional);
    assert.equal(diff.edges.changed.length, 1, "a condition added is a change");
    assert.equal(diffModels(conditional, conditional).edges.unchanged.length, 1);
    assert.match(renderDiagram(diff).mermaid ?? "", /-->\|admin, conditional\|/);
    assert.equal(infraModelSchema.parse(conditional).edges[0]?.conditional, true);
    assert.throws(() => infraModelSchema.parse({ ...conditional, edges: [{ ...conditional.edges[0], conditional: "yes" }] }));
    // The level some grant gives without the condition is drawn and described too, and is a change of its own.
    const floor: InfraModel = { ...conditional, edges: [{ id: "role->bucket", source: "role", target: "bucket", origin: "user", access: "admin", conditional: true, unconditional: "write" }] };
    assert.match(modelToSvg(floor), />admin, conditional \(write unconditional\)</);
    assert.match(explainModel(floor, "aws", "us-east-1"), /Role has admin access to Bucket \(conditional; write without the condition\)/);
    assert.equal(diffModels(conditional, floor).edges.changed.length, 1);
    assert.match(renderDiagram(diffModels(conditional, floor)).mermaid ?? "", /-->\|admin, conditional \(write unconditional\)\|/);
    assert.equal(infraModelSchema.parse(floor).edges[0]?.unconditional, "write");
    assert.throws(() => infraModelSchema.parse({ ...floor, edges: [{ ...floor.edges[0], unconditional: "root" }] }));
  });
});

describe("well-known AWS managed policies", () => {
  const attach = (arn: string, extra = "") => `${AWS_BASE}${extra}
resource "aws_iam_role_policy_attachment" "a" {
  role       = aws_iam_role.fn.name
  policy_arn = ${arn}
}
`;
  /** The edges past the workload's own runs-as edge, with " (conditional)" where marked. */
  const grants = (tf: string) =>
    read(tf).model.edges.filter((e) => e.access && e.access !== "runs-as").map((e) => `${e.target}: ${e.access}${e.conditional ? " (conditional)" : ""}`);
  const ANY = ANY_RESOURCE_ID;

  it("types a policy that covers every service at its level over any resource", () => {
    assert.deepEqual(grants(attach('"arn:aws:iam::aws:policy/AdministratorAccess"')), [`${ANY}: admin`]);
    assert.deepEqual(grants(attach('"arn:aws:iam::aws:policy/PowerUserAccess"')), [`${ANY}: admin`]);
    assert.deepEqual(grants(attach('"arn:aws:iam::aws:policy/ReadOnlyAccess"')), [`${ANY}: read`]);
    assert.deepEqual(grants(attach('"arn:aws:iam::aws:policy/job-function/ViewOnlyAccess"')), [`${ANY}: read`]);
  });

  it("types a service policy at its level on each drawn resource of that service", () => {
    // Every one also reaches "Any resource (*)" at the same level: the policy is on Resource `*`, not on the drawn buckets.
    assert.deepEqual(grants(attach('"arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess"')), [`${ANY}: read`, "object-storage: read"]);
    assert.deepEqual(grants(attach('"arn:aws:iam::aws:policy/AmazonS3FullAccess"')), [`${ANY}: admin`, "object-storage: admin"]);
    assert.deepEqual(grants(attach('"arn:aws:iam::aws:policy/AmazonSQSReadOnlyAccess"')), [`${ANY}: read`, "queue: read"]);
    assert.deepEqual(grants(attach('"arn:aws:iam::aws:policy/AmazonSQSFullAccess"')), [`${ANY}: admin`, "queue: admin"]);
    assert.deepEqual(grants(attach('"arn:aws:iam::aws:policy/AmazonDynamoDBReadOnlyAccess"')).filter((g) => g.startsWith("nosql")), ["nosql: read"]);
  });

  it("shows the account-wide reach of a managed policy next to the drawn resources, never only the drawn ones", () => {
    const buckets = ["a", "b"].map((n) => `resource "aws_s3_bucket" "${n}" {\n  bucket = "${n}"\n}\n`).join("");
    const edges = grants(attach('"arn:aws:iam::aws:policy/AmazonS3FullAccess"', buckets));
    assert.equal(edges.length, 4, "any resource, the base bucket and the two new ones");
    assert.ok(edges.includes(`${ANY}: admin`), "the account-wide edge is there");
    assert.equal(edges.filter((e) => e === "object-storage: admin").length, 1, "one edge per pair; the drawn ones are kept");
    const typed = read(attach('"arn:aws:iam::aws:policy/AmazonS3FullAccess"', buckets)).model.edges.filter((e) => e.access === "admin");
    assert.deepEqual(typed.map((e) => e.target).filter((t) => t !== ANY).length, 3);
    assert.ok(typed.some((e) => e.target === ANY));
  });

  it("keeps the role's own edge when the policy covers IAM, and the account-wide edge in the model", () => {
    const own = `${AWS_BASE}
resource "aws_iam_role_policy_attachment" "a" {
  role       = aws_iam_role.fn.name
  policy_arn = "arn:aws:iam::aws:policy/IAMFullAccess"
}
`;
    const blocks = parseHcl(own);
    const owned = readIam(blocks, (address) => (address === "aws_iam_role.fn" ? "fn" : undefined));
    assert.ok(owned.self.some((e) => e.source === "fn" && e.target === "fn" && e.access === "admin"), "a policy that covers IAM may rewrite the role it is attached to: kept apart from the edges, as the role's own access");
    assert.equal(owned.edges.some((e) => e.source === e.target), false);
    assert.ok(owned.edges.some((e) => e.source === "fn" && e.target === ANY_RESOURCE_ID && e.access === "admin"));
    assert.ok(grants(own).includes(`${ANY}: admin`), "the role's access to itself is on the node; the account-wide edge is in the model");
  });

  it("types a grant on a service the picture does not draw at its own level, over any resource", () => {
    // EKS worker nodes read EC2 and EKS, and may assume the role of a pod: that one is admin, on a service with nothing to point at.
    assert.deepEqual(grants(attach('"arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"')), [`${ANY}: admin`]);
    for (const [policy, services] of [
      ["AmazonEventBridgeFullAccess", ["schemas", "scheduler", "pipes"]],
      ["AmazonRDSFullAccess", ["application-autoscaling", "pi"]],
      ["AmazonRDSReadOnlyAccess", ["devops-guru"]],
      ["CloudFrontFullAccess", ["wafv2", "acm"]],
      ["AmazonCognitoPowerUser", ["cognito-sync"]],
      ["AmazonEKSWorkerNodePolicy", ["eks-auth"]],
    ] as const) {
      const held = (managedPolicyGrants(`arn:aws:iam::aws:policy/${policy}`) ?? []).map(([service]) => service);
      for (const service of services) assert.ok(held.includes(service), `${policy}: ${service}`);
    }
  });

  it("ends a grant at any resource when the policy's service has nothing drawn, keeping its level", () => {
    // Logs are not drawn here: the Lambda basic execution role still writes somewhere the picture does not show.
    assert.deepEqual(grants(attach('"arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"')), [`${ANY}: write`]);
    assert.deepEqual(grants(attach('"arn:aws:iam::aws:policy/IAMFullAccess"')), [`${ANY}: admin`]);
    assert.deepEqual(grants(attach('"arn:aws:iam::aws:policy/IAMReadOnlyAccess"')), [`${ANY}: read`]);
  });

  it("keeps a policy's strongest grant per resource and its conditions", () => {
    // Lambda full access: admin on the drawn function and, on Resource *, at any resource, where the conditional iam:PassRole joins it.
    // The helpers on services that are not drawn (logs, states, xray) are lower, so they do not change the pair's level.
    assert.deepEqual(grants(attach('"arn:aws:iam::aws:policy/AWSLambda_FullAccess"')).sort(), [`${ANY}: admin`, "functions: admin"]);
    // DynamoDB full access: the same conditional PassRole, but DAX is admin without one, so the pair is not conditional.
    assert.deepEqual(grants(attach('"arn:aws:iam::aws:policy/AmazonDynamoDBFullAccess"')).sort(), [`${ANY}: admin`, "functions: write", "nosql: admin"]);
  });

  it("reads the ARN written with the partition from a data source, and nothing else templated", () => {
    const partition = '"arn:${data.aws_partition.current.partition}:iam::aws:policy/AmazonS3ReadOnlyAccess"';
    assert.deepEqual(grants(attach(partition)), [`${ANY}: read`, "object-storage: read"]);
    assert.deepEqual(grants(attach(`[${partition}]`.slice(1, -1))), [`${ANY}: read`, "object-storage: read"]);
  });

  it("attaches through managed_policy_arns and the other attachment resource too, and consumes the block", () => {
    const onRole = AWS_BASE.replace('name = "fn"', 'name = "fn"\n  managed_policy_arns = ["arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess", "arn:aws:iam::aws:policy/AmazonSQSFullAccess"]');
    assert.deepEqual(grants(onRole), [`${ANY}: admin`, "object-storage: read", "queue: admin"]);
    const shared = `${AWS_BASE}
resource "aws_iam_policy_attachment" "a" {
  name       = "a"
  roles      = [aws_iam_role.fn.name]
  policy_arn = "arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess"
}
`;
    const result = read(shared);
    assert.deepEqual(grants(shared), [`${ANY}: read`, "object-storage: read"]);
    assert.deepEqual(result.untranslated, [], "a recognised attachment is understood, not left as a block");
  });

  it("draws one edge to any resource, not one per resource, once a service has more drawn than the cap", () => {
    const buckets = Array.from({ length: MAX_MANAGED_TARGETS + 1 }, (_, i) => `resource "aws_s3_bucket" "b${i}" {\n  bucket = "b${i}"\n}\n`).join("");
    const many = grants(attach('"arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess"', buckets));
    assert.deepEqual(many, [`${ANY}: read`]);
    const few = Array.from({ length: 3 }, (_, i) => `resource "aws_s3_bucket" "c${i}" {\n  bucket = "c${i}"\n}\n`).join("");
    assert.equal(grants(attach('"arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess"', few)).length, 5, "any resource, the base bucket and the three new ones, an edge to each");
  });

  it("bounds the edges one attachment adds, whatever it covers", () => {
    // Route 53 full access reads EC2, load balancers and S3: with 25 of the first two drawn, the bucket no longer fits.
    const drawn = Array.from({ length: MAX_MANAGED_TARGETS }, (_, i) => `resource "aws_vpc" "v${i}" {\n  cidr_block = "10.${i}.0.0/16"\n}\nresource "aws_lb" "l${i}" {\n  name = "l${i}"\n}\n`).join("");
    const { model } = read(attach('"arn:aws:iam::aws:policy/AmazonRoute53FullAccess"', drawn));
    const typedEdges = model.edges.filter((e) => e.access && e.access !== "runs-as");
    const kindOf = (id: string) => model.nodes.find((n) => n.id === id)?.kind;
    assert.equal(typedEdges.filter((e) => e.target !== ANY_RESOURCE_ID).length, MAX_MANAGED_EDGES);
    assert.equal(typedEdges.some((e) => kindOf(e.target) === "object-storage"), false, "the bucket is past the cap");
    assert.equal(typedEdges.find((e) => e.target === ANY_RESOURCE_ID)?.access, "admin", "route53 itself has nothing drawn");
  });

  it("never keeps the policy's name or any text in the model", () => {
    const json = JSON.stringify(read(attach('"arn:aws:iam::aws:policy/AmazonS3FullAccess"')).model);
    for (const leaked of ["AmazonS3FullAccess", "arn:aws", "s3:", "policy"]) assert.equal(json.includes(leaked), false, leaked);
  });

  it("holds a small, valid, versioned table whose levels follow the policies' published purpose", () => {
    const keys = managedPolicyKeys();
    assert.ok(keys.length >= 30 && keys.length <= 80, `${keys.length} policies`);
    assert.match(AWS_MANAGED_POLICIES_VERSION, /^\d{4}-\d{2}-\d{2}$/);
    for (const key of keys) {
      assert.match(key, /^(?:[a-z-]+\/)?[A-Za-z0-9_+=,.@-]{1,128}$/, key);
      const grants = managedPolicyGrants(`arn:aws:iam::aws:policy/${key}`);
      assert.ok(grants && grants.length > 0, key);
      for (const [service, level, conditional] of grants ?? []) {
        assert.match(service, /^(?:\*|[a-z0-9-]+)$/, `${key}: ${service}`);
        assert.ok(["read", "write", "admin"].includes(level), `${key}: ${level}`);
        assert.ok(conditional === undefined || conditional === true, key);
      }
      // A policy published as read-only grants nothing above read.
      if (/ReadOnly|ViewOnly|SecurityAudit/.test(key)) assert.ok((grants ?? []).every(([, level]) => level === "read"), key);
      // A full-access policy to one service reaches admin there.
      if (/FullAccess$/.test(key) && !/^(?:AmazonRDS|AmazonEC2Container|AmazonAPIGatewayInvoke)/.test(key) && (grants ?? []).length === 1) assert.equal(grants?.[0]?.[1], "admin", key);
    }
    for (const [arn, level] of [["AdministratorAccess", "admin"], ["PowerUserAccess", "admin"], ["ReadOnlyAccess", "read"]] as const) {
      assert.deepEqual(managedPolicyGrants(`arn:aws:iam::aws:policy/${arn}`), [["*", level]]);
    }
    assert.equal(managedPolicyGrants("arn:aws:iam::aws:policy/NotInTheTable"), undefined);
    assert.equal(managedPolicyGrants(`arn:aws:iam::aws:policy/${"A".repeat(5000)}`), undefined);
  });

  it("does not look up a hostile ARN: long, escaped or nested text is unscoped, quickly", () => {
    const start = performance.now();
    for (const arn of [
      `"${"arn:aws:iam::aws:policy/".repeat(20_000)}"`,
      `"arn:\${data.aws_partition.${"a".repeat(200_000)}.partition}:iam::aws:policy/AdministratorAccess"`,
      '"arn:aws:iam::aws:policy/Administrator\\u0041ccess"',
      '"arn:aws:iam::aws:policy/AdministratorAccess%{ if true }"',
      `"arn:\${data.aws_partition.\${data.aws_partition.x.partition}.partition}:iam::aws:policy/AdministratorAccess"`,
    ]) {
      assert.deepEqual(grants(attach(arn)), [`${ANY}: unscoped`], arn.slice(0, 60));
    }
    assert.ok(performance.now() - start < 2000);
  });
});

/* ------------------------------------------------------------ hostile input -- */

describe("what the reader is not sure of is unscoped, never dropped", () => {
  const ANY = `entra-id -> ${ANY_RESOURCE_ID}: unscoped`;
  const withPolicy = (policy: string) => `${AWS_BASE}
resource "aws_iam_role_policy" "fn" {
  role   = aws_iam_role.fn.id
  policy = ${policy}
}
`;
  const grants = (tf: string) => typed(read(tf).model).slice(1);
  const oneStatement = (action: string, resource: string) =>
    withPolicy(`jsonencode({ Statement = [{ Effect = "Allow", Action = ${action}, Resource = ${resource} }] })`);

  it("keeps a policy document attribute it cannot read, rather than dropping the statement", () => {
    // the unclosed list swallows the rest of its block, so the role policy comes first
    const unterminated = `${AWS_BASE}
resource "aws_iam_role_policy" "fn" {
  role   = aws_iam_role.fn.id
  policy = data.aws_iam_policy_document.d.json
}

data "aws_iam_policy_document" "d" {
  statement {
    effect = "Allow"
    resources = ["*"]
    actions = [ local.x # it's a "
  }
}
`;
    assert.deepEqual(grants(unterminated), [ANY]);

    const badResources = `${AWS_BASE}
resource "aws_iam_role_policy" "fn" {
  role   = aws_iam_role.fn.id
  policy = data.aws_iam_policy_document.d.json
}

data "aws_iam_policy_document" "d" {
  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = [ aws_s3_bucket.data.arn # "
  }
}
`;
    assert.deepEqual(grants(badResources), [ANY]);

    const trailing = `${AWS_BASE}
data "aws_iam_policy_document" "d" {
  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject"] == var.x ? ["s3:*"] : []
    resources = [aws_s3_bucket.data.arn]
  }
}

resource "aws_iam_role_policy" "fn" {
  role   = aws_iam_role.fn.id
  policy = data.aws_iam_policy_document.d.json
}
`;
    assert.ok(grants(trailing).every((g) => !g.endsWith(": read")), "an operator after a list is not a read-only list");
  });

  it("treats a statement with no Action or no Resource as unknown", () => {
    assert.deepEqual(grants(withPolicy(`jsonencode({ Statement = [{ Effect = "Allow", Resource = "*" }] })`)), [ANY]);
    assert.deepEqual(grants(withPolicy(`jsonencode({ Statement = [{ Effect = "Allow", Action = "s3:GetObject" }] })`)), [ANY]);
  });

  it("reads action names without regard to case, and any wildcard that is not a read pattern as admin", () => {
    const level = (action: string) => {
      const found = grants(oneStatement(action, "aws_s3_bucket.data.arn")).find((g) => g.includes("object-storage"));
      return found?.split(": ")[1] ?? grants(oneStatement(action, "aws_s3_bucket.data.arn"))[0]?.split(": ")[1];
    };
    assert.equal(level(`"S3:PUTBUCKETPOLICY"`), "admin");
    assert.equal(level(`"s3:putbucketpolicy"`), "admin");
    assert.equal(level(`"s3:getobject"`), "read");
    assert.equal(level(`"S3:LISTBUCKET"`), "read");
    assert.equal(level(`"s3:*Bucket*"`), "admin");
    assert.equal(level(`"sts:Assume*"`), "admin");
    assert.equal(level(`"iam*:Put*"`), "admin");
    assert.equal(level(`"*:PutObject"`), "admin");
    assert.equal(level(`"s3:Put*"`), "admin");
    assert.equal(level(`"s3:G*"`), "admin");
    assert.equal(level(`"s3:Get*"`), "read");
    assert.equal(level(`"s3:Get*Policy"`), "read");
    assert.equal(level(`"*:Get*"`), "read");
    assert.equal(level(`"s3:PutObject"`), "write");
    assert.equal(level(`"s3:Get*"`), "read");
  });

  it("types an action with a character it cannot match, or more than service:name, as unscoped", () => {
    for (const action of [`"s3:Get?bject"`, `"s3:Get Object"`, `"s3:Get\\u0041"`, `"s3:GetObject:x"`, `"s3:"`, `"GetObject"`, `"s3:Get\${var.x}"`, `"s3:Get%{ if true }x%{ endif }"`]) {
      const found = grants(oneStatement(action, "aws_s3_bucket.data.arn"));
      assert.deepEqual(found, ["entra-id -> object-storage: unscoped"], action);
    }
  });

  it("types a resource string with a wildcard anywhere, an escape or an unresolved template as unscoped", () => {
    for (const resource of [
      `"arn:aws:iam::123456789012:role/*"`,
      `"arn:aws:s3:::prod-*"`,
      `"arn:aws:s3:::prod-?"`,
      `"arn:aws:iam::*:role/x"`,
      `"arn:aws:s3:::bucket/*"`,
      `"arn:aws:s3:::\\u002a"`,
      `"arn:aws:s3:::b\\*"`,
      `"\${aws_s3_bucket.data.arn}*"`,
      `"*\${aws_s3_bucket.data.arn}"`,
      `"\${var.prefix}/*"`,
      `"arn:aws:s3:::\${var.bucket}"`,
      `"\${aws_unknown.thing.arn}/x"`,
      `"\${data.aws_caller_identity.me.account_id}"`,
      `"\${local.arn}"`,
      `"%{ if true }arn:aws:s3:::b%{ endif }"`,
      `"$\${aws_s3_bucket.data.arn}"`,
      `"\${aws_s3_bucket.data.arn"`,
    ]) {
      assert.ok(grants(oneStatement(`"s3:GetObject"`, resource)).includes(ANY), resource);
    }
    // the path under a drawn resource stays scoped
    assert.deepEqual(grants(oneStatement(`"s3:GetObject"`, `"\${aws_s3_bucket.data.arn}/*"`)), ["entra-id -> object-storage: read"]);
    assert.deepEqual(grants(oneStatement(`"s3:GetObject"`, `"\${aws_s3_bucket.data.arn}/a/b-*.txt"`)), ["entra-id -> object-storage: read"]);
  });

  it("types a local, a variable, a module output and a function that does not resolve as unscoped", () => {
    for (const resource of ["local.arn", "var.arn", "module.nope.arn", "module.nope.outputs[0]", "format(\"%s/*\", aws_s3_bucket.data.arn)", "aws_s3_bucket.data.arn[*]", "each.value", "(aws_s3_bucket.data.arn)", "var.x ? aws_s3_bucket.data.arn : \"*\""]) {
      assert.ok(grants(oneStatement(`"s3:GetObject"`, resource)).includes(ANY), resource);
    }
    assert.ok(grants(oneStatement(`"s3:GetObject"`, `[local.a, aws_s3_bucket.data.arn]`)).includes("entra-id -> object-storage: read"));
  });

  it("types a managed policy it cannot see as unscoped, and reads only a local one", () => {
    const attach = (arn: string) => `${AWS_BASE}
resource "aws_iam_role_policy_attachment" "a" {
  role       = aws_iam_role.fn.name
  policy_arn = ${arn}
}
`;
    for (const arn of [
      `"arn:aws:iam::aws:policy/SomeNewManagedPolicy"`,
      `"arn:aws:iam::aws:policy/service-role/AdministratorAccess"`,
      `"arn:aws:iam::aws:policy/administratoraccess"`,
      `"arn:aws-cn:iam::aws:policy/AdministratorAccess"`,
      `"arn:aws:iam::123456789012:policy/AdministratorAccess"`,
      `"arn:aws:iam::\${data.aws_caller_identity.me.account_id}:policy/x"`,
      `"arn:\${var.partition}:iam::aws:policy/AdministratorAccess"`,
      `"arn:\${data.aws_partition.current.partition}:iam::aws:policy/AdministratorAccess\${var.suffix}"`,
      `"arn:aws:iam::aws:policy/__proto__"`,
      `"arn:aws:iam::aws:policy/constructor"`,
      "var.policy_arn",
      "data.aws_iam_policy.p.arn",
      "aws_iam_policy.not_in_this_file.arn",
    ]) {
      assert.deepEqual(grants(attach(arn)), [ANY], arn);
    }
    const onRole = `${AWS_BASE.replace('name = "fn"', 'name = "fn"\n  managed_policy_arns = ["arn:aws:iam::aws:policy/SomeNewManagedPolicy", aws_iam_policy.q.arn]')}
resource "aws_iam_policy" "q" {
  name   = "q"
  policy = jsonencode({ Statement = [{ Effect = "Allow", Action = "sqs:SendMessage", Resource = aws_sqs_queue.jobs.arn }] })
}
`;
    assert.deepEqual(grants(onRole), [ANY, "entra-id -> queue: write"]);
  });

  it("marks a block consumed only once it drew an edge", () => {
    const { untranslated } = read(withPolicy(`jsonencode({ Statement = [{ Effect = "Allow", Action = "s3:GetObject", Resource = aws_elsewhere.thing.arn }] })`));
    assert.deepEqual(untranslated, ["aws_iam_role_policy.fn"]);
    const drawn = read(withPolicy(`jsonencode({ Statement = [{ Effect = "Allow", Action = "s3:GetObject", Resource = aws_s3_bucket.data.arn }] })`));
    assert.deepEqual(drawn.untranslated, []);
    const doc = read(`${AWS_BASE}
data "aws_iam_policy_document" "d" {
  statement {
    actions   = ["s3:GetObject"]
    resources = [aws_elsewhere.thing.arn]
  }
}

resource "aws_iam_role_policy" "fn" {
  role   = aws_iam_role.fn.id
  policy = data.aws_iam_policy_document.d.json
}
`);
    assert.ok(doc.untranslated.includes("aws_iam_role_policy.fn"));
    assert.ok(doc.model.nodes.some((n) => n.label === "data d"), "a document that drew nothing stays on the picture");
  });

  it("falls back to unscoped when the reader itself throws, instead of crashing parse", () => {
    const blocks = parseHcl(`
resource "aws_iam_role_policy" "p" {
  role   = aws_iam_role.r.id
  policy = jsonencode({ Statement = [{ Effect = "Allow", Action = "s3:GetObject", Resource = aws_s3_bucket.b.arn }] })
}
`);
    const owner = (address: string) => {
      if (address === "aws_iam_role.r") return "role";
      throw new RangeError("boom");
    };
    assert.deepEqual(readIam(blocks, owner).edges, [{ source: "role", target: ANY_RESOURCE_ID, access: "unscoped" }]);
  });
});

describe("Azure scopes that are not one drawn resource are unscoped", () => {
  const assign = (scope: string) => `
resource "azurerm_storage_account" "data" {
  name = "data"
}

resource "azurerm_user_assigned_identity" "app" {
  name = "app"
}

resource "azurerm_role_assignment" "a" {
  scope                = ${scope}
  role_definition_name = "Reader"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}
`;
  const grants = (scope: string) => typed(read(assign(scope)).model);

  it("reads only the id of one drawn resource", () => {
    assert.deepEqual(grants("azurerm_storage_account.data.id"), ["entra-id -> object-storage: read"]);
    assert.deepEqual(grants(`"\${azurerm_storage_account.data.id}"`), ["entra-id -> object-storage: read"]);
    assert.deepEqual(grants(`"\${azurerm_storage_account.data.id}/blobServices/default"`), ["entra-id -> object-storage: read"]);
  });

  it("types everything else as unscoped", () => {
    for (const scope of [
      "module.x.id",
      "module.x.storage_id",
      `"/"`,
      `"/providers/Microsoft.Management/managementGroups/root"`,
      `"/subscriptions/00000000-0000-0000-0000-000000000000"`,
      `"/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg"`,
      `"/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/other"`,
      `"\${azurerm_storage_account.data.id}/../.."`,
      `"\${azurerm_storage_account.data.id}\${var.sub}"`,
      "azurerm_resource_group.main.id",
      "azurerm_storage_account.data.name",
      "azurerm_storage_account.nowhere.id",
      "local.scope",
      "var.scope",
      "data.azurerm_subscription.current.id",
      `var.flag ? azurerm_storage_account.data.id : "/"`,
      "azurerm_storage_account.data[*].id",
    ]) {
      assert.deepEqual(grants(scope), [`entra-id -> ${ANY_RESOURCE_ID}: unscoped`], scope);
    }
  });

  it("does not read a role name with a template in it", () => {
    const model = read(assign("azurerm_storage_account.data.id").replace('"Reader"', '"${var.x} Reader"')).model;
    assert.deepEqual(typed(model), ["entra-id -> object-storage: unscoped"]);
  });
});

describe("hostile policy text is bounded", () => {
  const withPolicy = (policy: string) => `resource "aws_s3_bucket" "data" {
  bucket = "x"
}

resource "aws_iam_role" "fn" {
  name = "fn"
}

resource "aws_iam_role_policy" "fn" {
  role   = aws_iam_role.fn.id
  policy = ${policy}
}
`;
  const ANY = `entra-id -> ${ANY_RESOURCE_ID}: unscoped`;
  const timed = <T>(run: () => T, limitMs: number): T => {
    const start = performance.now();
    const result = run();
    const took = performance.now() - start;
    assert.ok(took < limitMs, `took ${Math.round(took)} ms, limit ${limitMs} ms`);
    return result;
  };

  it("reads a long heredoc in linear time and still finds its terminator", () => {
    const hostile = `<<EOT\n${"\n".repeat(80_000)}x\nEOT`;
    assert.equal(timed(() => readIam(parseHcl(withPolicy(hostile)), () => "role").edges.length, 2000), 1);

    const spaces = `<<EOT\n${" \n".repeat(40_000)}`;
    timed(() => readIam(parseHcl(withPolicy(spaces)), () => "role"), 2000);

    const real = `<<-EOT
    {"Statement": [{ "Effect": "Allow", "Action": "s3:GetObject", "Resource": "${"$"}{aws_s3_bucket.data.arn}" }]}
    EOT`;
    assert.deepEqual(typed(read(withPolicy(real)).model).slice(0), ["entra-id -> object-storage: read"]);
    const early = `<<EOT
    {"Statement": [{ "Effect": "Allow", "Action": "s3:GetObject", "Resource": "*" }]}
    EOT
    more
    EOT`;
    assert.deepEqual(typed(read(withPolicy(early)).model), [ANY]);
  });

  it("gives up on deep nesting as unscoped instead of overflowing the stack", () => {
    const depth = 200_000;
    const cases = {
      string: `"${"${\"".repeat(depth)}"`,
      braces: `"${"${".repeat(depth)}"`,
      list: `jsonencode(${"[".repeat(depth)}${"]".repeat(depth)})`,
      object: `jsonencode(${"{ a = ".repeat(depth)}1${" }".repeat(depth)})`,
      json: `<<EOT\n{"Statement": ${"[".repeat(depth)}${"]".repeat(depth)}}\nEOT`,
      jsonString: `"{\\"Statement\\": ${"[".repeat(depth)}${"]".repeat(depth)}}"`,
    };
    for (const [name, policy] of Object.entries(cases)) {
      const blocks = parseHcl(withPolicy(policy));
      const edges = timed(() => readIam(blocks, (a) => (a === "aws_iam_role.fn" ? "entra-id" : undefined)).edges, 3000);
      assert.deepEqual(edges, [{ source: "entra-id", target: ANY_RESOURCE_ID, access: "unscoped" }], name);
    }
  });

  it("types a policy nested just inside the cap as readable and one just past it as unscoped", () => {
    const nest = (n: number) => `{ "Statement": [{ "Effect": "Allow", "Action": "s3:GetObject", "Resource": "${"$"}{aws_s3_bucket.data.arn}", "Condition": ${"[".repeat(n)}${"]".repeat(n)} }] }`;
    const model = (n: number) => typed(read(withPolicy(`<<EOT\n${nest(n)}\nEOT`)).model);
    assert.deepEqual(model(10), ["entra-id -> object-storage: read"]);
    assert.deepEqual(model(200), [ANY]);
  });

  it("does not crash terragram parse on a pile of hostile policies", () => {
    const junk = ["\"", "${", "[[[", "}}}", "<<", "jsonencode(", "\\", "%{", "\"${\"${"].join("");
    for (let i = 0; i < junk.length; i++) {
      const policy = junk.slice(i);
      assert.doesNotThrow(() => parseTerraform(withPolicy(policy)), policy);
    }
  });
});
