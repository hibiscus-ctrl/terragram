// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { modelToSvg } from "terragram-engine/diagram-svg";
import { explainModel } from "terragram-engine/explain";
import { parseHcl } from "terragram-engine/hcl";
import { ANY_RESOURCE_ID, readIam, runsAsAddresses, strongerAccess } from "terragram-engine/iam";
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

/** `source -> target: access` for every typed edge, in model order. */
function typed(model: InfraModel): string[] {
  return model.edges.filter((e) => e.access).map((e) => `${e.source} -> ${e.target}: ${e.access}`);
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

  it("types a wildcard resource, NotResource, an unreadable policy and AdministratorAccess as unscoped", () => {
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
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}
`);
    assert.deepEqual(typed(admin.model).slice(1), [`entra-id -> ${ANY_RESOURCE_ID}: unscoped`]);
  });

  it("skips Deny statements, resources outside the picture and a named ARN with a wildcard path", () => {
    const { model } = read(
      withPolicy(`jsonencode({
    Statement = [
      { Effect = "Deny", Action = "s3:*", Resource = "*" },
      { Effect = "Allow", Action = "s3:GetObject", Resource = "arn:aws:s3:::someone-elses-bucket/*" },
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
    assert.equal(level(`"s3:*Object"`), "write");
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
    assert.equal(model.nodes.some((n) => n.kind === "external"), false, "the data source is read, not left as a block");
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
    assert.deepEqual(readIam(blocks, owner, "aws").edges, [{ source: "role", target: ANY_RESOURCE_ID, access: "unscoped" }]);
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
