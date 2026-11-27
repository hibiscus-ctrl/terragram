// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, it } from "node:test";

import { modelToSvg } from "terragram-engine/diagram-svg";
import { explainModel } from "terragram-engine/explain";
import { parseHcl } from "terragram-engine/hcl";
import { ANY_RESOURCE_ID, readIam, runsAsAddresses } from "terragram-engine/iam";
import { type InfraModel, infraModelSchema } from "terragram-engine/model";
import { parseTerraform } from "terragram-engine/parse";

import { renderDiagram } from "../action/src/mermaid.ts";
import { diffModels } from "../action/src/model-diff.ts";
import { renderReport } from "../action/src/report.ts";

/**
 * Typed edges from Google Cloud IAM: a grant is read from the text of the \`google_*_iam_*\`
 * resources, the way AWS policies and Azure role assignments are, and ends as an edge from
 * the principal to what it is on. Nothing is evaluated and nothing from the file but a level
 * reaches the model: no role, no member, no condition.
 */

const fixture = (name: string) => new URL(`./fixtures/gcp/${name}`, import.meta.url);
const MAIN = readFileSync(fixture("main.tf"), "utf8");
const IAM = readFileSync(fixture("iam.tf"), "utf8");

function golden(name: string, actual: string): void {
  const path = fixture(`golden/${name}`);
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(dirname(path.pathname), { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  assert.equal(actual, readFileSync(path, "utf8"), `${name} differs from its golden; UPDATE_GOLDEN=1 rewrites it`);
}

function read(source: string) {
  const result = parseTerraform(source);
  assert.ok(result.ok, result.ok ? "" : result.error);
  return result;
}

/** `source -> target: access` for every typed edge, with `conditional` and the floor under it. */
function typed(model: InfraModel): string[] {
  return model.edges
    .filter((e) => e.access)
    .map((e) => `${e.source} -> ${e.target}: ${e.access}${e.conditional ? `, conditional${e.unconditional ? ` (${e.unconditional} unconditional)` : ""}` : ""}`);
}

/** A project, a service account, a bucket and a topic, to put grants on. */
const BASE = `
resource "google_project" "app" {
  name       = "App"
  project_id = "app"
}

resource "google_service_account" "api" {
  account_id = "api"
}

resource "google_storage_bucket" "data" {
  name = "data"
}

resource "google_pubsub_topic" "events" {
  name = "events"
}
`;

/** The edge a grant draws from the service account to \`target\`, as its access type, or undefined when it draws none. */
function accessOf(grant: string, target: string, source = "entra-id"): string | undefined {
  const model = read(BASE + grant).model;
  return model.edges.find((e) => e.source === source && e.target === target)?.access;
}

const member = (extra: string, member = '"serviceAccount:${google_service_account.api.email}"') => `
resource "google_project_iam_member" "grant" {
  project = google_project.app.project_id
  member  = ${member}
  ${extra}
}
`;

describe("typed edges from Google Cloud IAM", () => {
  const parsed = read(`${MAIN}\n${IAM}`);

  it("types what each identity may reach, and what a workload runs as", () => {
    assert.deepEqual(typed(parsed.model).sort(), [
      "containers -> entra-id: runs-as",
      "entra-id -> any-resource: unscoped",
      "entra-id -> data-warehouse: write".replace("entra-id", "entra-id-2"),
      "entra-id -> entra-id-2: runs-as",
      "entra-id -> key-vault: unscoped",
      "entra-id -> object-storage: admin",
      "entra-id -> queue: write",
      "entra-id-2 -> any-resource: write",
      "entra-id-2 -> key-vault: unscoped",
      "entra-id-2 -> object-storage: read",
      "entra-id-2 -> queue: unscoped",
      "functions -> entra-id-2: runs-as",
      "kubernetes -> entra-id-2: runs-as",
      "principal-all-users -> containers: unscoped",
      "principal-all-users -> static-site: read",
      "principal-group -> any-resource: read",
      "principal-user -> any-resource: admin, conditional (read unconditional)",
      "virtual-machine -> entra-id-2: runs-as",
      "entra-id-2 -> functions: unscoped",
    ].sort());
  });

  it("reads every grant of the fixture, so none is left as an untranslated block", () => {
    assert.deepEqual(parsed.untranslated, []);
  });

  it("is the same every time and a valid model", () => {
    assert.deepEqual(read(`${MAIN}\n${IAM}`), parsed);
    assert.equal(infraModelSchema.safeParse(parsed.model).success, true);
  });

  it("keeps nothing of the grants but their levels: no role, member, address or condition", () => {
    const json = JSON.stringify(parsed.model);
    for (const text of [
      "roles/",
      "alice",
      "engineering",
      "oncall",
      "@example.com",
      "serviceAccount:",
      "timestamp",
      "migration",
      "objectAdmin",
      "cloudsql",
    ]) {
      assert.equal(json.includes(text), false, text);
    }
  });

  it("describes the grants in plain English without the principals' addresses", () => {
    const small = read(`${BASE}
resource "google_storage_bucket_iam_member" "public" {
  bucket = google_storage_bucket.data.name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

resource "google_storage_bucket_iam_member" "admin" {
  bucket = google_storage_bucket.data.name
  role   = "roles/storage.admin"
  member = "user:alice@example.com"
}`).model;
    const text = explainModel(small, "gcp", "London (europe-west2)");
    assert.match(text, /Anyone on the internet \(allUsers\) can read Object Storage/);
    assert.match(text, /A person \(user\) has admin access to Object Storage/);
    assert.equal(text.includes("example.com"), false);
    assert.match(explainModel(parsed.model, "gcp", "London (europe-west2)"), /Containers runs as Managed Identity/);
  });

  it("draws, with goldens", () => {
    golden("access.svg", `${modelToSvg(parsed.model)}\n`);
    const diagram = renderDiagram(diffModels({ nodes: [], edges: [], topology: "derived" }, parsed.model));
    golden("access.mmd", `${diagram.mermaid}\n`);
    assert.match(modelToSvg(parsed.model), />conditional \(read unconditional\)|>admin, conditional \(read unconditional\)</);
  });

  it("lists the access it adds in the pull request comment, the widest first", () => {
    const before = read(MAIN).model;
    const diff = diffModels(before, parsed.model);
    const report = renderReport({
      mode: "check",
      modelPath: "diagram.json",
      terraformDir: "infra/",
      cloud: "gcp",
      base: { state: "compared" },
      diff,
      diagram: { mermaid: null, scope: "none" },
      warnings: [],
      terraformChanged: [],
      files: [],
      written: [],
      contentHash: "sha256:0",
      signed: false,
    });
    const section = report.split("#### Access changes")[1] ?? "";
    assert.ok(section.length > 0, report);
    const lines = section.split("\n").filter((line) => line.startsWith("- "));
    // The widest first: unscoped grants, then admin, and what is cut is the least dangerous.
    assert.match(lines[0] ?? "", /\*\*Added\*\* .* has unscoped access to /);
    const order = lines.map((line) => (line.includes("unscoped") ? 0 : line.includes("admin") ? 1 : 2));
    assert.deepEqual(order, [...order].sort());
    assert.ok(lines.some((line) => line.includes("Anyone on the internet &#40;allUsers&#41; has unscoped access to Containers")));
    assert.ok(lines.some((line) => line.includes("A person &#40;user&#41; has admin access to Any resource &#40;&#42;&#41; (conditional; read without the condition)")));
    for (const text of ["@example.com", "roles/", "serviceAccount:", "oncall"]) assert.equal(report.includes(text), false, text);
  });
});

describe("the level of a role", () => {
  const level = (role: string) => accessOf(member(`role = ${role}`), ANY_RESOURCE_ID);

  it("reads the basic roles: owner is admin, editor is write, viewer is read", () => {
    assert.equal(level('"roles/owner"'), "admin");
    assert.equal(level('"roles/editor"'), "write");
    assert.equal(level('"roles/viewer"'), "read");
  });

  it("reads a predefined role by the last word of its name where that is unambiguous", () => {
    for (const [role, access] of [
      ["roles/storage.admin", "admin"],
      ["roles/compute.networkAdmin", "admin"],
      ["roles/resourcemanager.projectIamAdmin", "admin"],
      ["roles/storage.objectViewer", "read"],
      ["roles/bigquery.dataViewer", "read"],
      ["roles/storage.legacyBucketReader", "read"],
      ["roles/logging.logWriter", "write"],
      ["roles/bigquery.dataEditor", "write"],
      ["roles/pubsub.publisher", "write"],
      ["roles/pubsub.viewer", "read"],
    ] as const) {
      assert.equal(level(`"${role}"`), access, role);
    }
  });

  it("types every other predefined role, a custom role and a role it cannot read as unscoped", () => {
    for (const role of [
      '"roles/secretmanager.secretAccessor"',
      '"roles/run.invoker"',
      '"roles/cloudsql.client"',
      '"roles/iam.securityReviewer"',
      '"roles/bigquery.dataOwner"',
      '"roles/storage.objectCreator"',
      '"projects/app/roles/custom"',
      '"organizations/1/roles/custom"',
      "google_project_iam_custom_role.x.id",
      "var.role",
      '"roles/${var.service}.admin"',
      '"roles/"',
      '"roles/owner "',
      '"roles/viewer\\n"',
      `"roles/${"a".repeat(300)}.admin"`,
    ]) {
      assert.equal(level(role), "unscoped", role);
    }
    // No role at all is not a role.
    assert.equal(accessOf(member(""), ANY_RESOURCE_ID), "unscoped");
  });

  it("types the roles that act as a service account as unscoped over a project, and as runs-as on one drawn service account", () => {
    for (const role of ["roles/iam.serviceAccountUser", "roles/iam.serviceAccountTokenCreator"]) {
      assert.equal(level(`"${role}"`), "unscoped", role);
      const on = `
resource "google_service_account" "other" {
  account_id = "other"
}

resource "google_service_account_iam_member" "grant" {
  service_account_id = google_service_account.other.name
  role               = "${role}"
  member             = "serviceAccount:\${google_service_account.api.email}"
}
`;
      assert.equal(accessOf(on, "entra-id-2"), "runs-as", role);
      assert.equal(accessOf(on, ANY_RESOURCE_ID), undefined, role);
    }
  });
});

describe("whose grant it is", () => {
  const sources = (members: string) =>
    read(`${BASE}
resource "google_project_iam_binding" "grant" {
  project = google_project.app.project_id
  role    = "roles/viewer"
  members = ${members}
}`)
      .model.edges.filter((e) => e.target === ANY_RESOURCE_ID)
      .map((e) => e.source)
      .sort();

  it("is the drawn service account a member refers to, by its email or its member attribute", () => {
    assert.deepEqual(sources('["serviceAccount:${google_service_account.api.email}"]'), ["entra-id"]);
    assert.deepEqual(sources("[google_service_account.api.member]"), ["entra-id"]);
    assert.deepEqual(sources("toset([google_service_account.api.member])"), ["entra-id"]);
    assert.deepEqual(sources("tolist([google_service_account.api.email])"), ["entra-id"]);
  });

  it("is one stand-in per kind of principal when it is not drawn, in fixed words and never the member's own text", () => {
    const model = read(`${BASE}
resource "google_project_iam_binding" "grant" {
  project = google_project.app.project_id
  role    = "roles/viewer"
  members = [
    "user:alice@example.com",
    "user:bob@example.com",
    "group:eng@example.com",
    "domain:example.com",
    "serviceAccount:ci@other.iam.gserviceaccount.com",
    "allUsers",
    "allAuthenticatedUsers",
    "principalSet://iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/*",
    "deleted:user:carol@example.com",
    var.admin,
  ]
}`).model;
    const stand = model.nodes.filter((n) => n.id.startsWith("principal-"));
    assert.deepEqual(
      stand.map((n) => [n.id, n.label]).sort(),
      [
        ["principal-all-authenticated-users", "Any Google account (allAuthenticatedUsers)"],
        ["principal-all-users", "Anyone on the internet (allUsers)"],
        ["principal-domain", "A whole domain"],
        ["principal-federated", "A federated identity"],
        ["principal-group", "A group"],
        ["principal-other", "Another principal"],
        ["principal-service-account", "A service account (not drawn)"],
        ["principal-user", "A person (user)"],
      ].sort(),
    );
    for (const n of stand) assert.deepEqual([n.category, n.kind, n.flag], ["edge", "external", null]);
    // Two people are one edge, and each stand-in is a grant at the level.
    assert.equal(model.edges.filter((e) => e.source === "principal-user").length, 1);
    assert.equal(JSON.stringify(model).includes("example.com"), false);
  });

  it("is capped: a thousand members are still a handful of nodes", () => {
    const members = Array.from({ length: 1000 }, (_, i) => `"user:u${i}@example.com"`).join(", ");
    const model = read(`${BASE}
resource "google_project_iam_binding" "grant" {
  role    = "roles/owner"
  members = [${members}]
}`).model;
    assert.deepEqual(model.nodes.filter((n) => n.id.startsWith("principal-")).map((n) => n.id).sort(), ["principal-other", "principal-user"]);
    assert.equal(model.edges.find((e) => e.source === "principal-other")?.access, "admin");
    assert.equal(model.edges.length < 10, true);
  });

  it("does not turn a service account's grant on itself into an edge", () => {
    const on = `${BASE}
resource "google_service_account_iam_member" "self" {
  service_account_id = google_service_account.api.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:\${google_service_account.api.email}"
}`;
    assert.equal(read(on).model.edges.some((e) => e.access && e.source === e.target), false);
  });
});

describe("what the grant is on", () => {
  const edges = (grant: string) => typed(read(BASE + grant).model);

  it("is the drawn resource its target attribute names, at the role's level", () => {
    assert.deepEqual(
      edges(`
resource "google_storage_bucket_iam_member" "g" {
  bucket = google_storage_bucket.data.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:\${google_service_account.api.email}"
}`),
      ["entra-id -> object-storage: read"],
    );
    assert.deepEqual(
      edges(`
resource "google_pubsub_topic_iam_binding" "g" {
  topic   = google_pubsub_topic.events.id
  role    = "roles/pubsub.editor"
  members = ["serviceAccount:\${google_service_account.api.email}"]
}`),
      ["entra-id -> queue: write"],
    );
  });

  it("reads the target out of a template, and any number of them", () => {
    assert.deepEqual(
      edges(`
resource "google_storage_bucket_iam_member" "g" {
  bucket = "\${var.prefix}-\${google_storage_bucket.data.name}"
  role   = "roles/storage.admin"
  member = "user:alice@example.com"
}`),
      ["principal-user -> object-storage: admin"],
    );
  });

  it("is unscoped over any resource when the target is a name, a variable or a module it cannot pin down", () => {
    for (const bucket of ['"my-bucket"', "var.bucket", "local.bucket", "module.storage.name", "data.google_storage_bucket.b.name"]) {
      assert.deepEqual(
        edges(`
resource "google_storage_bucket_iam_member" "g" {
  bucket = ${bucket}
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:\${google_service_account.api.email}"
}`),
        ["entra-id -> any-resource: unscoped"],
        bucket,
      );
    }
  });

  it("adds nothing for a resource the picture does not draw, and leaves its block untranslated", () => {
    const result = read(`${BASE}
resource "google_storage_bucket_iam_member" "elsewhere" {
  bucket = google_storage_bucket.not_drawn.name
  role   = "roles/storage.admin"
  member = "serviceAccount:\${google_service_account.api.email}"
}`);
    assert.deepEqual(typed(result.model), []);
    assert.ok(result.untranslated.includes("google_storage_bucket_iam_member.elsewhere"));
  });

  it("reads a type it has no target attribute for by what its attributes point at", () => {
    const model = `${BASE}
resource "google_compute_instance" "vm" {
  name = "vm"
}
`;
    assert.deepEqual(
      typed(
        read(`${model}
resource "google_compute_instance_iam_member" "g" {
  instance_name = google_compute_instance.vm.name
  zone          = "europe-west2-a"
  role          = "roles/compute.viewer"
  member        = "serviceAccount:\${google_service_account.api.email}"
}`).model,
      ),
      ["entra-id -> virtual-machine: read"],
    );
    assert.deepEqual(
      typed(
        read(`${model}
resource "google_compute_instance_iam_member" "g" {
  instance_name = var.instance
  zone          = "europe-west2-a"
  role          = "roles/compute.viewer"
  member        = "serviceAccount:\${google_service_account.api.email}"
}`).model,
      ),
      ["entra-id -> any-resource: unscoped"],
    );
  });

  it("ends a project, folder, organisation or billing account grant at any resource, at the role's level", () => {
    for (const scope of ["project", "folder", "organization", "billing_account"]) {
      assert.deepEqual(
        edges(`
resource "google_${scope}_iam_member" "g" {
  role   = "roles/editor"
  member = "serviceAccount:\${google_service_account.api.email}"
}`),
        ["entra-id -> any-resource: write"],
        scope,
      );
    }
  });
});

describe("authoritative grants never understate", () => {
  it("draws a project binding's roles over any resource", () => {
    assert.deepEqual(
      typed(
        read(`${BASE}
resource "google_project_iam_binding" "g" {
  project = google_project.app.project_id
  role    = "roles/editor"
  members = ["serviceAccount:\${google_service_account.api.email}", "group:eng@example.com"]
}`).model,
      ),
      ["entra-id -> any-resource: write", "principal-group -> any-resource: write"],
    );
  });

  it("reads the bindings of the policy document an authoritative policy names, over any resource for a project", () => {
    const result = read(`${BASE}
data "google_iam_policy" "project" {
  binding {
    role    = "roles/owner"
    members = ["serviceAccount:\${google_service_account.api.email}"]
  }
  binding {
    role    = "roles/viewer"
    members = ["group:eng@example.com"]

    condition {
      title      = "business hours"
      expression = "request.time.getHours(\\"UTC\\") < 18"
    }
  }
}

resource "google_project_iam_policy" "authoritative" {
  project     = google_project.app.project_id
  policy_data = data.google_iam_policy.project.policy_data
}`);
    assert.deepEqual(typed(result.model), [
      "entra-id -> any-resource: admin",
      "principal-group -> any-resource: read, conditional",
    ]);
    assert.deepEqual(result.untranslated, []);
  });

  it("reads a resource-level policy over the resource, and an unreadable policy as unscoped from a principal it cannot name", () => {
    const readable = read(`${BASE}
data "google_iam_policy" "bucket" {
  binding {
    role    = "roles/storage.objectAdmin"
    members = ["serviceAccount:\${google_service_account.api.email}"]
  }
}

resource "google_storage_bucket_iam_policy" "p" {
  bucket      = google_storage_bucket.data.name
  policy_data = data.google_iam_policy.bucket.policy_data
}`);
    assert.deepEqual(typed(readable.model), ["entra-id -> object-storage: admin"]);

    for (const policy of ["var.policy", "file(\"policy.json\")", "data.google_iam_policy.missing.policy_data", "data.google_iam_policy.other.json"]) {
      const result = read(`${BASE}
resource "google_project_iam_policy" "p" {
  project     = google_project.app.project_id
  policy_data = ${policy}
}`);
      assert.deepEqual(typed(result.model), ["principal-other -> any-resource: unscoped"], policy);
    }
  });

  it("does not lose a policy document it half understands", () => {
    const result = read(`${BASE}
data "google_iam_policy" "project" {
  binding {
    role    = "roles/viewer"
    members = ["group:eng@example.com"]
  }
  dynamic "binding" {
    for_each = var.bindings
    content {
      role    = binding.value.role
      members = binding.value.members
    }
  }
}

resource "google_project_iam_policy" "p" {
  policy_data = data.google_iam_policy.project.policy_data
}`);
    assert.deepEqual(typed(result.model), ["principal-group -> any-resource: read", "principal-other -> any-resource: unscoped"]);
  });
});

describe("conditions", () => {
  const edge = (condition: string) =>
    typed(
      read(`${BASE}
resource "google_project_iam_member" "g" {
  role   = "roles/editor"
  member = "serviceAccount:\${google_service_account.api.email}"
${condition}
}`).model,
    );

  it("marks a grant behind a real condition conditional, without lowering it", () => {
    assert.deepEqual(
      edge('  condition {\n    title      = "t"\n    expression = "resource.name.startsWith(\\"projects/_/buckets/x\\")"\n  }'),
      ["entra-id -> any-resource: write, conditional"],
    );
    assert.deepEqual(
      edge('  condition {\n    title      = "t"\n    expression = <<-EOT\n      request.time < timestamp("2027-01-01T00:00:00Z")\n    EOT\n  }'),
      ["entra-id -> any-resource: write, conditional"],
    );
  });

  it("does not count one that is always true, empty, missing its expression or a value it cannot see", () => {
    for (const condition of [
      '  condition {\n    title      = "t"\n    expression = "true"\n  }',
      '  condition {\n    title      = "t"\n    expression = " TRUE "\n  }',
      '  condition {\n    title      = "t"\n    expression = ""\n  }',
      '  condition {\n    title = "t"\n  }',
      '  condition {\n    title      = "t"\n    expression = var.expression\n  }',
      '  condition {\n    title      = "t"\n    expression = "${var.expression}"\n  }',
      '  dynamic "condition" {\n    for_each = var.conditions\n    content {\n      expression = "x"\n    }\n  }',
      "",
    ]) {
      assert.deepEqual(edge(condition), ["entra-id -> any-resource: write"], condition);
    }
  });

  it("is conditional only when every grant at the strongest level is, and shows the level under it", () => {
    const two = (unconditionalRole: string) =>
      typed(
        read(`${BASE}
resource "google_project_iam_member" "a" {
  role   = "roles/owner"
  member = "serviceAccount:\${google_service_account.api.email}"
  condition {
    title      = "t"
    expression = "request.time < timestamp(\\"2027-01-01T00:00:00Z\\")"
  }
}

resource "google_project_iam_member" "b" {
  role   = "${unconditionalRole}"
  member = "serviceAccount:\${google_service_account.api.email}"
}`).model,
      );
    assert.deepEqual(two("roles/editor"), ["entra-id -> any-resource: admin, conditional (write unconditional)"]);
    assert.deepEqual(two("roles/owner"), ["entra-id -> any-resource: admin"]);
  });

  it("keeps the condition's text out of the model", () => {
    const json = JSON.stringify(
      read(`${BASE}
resource "google_project_iam_member" "g" {
  role   = "roles/editor"
  member = "serviceAccount:\${google_service_account.api.email}"
  condition {
    title       = "secret-title"
    description = "secret-description"
    expression  = "resource.name == 'secret-resource'"
  }
}`).model,
    );
    for (const text of ["secret-title", "secret-description", "secret-resource", "resource.name"]) assert.equal(json.includes(text), false, text);
  });
});

describe("what a workload runs as", () => {
  const runs = (workload: string) => typed(read(`${BASE}\n${workload}`).model).filter((e) => e.endsWith("runs-as"));

  it("is the service account in its service_account, service_account_email or email attribute, or its service_account block", () => {
    assert.deepEqual(
      runs(`
resource "google_cloud_run_v2_service" "svc" {
  name = "svc"
  template {
    service_account = google_service_account.api.email
  }
}`),
      ["containers -> entra-id: runs-as"],
    );
    assert.deepEqual(
      runs(`
resource "google_cloudfunctions2_function" "fn" {
  name = "fn"
  service_config {
    service_account_email = google_service_account.api.email
  }
}`),
      ["functions -> entra-id: runs-as"],
    );
    assert.deepEqual(
      runs(`
resource "google_compute_instance" "vm" {
  name = "vm"
  service_account {
    email  = google_service_account.api.email
    scopes = ["cloud-platform"]
  }
}`),
      ["virtual-machine -> entra-id: runs-as"],
    );
    assert.deepEqual(
      runs(`
resource "google_container_cluster" "gke" {
  name = "gke"
}

resource "google_container_node_pool" "pool" {
  cluster = google_container_cluster.gke.id
  node_config {
    service_account = google_service_account.api.email
  }
}`),
      ["kubernetes -> entra-id: runs-as"],
    );
  });

  it("is nothing for a service account that is a variable, or an email attribute outside a service_account block", () => {
    assert.deepEqual(
      runs(`
resource "google_cloud_run_v2_service" "svc" {
  name = "svc"
  template {
    service_account = var.service_account
  }
}

resource "google_pubsub_topic" "t" {
  name = "t"
  labels = {
    email = google_service_account.api.email
  }
}`),
      [],
    );
  });

  it("finds the addresses the way the AWS and Azure ones are found", () => {
    const blocks = parseHcl(`
resource "google_compute_instance" "vm" {
  service_account {
    email = google_service_account.api.email
  }
}`);
    assert.deepEqual(runsAsAddresses(blocks, blocks), ["google_service_account.api"]);
  });
});

describe("hostile Google Cloud IAM", () => {
  it("reads a very large file of grants in bounded time, with an unscoped grant standing for what it did not read", () => {
    const grants = Array.from(
      { length: 2500 },
      (_, i) => `
resource "google_project_iam_member" "g${i}" {
  role   = "roles/viewer"
  member = "user:u${i}@example.com"
}`,
    ).join("\n");
    const started = Date.now();
    const model = read(BASE + grants).model;
    assert.ok(Date.now() - started < 5000);
    assert.equal(model.edges.some((e) => e.source === "principal-other" && e.access === "unscoped"), true);
    assert.equal(model.nodes.length < 20, true);
  });

  it("draws no more than a bounded number of edges from grants, and says there was more with an unscoped one", () => {
    const accounts = Array.from({ length: 70 }, (_, i) => `resource "google_service_account" "a${i}" { account_id = "a${i}" }`).join("\n");
    const buckets = Array.from({ length: 70 }, (_, i) => `resource "google_storage_bucket" "b${i}" { name = "b${i}" }`).join("\n");
    const members = Array.from({ length: 70 }, (_, i) => `google_service_account.a${i}.member`).join(", ");
    const grants = Array.from(
      { length: 70 },
      (_, i) => `resource "google_storage_bucket_iam_binding" "g${i}" {
  bucket  = google_storage_bucket.b${i}.name
  role    = "roles/storage.admin"
  members = [${members}]
}`,
    ).join("\n");
    const model = read(`${accounts}\n${buckets}\n${grants}`).model;
    const typedEdges = model.edges.filter((e) => e.access);
    assert.equal(typedEdges.length <= 2001 + 70, true, String(typedEdges.length));
    assert.equal(typedEdges.some((e) => e.source === "principal-other" && e.target === ANY_RESOURCE_ID && e.access === "unscoped"), true);
  });

  it("reads long and malformed role, member and condition text without a pattern running away", () => {
    const long = "a".repeat(100_000);
    const started = Date.now();
    const model = read(`${BASE}
resource "google_project_iam_member" "g" {
  role   = "roles/${long}"
  member = "${long}:${long}"
  condition {
    title      = "t"
    expression = "${long}"
  }
}

resource "google_project_iam_member" "h" {
  role   = "roles/x.${"A".repeat(150)}!"
  member = "serviceAccount:\${${"{".repeat(70)}"
}`).model;
    assert.ok(Date.now() - started < 3000);
    assert.equal(model.edges.every((e) => !e.access || e.access === "unscoped" || e.access === "write" || e.access === "read" || e.access === "admin"), true);
  });

  it("gives up on deeply nested members as another principal, not a crash", () => {
    const nested = `${"[".repeat(5000)}"user:a@example.com"${"]".repeat(5000)}`;
    const model = read(`${BASE}
resource "google_project_iam_binding" "g" {
  role    = "roles/viewer"
  members = ${nested}
}`).model;
    assert.deepEqual(typed(model), ["principal-other -> any-resource: read"]);
  });

  it("falls back to an unscoped grant when the reader itself throws", () => {
    const blocks = parseHcl(`
resource "google_project_iam_member" "g" {
  role   = "roles/viewer"
  member = "user:a@example.com"
}`);
    const hostile = blocks.map((b) => ({ ...b, get attributes(): never { throw new Error("hostile"); } }));
    const reading = readIam(hostile as typeof blocks, () => undefined, "gcp");
    assert.deepEqual(reading.edges.map((e) => `${e.source} -> ${e.target}: ${e.access}`), ["principal-other -> any-resource: unscoped"]);
  });
});

describe("Google Cloud grants beside the other clouds'", () => {
  it("reads the grants of a Google Cloud resource in a file that is mostly AWS, and an AWS policy in one that is mostly Google Cloud", () => {
    const aws = `
resource "aws_s3_bucket" "data" {
  bucket = "x"
}

resource "aws_iam_role" "fn" {
  name = "fn"
  assume_role_policy = "{}"
}

resource "aws_iam_role_policy" "p" {
  role   = aws_iam_role.fn.id
  policy = jsonencode({ Statement = [{ Effect = "Allow", Action = "s3:GetObject", Resource = aws_s3_bucket.data.arn }] })
}

resource "aws_sqs_queue" "q" {
  name = "q"
}
`;
    const google = `
resource "google_service_account" "api" {
  account_id = "api"
}

resource "google_project_iam_member" "g" {
  role   = "roles/viewer"
  member = "serviceAccount:\${google_service_account.api.email}"
}
`;
    for (const source of [aws + google, google + aws]) {
      const edges = typed(read(source).model);
      // The Google Cloud grant on the project, and the AWS policy on the bucket, whichever cloud the file goes to.
      assert.equal(edges.filter((e) => e.endsWith("-> any-resource: read")).length, 1, edges.join("\n"));
      assert.equal(edges.filter((e) => e.endsWith("-> object-storage: read")).length, 1, edges.join("\n"));
    }
  });
});
