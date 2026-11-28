// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What the Google Cloud sandbox workflow (`.github/workflows/sandbox-google.yml`) changes in the plans of
 * `scripts/emit-plans.ts` before it applies them to a real project, and nothing else.
 *
 * The plans are what the emit gate validates, so they are written for a project of their own: they create it,
 * protect their databases from deletion and use an App Engine application, which a project has once and
 * which no one deletes. A sandbox project is shared and the plans are applied and destroyed in it on every
 * run, so each of those is changed here, on the generated text, by name. Every change must find exactly
 * what it expects: a generator that writes something else fails here, loudly, rather than applying a plan
 * nobody reviewed. Nothing here touches what the plans build apart from the list in `SANDBOX_ADAPTATIONS`,
 * which the workflow's summary and the pull request that adds it spell out.
 */
export type PlanFile = { name: string; content: string };

/** The adaptations of one plan, for the workflow's summary and for a reviewer: what is left out or changed, and why. */
export const SANDBOX_ADAPTATIONS: Readonly<Record<string, readonly string[]>> = {
  "gcp-data": [
    "No App Engine: an application is created once per project, for good, and its default service keeps the version, so a second run would fail. Its load balancer backend (a serverless network endpoint group and a backend service) goes with it, and the URL map redirects, as it does for a front door with no target.",
    "Cloud SQL instances are not protected from deletion (deletion_protection, deletion_protection_enabled), so the run can destroy them.",
    "The private service connection is deleted for real (deletion_policy ABANDON is dropped), so the network it peers can be deleted too.",
    "The network and subnetwork come from a small root of the workflow's own, as the plan takes them as variables.",
  ],
  "gcp-platform": [
    "No project: the plan creates the project it builds in, which a sandbox project cannot (that takes an organisation and a billing account). It builds in the sandbox project, and its project number output and the organisation and billing account variables go.",
    "No project-wide audit configuration (allServices): it is the shared project's policy, which no run should replace or remove.",
  ],
  "gcp-site": [],
  "gcp-serverless": [],
};

/** A change that did not find what it expects to change. */
export class AdaptationError extends Error {}

function once(text: string, needle: string, what: string): { index: number; 0: string } {
  const index = text.indexOf(needle);
  const count = index === -1 ? 0 : text.indexOf(needle, index + 1) === -1 ? 1 : 2;
  if (count !== 1) throw new AdaptationError(`${what}: expected exactly one match, found ${count === 2 ? "more than one" : 0}`);
  return { index, 0: needle };
}

/** Remove one top-level block (`resource "type" "name" {` to its closing brace in column 0), and the blank line after it. */
export function dropBlock(text: string, kind: "resource" | "variable" | "output" | "data", labels: readonly string[]): string {
  const header = `${kind} ${labels.map((l) => `"${l}"`).join(" ")} {\n`;
  const at = once(`\n${text}`, `\n${header}`, `block ${kind} ${labels.join(".")}`).index;
  const close = text.indexOf("\n}\n", at);
  if (close === -1) throw new AdaptationError(`block ${kind} ${labels.join(".")} has no closing brace`);
  const end = close + 3;
  return text.slice(0, at) + text.slice(text[end] === "\n" ? end + 1 : end);
}

/** Replace the single place a text is written. */
export function replaceOnce(text: string, from: string, to: string, what: string): string {
  const m = once(text, from, what);
  return text.slice(0, m.index) + to + text.slice(m.index + m[0].length);
}

/** Replace a text that must be written exactly `count` times. */
function replaceTimes(text: string, from: string, to: string, count: number, what: string): string {
  const parts = text.split(from);
  if (parts.length - 1 !== count) throw new AdaptationError(`${what}: expected ${count} matches, found ${parts.length - 1}`);
  return parts.join(to);
}

/** Remove the single line that matches. `line` is a literal pattern with the `g` and `m` flags that matches a whole line and its newline. */
function dropLine(text: string, line: RegExp, what: string): string {
  if (!line.global || !line.multiline) throw new AdaptationError(`${what}: the pattern needs the g and m flags`);
  const found = [...text.matchAll(line)];
  if (found.length !== 1) throw new AdaptationError(`${what}: expected exactly one match, found ${found.length}`);
  const m = found[0] as RegExpExecArray;
  return text.slice(0, m.index) + text.slice(m.index + m[0].length);
}

function adaptData(files: Map<string, string>): void {
  let main = files.get("main.tf") ?? "";
  for (const name of ["google_app_engine_standard_app_version", "google_app_engine_application", "google_app_engine_service_network_settings"]) {
    main = dropBlock(main, "resource", [name, "app_service"]);
  }
  for (const name of ["google_compute_region_network_endpoint_group", "google_compute_backend_service"]) {
    main = dropBlock(main, "resource", [name, "front_door_to_app_service"]);
  }
  main = replaceOnce(
    main,
    `  name            = "cdn-\${var.name_prefix}-front-door"
  default_service = google_compute_backend_service.front_door_to_app_service.id
  depends_on      = [google_project_service.enabled]
`,
    `  name       = "cdn-\${var.name_prefix}-front-door"
  depends_on = [google_project_service.enabled]

  default_url_redirect {
    host_redirect          = "example.com"
    https_redirect         = true
    strip_query            = false
    redirect_response_code = "TEMPORARY_REDIRECT"
  }
`,
    "the URL map's default service",
  );
  main = replaceTimes(main, "  deletion_protection = true\n", "  deletion_protection = false\n", 2, "the Cloud SQL instances' deletion protection");
  main = replaceTimes(main, "    deletion_protection_enabled = true\n", "    deletion_protection_enabled = false\n", 2, "the Cloud SQL instances' settings");
  main = dropLine(main, /^[ \t]*deletion_policy[ \t]*=[ \t]*"ABANDON"\n/gm, "the private service connection's deletion policy");
  if (main.includes("google_app_engine")) throw new AdaptationError("App Engine is still referenced after it was left out");
  files.set("main.tf", main);
  files.set("outputs.tf", dropBlock(files.get("outputs.tf") ?? "", "output", ["app_service_hostname"]));
}

function adaptPlatform(files: Map<string, string>): void {
  let main = files.get("main.tf") ?? "";
  main = dropBlock(main, "resource", ["google_project", "project"]);
  main = dropBlock(main, "resource", ["google_project_iam_audit_config", "project"]);
  main = replaceOnce(main, "google_project.project, ", "", "the cluster's dependency on the project");
  main = replaceOnce(main, "google_project.project.project_id", "var.project_id", "the API switches' project");
  if (main.includes("google_project.")) throw new AdaptationError("the project is still referenced after it was left out");
  files.set("main.tf", main);
  files.set("outputs.tf", dropBlock(files.get("outputs.tf") ?? "", "output", ["project_number"]));
  let variables = files.get("variables.tf") ?? "";
  variables = dropBlock(variables, "variable", ["billing_account"]);
  variables = dropBlock(variables, "variable", ["org_id"]);
  files.set("variables.tf", variables);
}

/** The generated files of one plan, changed for a sandbox project (see the header). Throws `AdaptationError` if a change finds nothing, or something else, to change. */
export function adaptForSandbox(planId: string, generated: readonly PlanFile[]): PlanFile[] {
  if (!(planId in SANDBOX_ADAPTATIONS)) throw new AdaptationError(`unknown plan ${planId}`);
  const files = new Map(generated.map((f) => [f.name, f.content]));
  if (planId === "gcp-data") adaptData(files);
  if (planId === "gcp-platform") adaptPlatform(files);
  return [...files].map(([name, content]) => ({ name, content }));
}
