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
  assume_role_policy = "{}"
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

describe("a Google Cloud grant's target is only what names the resource it is on", () => {
  const GCP = `
resource "google_project" "app" {
  name       = "App"
  project_id = "app"
}

resource "google_storage_bucket" "data" {
  name = "data"
}
`;
  const edgesOf = (grant: string) => typed(read(GCP + grant).model);

  it("does not take a depends_on, count, for_each or provider as the target", () => {
    for (const meta of ["depends_on = [google_storage_bucket.data]", "provider = google.other", "for_each = toset([google_storage_bucket.data.name])", "count = length(google_storage_bucket.data.name)"]) {
      assert.deepEqual(
        edgesOf(`
resource "google_artifact_registry_repository_iam_member" "g" {
  location = "europe-west2"
  role     = "roles/artifactregistry.reader"
  member   = "allUsers"
  ${meta}
}
`),
        ["principal-all-users -> any-resource: unscoped"],
        meta,
      );
    }
  });

  it("draws any resource, not a reference found elsewhere, when the resource is named by a literal", () => {
    assert.deepEqual(
      edgesOf(`
resource "google_artifact_registry_repository_iam_member" "g" {
  repository = "my-repo"
  role       = "roles/artifactregistry.reader"
  member     = "allUsers"
  depends_on = [google_storage_bucket.data]
}
`),
      ["principal-all-users -> any-resource: unscoped"],
    );
    assert.deepEqual(
      edgesOf(`
resource "google_artifact_registry_repository_iam_member" "g" {
  repository = "my-repo"
  repository_project = google_storage_bucket.data.project
  role       = "roles/artifactregistry.reader"
  member     = "allUsers"
}
`),
      ["principal-all-users -> any-resource: unscoped"],
    );
  });

  it("still takes a reference in an attribute that names the resource", () => {
    assert.deepEqual(
      edgesOf(`
resource "google_artifact_registry_repository_iam_member" "g" {
  repository = google_storage_bucket.data.name
  role       = "roles/artifactregistry.reader"
  member     = "allUsers"
  depends_on = [google_project.app]
}
`),
      ["principal-all-users -> object-storage: read"],
    );
  });
});

describe("resource-based and trust policies draw edges into the resource from the principals they name", () => {
  const edgesOf = (extra: string, keep = (e: string) => !e.startsWith("functions -> ")) => typed(read(BASE + extra).model).filter(keep);
  const bucketPolicy = (statement: string) => `
resource "aws_s3_bucket_policy" "p" {
  bucket = aws_s3_bucket.data.id
  policy = jsonencode({ Statement = [${statement}] })
}
`;

  it("draws Principal \"*\" and {AWS: \"*\"} as Anyone (*)", () => {
    for (const principal of [`"*"`, `{ AWS = "*" }`, `{ AWS = ["*"] }`]) {
      const model = read(BASE + bucketPolicy(`{ Effect = "Allow", Principal = ${principal}, Action = "s3:GetObject", Resource = "arn:aws:s3:::data-bucket/*" }`)).model;
      assert.ok(typed(model).includes("principal-aws-anyone -> object-storage: read"), `${principal}: ${typed(model).join(" | ")}`);
      assert.equal(model.nodes.find((n) => n.id === "principal-aws-anyone")?.label, "Anyone (*)");
    }
  });

  it("keeps a condition as conditional and never lowers the level", () => {
    assert.deepEqual(
      edgesOf(bucketPolicy(`{ Effect = "Allow", Principal = "*", Action = "s3:*", Resource = "*", Condition = { StringEquals = { "aws:SourceVpce" = "vpce-1" } } }`)),
      ["principal-aws-anyone -> object-storage: admin, conditional"],
    );
  });

  it("draws NotPrincipal, an unreadable Principal and a missing one as unscoped", () => {
    assert.deepEqual(edgesOf(bucketPolicy(`{ Effect = "Allow", NotPrincipal = { AWS = "arn:aws:iam::123456789012:root" }, Action = "s3:GetObject", Resource = "*" }`)), [
      "principal-aws-anyone -> object-storage: unscoped",
    ]);
    assert.deepEqual(edgesOf(bucketPolicy(`{ Effect = "Allow", Principal = var.principal, Action = "s3:GetObject", Resource = "*" }`)), ["principal-other -> object-storage: unscoped"]);
    assert.deepEqual(edgesOf(bucketPolicy(`{ Effect = "Allow", Action = "s3:GetObject", Resource = "*" }`)), ["principal-other -> object-storage: unscoped"]);
    assert.deepEqual(edgesOf(bucketPolicy(`{ Effect = "Allow", Principal = { AWS = var.arn }, Action = "s3:GetObject", Resource = "*" }`)), ["principal-other -> object-storage: unscoped"]);
  });

  it("draws an account, a service and a federated principal from their own stand-ins, and a drawn role as itself", () => {
    assert.deepEqual(
      edgesOf(
        bucketPolicy(`{ Effect = "Allow", Principal = { AWS = "arn:aws:iam::123456789012:root", Service = "cloudtrail.amazonaws.com", Federated = "cognito-identity.amazonaws.com" }, Action = "s3:PutObject", Resource = "*" }`),
      ).sort(),
      [
        "principal-aws-account -> object-storage: write",
        "principal-aws-service -> object-storage: write",
        "principal-federated -> object-storage: write",
      ],
    );
    assert.deepEqual(edgesOf(bucketPolicy(`{ Effect = "Allow", Principal = { AWS = aws_iam_role.fn.arn }, Action = "s3:GetObject", Resource = "*" }`)), ["entra-id -> object-storage: read"]);
    // Only an account that is provably this one maps to a drawn role: here, the one the caller is in.
    assert.deepEqual(
      edgesOf(bucketPolicy(`{ Effect = "Allow", Principal = { AWS = "arn:aws:iam::${"$"}{data.aws_caller_identity.current.account_id}:role/fn" }, Action = "s3:GetObject", Resource = "*" }`)),
      ["entra-id -> object-storage: read"],
    );
  });

  it("does not map a principal ARN of another account to the drawn role of the same name", () => {
    const other = `"arn:aws:iam::210987654321:role/fn"`;
    assert.deepEqual(edgesOf(bucketPolicy(`{ Effect = "Allow", Principal = { AWS = ${other} }, Action = "s3:GetObject", Resource = "*" }`)), [
      "principal-aws-account -> object-storage: read",
    ]);
    // A role whose account is a variable may be anyone's: it is not the drawn one either.
    assert.deepEqual(edgesOf(bucketPolicy(`{ Effect = "Allow", Principal = { AWS = "arn:aws:iam::${"$"}{var.account}:role/fn" }, Action = "s3:GetObject", Resource = "*" }`)), [
      "principal-aws-account -> object-storage: read",
    ]);
    const trust = edgesOf(`
resource "aws_iam_role" "t" {
  name = "t"
  assume_role_policy = jsonencode({ Statement = [{ Effect = "Allow", Principal = { AWS = ${other} }, Action = "sts:AssumeRole" }] })
}
`);
    assert.deepEqual(trust.filter((e) => e.includes("-> entra-id-2")), ["principal-aws-account -> entra-id-2: admin"]);
    assert.equal(trust.some((e) => e === "entra-id -> entra-id-2: runs-as"), false);
  });

  it("reads a principal of type \"*\" as anyone", () => {
    const block = (identifiers: string) => `${BASE}
data "aws_iam_policy_document" "p" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["*"]
    principals {
      type        = "*"
      identifiers = ${identifiers}
    }
  }
}

resource "aws_s3_bucket_policy" "p" {
  bucket = aws_s3_bucket.data.id
  policy = data.aws_iam_policy_document.p.json
}
`;
    assert.deepEqual(typed(read(block('["*"]')).model).filter((e) => !e.startsWith("functions")), ["principal-aws-anyone -> object-storage: read"]);
    assert.deepEqual(typed(read(block('["arn:aws:iam::123456789012:root"]')).model).filter((e) => !e.startsWith("functions")), ["principal-aws-anyone -> object-storage: unscoped"]);
    assert.deepEqual(typed(read(block("var.who")).model).filter((e) => !e.startsWith("functions")), ["principal-aws-anyone -> object-storage: unscoped"]);
    for (const principal of [`"*"`, `{ "*" = "*" }`]) {
      assert.deepEqual(edgesOf(bucketPolicy(`{ Effect = "Allow", Principal = ${principal}, Action = "s3:GetObject", Resource = "*" }`)), ["principal-aws-anyone -> object-storage: read"], principal);
    }
  });

  it("reads a policy document data source with principals and not_principals blocks", () => {
    const model = read(`${BASE}
data "aws_iam_policy_document" "p" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
  }
  statement {
    actions   = ["s3:PutObject"]
    resources = ["*"]
    not_principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::123456789012:root"]
    }
  }
}

resource "aws_s3_bucket_policy" "p" {
  bucket = aws_s3_bucket.data.id
  policy = data.aws_iam_policy_document.p.json
}
`).model;
    assert.deepEqual(typed(model).filter((e) => !e.startsWith("functions")), ["principal-aws-anyone -> object-storage: unscoped"]);
  });

  it("draws a trust policy: the service that assumes a role runs as it, another account is admin, anyone is unscoped", () => {
    const trust = (principal: string) =>
      edgesOf(`
resource "aws_iam_role" "t" {
  name = "t"
  assume_role_policy = jsonencode({ Statement = [{ Effect = "Allow", Principal = ${principal}, Action = "sts:AssumeRole" }] })
}
`).filter((e) => e.includes("-> entra-id-2"));
    assert.deepEqual(trust(`{ Service = "ecs-tasks.amazonaws.com" }`), ["principal-aws-service -> entra-id-2: runs-as"]);
    assert.deepEqual(trust(`{ AWS = "arn:aws:iam::123456789012:root" }`), ["principal-aws-account -> entra-id-2: admin"]);
    assert.deepEqual(trust(`{ AWS = "*" }`), ["principal-aws-anyone -> entra-id-2: unscoped"]);
    assert.deepEqual(trust(`{ AWS = aws_iam_role.fn.arn }`), ["entra-id -> entra-id-2: runs-as"]);
    assert.deepEqual(trust(`{ Federated = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" }`), ["principal-federated -> entra-id-2: admin"]);
  });

  it("draws a Lambda permission, an SQS, SNS, KMS, Secrets Manager and ECR policy", () => {
    const model = read(`${BASE}
resource "aws_lambda_permission" "any" {
  statement_id  = "any"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "*"
}

resource "aws_lambda_permission" "s3" {
  statement_id  = "s3"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "s3.amazonaws.com"
  source_arn    = aws_s3_bucket.data.arn
}

resource "aws_sqs_queue_policy" "q" {
  queue_url = aws_sqs_queue.jobs.id
  policy    = jsonencode({ Statement = [{ Effect = "Allow", Principal = "*", Action = "sqs:SendMessage", Resource = "*" }] })
}

resource "aws_kms_key" "k" {
  description = "k"
  policy      = jsonencode({ Statement = [{ Effect = "Allow", Principal = { AWS = "*" }, Action = "kms:*", Resource = "*" }] })
}

resource "aws_secretsmanager_secret" "s" {
  name = "s"
}

resource "aws_secretsmanager_secret_policy" "s" {
  secret_arn = aws_secretsmanager_secret.s.arn
  policy     = jsonencode({ Statement = [{ Effect = "Allow", Principal = "*", Action = "secretsmanager:GetSecretValue", Resource = "*" }] })
}

resource "aws_ecr_repository" "r" {
  name = "r"
}

resource "aws_ecr_repository_policy" "r" {
  repository = aws_ecr_repository.r.name
  policy     = jsonencode({ Statement = [{ Effect = "Allow", Principal = "*", Action = "ecr:BatchGetImage" }] })
}
`).model;
    const edges = typed(model);
    const ids = new Map(model.nodes.map((n) => [n.id, n.kind]));
    const into = (kind: string) => edges.filter((e) => e.startsWith("principal-aws-") && ids.get(e.split(" -> ")[1]?.split(":")[0] ?? "") === kind);
    assert.deepEqual(into("functions"), ["principal-aws-anyone -> functions: write", "principal-aws-service -> functions: write, conditional"], edges.join(" | "));
    assert.ok(edges.includes("principal-aws-anyone -> queue: write"), edges.join(" | "));
    // The key and the secret are one node, at the stronger of the two (the key's own policy); a repository the picture does not draw is any resource.
    assert.ok(edges.includes("principal-aws-anyone -> key-vault: admin"), edges.join(" | "));
    assert.ok(edges.includes(`principal-aws-anyone -> ${ANY_RESOURCE_ID}: unscoped`), edges.join(" | "));
  });

  it("is unscoped when the policy is on something that is not drawn or cannot be read", () => {
    assert.deepEqual(
      edgesOf(`
resource "aws_sqs_queue_policy" "q" {
  queue_url = var.queue_url
  policy    = jsonencode({ Statement = [{ Effect = "Allow", Principal = "*", Action = "sqs:SendMessage", Resource = "*" }] })
}

resource "aws_sns_topic_policy" "t" {
  arn    = aws_sns_topic.t.arn
  policy = var.policy
}
`),
      [`principal-aws-anyone -> ${ANY_RESOURCE_ID}: unscoped`, `principal-other -> ${ANY_RESOURCE_ID}: unscoped`].sort(),
    );
  });

  it("does not read a Deny statement as a grant", () => {
    assert.deepEqual(edgesOf(bucketPolicy(`{ Effect = "Deny", Principal = "*", Action = "s3:*", Resource = "*" }`)), []);
  });
});

describe("an Azure role assignment to a principal that is not drawn is still a grant", () => {
  const AZURE = `
resource "azurerm_storage_account" "data" {
  name = "data"
}

resource "azurerm_user_assigned_identity" "app" {
  name = "app"
}
`;
  const edgesOf = (assignment: string) => typed(read(AZURE + assignment).model);

  it("draws Owner on the subscription for a variable or a data-sourced group as unscoped from a stand-in", () => {
    for (const principal of ["var.admin_group_id", "data.azuread_group.admins.object_id", `"00000000-0000-0000-0000-000000000000"`]) {
      const { model } = read(`${AZURE}
resource "azurerm_role_assignment" "owner" {
  scope                = data.azurerm_subscription.current.id
  role_definition_name = "Owner"
  principal_id         = ${principal}
}
`);
      assert.deepEqual(typed(model), [`principal-azure -> ${ANY_RESOURCE_ID}: unscoped`], principal);
      assert.equal(model.nodes.find((n) => n.id === "principal-azure")?.label, "An Azure principal (not drawn)");
    }
  });

  it("marks the grant over one drawn resource unscoped too, and keeps a drawn principal's own edge", () => {
    assert.deepEqual(
      edgesOf(`
resource "azurerm_role_assignment" "blob" {
  scope                = azurerm_storage_account.data.id
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = var.group
}
`),
      ["principal-azure -> object-storage: unscoped"],
    );
    assert.deepEqual(
      edgesOf(`
resource "azurerm_role_assignment" "blob" {
  scope                = azurerm_storage_account.data.id
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = azurerm_user_assigned_identity.app.principal_id
}
`),
      ["entra-id -> object-storage: read"],
    );
  });

  it("adds the stand-in beside a drawn principal when the expression may be something else", () => {
    assert.deepEqual(
      edgesOf(`
resource "azurerm_role_assignment" "blob" {
  scope                = azurerm_storage_account.data.id
  role_definition_name = "Owner"
  principal_id         = var.use_group ? var.group : azurerm_user_assigned_identity.app.principal_id
}
`),
      ["entra-id -> object-storage: admin", "principal-azure -> object-storage: unscoped"],
    );
  });
});
