// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Prove the emitter's output is Terraform the real toolchain accepts.
 *
 * Runs a fixed set of briefs and every template through the deterministic engine,
 * emits each for both clouds, writes the files to a scratch directory and puts
 * them through the same tools `infraweaver-action` scans a customer's repo with:
 *
 *   terraform fmt -check   canonical formatting — the emitter writes HCL a human
 *                          reads and commits, so "fmt would change it" is a defect
 *   terraform init         -backend=false, so validate has provider AND module
 *                          schemas to check against (without it validate is inert)
 *   terraform validate     provider + module schema, argument names, types
 *   tflint                 provider-aware lint: deprecated arguments, bad enums
 *   trivy config           misconfiguration scan over the generated plan
 *   checkov                policy scan over the generated plan
 *   infraweaver assess     Infraweaver's own scorecard — the native rules plus the
 *                          Cyber Essentials / NCSC crosswalk — over every document
 *                          at once, the way it would score a customer's repo
 *
 * The scanners are OPTIONAL to have and BLOCKING once they run. Each resolves
 * three ways in order: the native binary, else a digest-pinned container via
 * docker, else skipped. A gate that fails because a tool is absent teaches people
 * to ignore it, so a tool that cannot be resolved is reported with its reason and
 * never fails the run. A tool that runs ends one of three ways, and the gate
 * tells them apart:
 *
 *   clean      nothing to report
 *   findings   the scanner judged the plan and something failed — the document
 *              fails, with the findings printed
 *   crash      the scanner did not judge the plan at all (a bad flag, an
 *              unparseable document, a dead daemon) — the document fails, with
 *              the tool's own output, marked as a crash so it is never read as a
 *              verdict either way
 *
 * The two policy scanners judge what the plan deploys. trivy evaluates every
 * module call through to the resources the module creates with the inputs the
 * plan passes, so a weak input — an open listener, a database without deletion
 * protection — is a finding in the plan even though the resource that shows it
 * lives in the module's code. It still skips the vendored `.terraform` tree as a
 * scan root (Dockerfiles, examples, tests): only what the plan calls is judged.
 * checkov never downloads modules and judges the plan's own HCL. Their exceptions
 * are a REVIEWED skip-list (`scanner-skips.ts`): every entry carries the reason
 * it was accepted, only listed ids are passed to the tools, and the list is
 * printed with every run.
 *
 *   npm run validate:emit            # native binaries if present, else docker
 *   npm run validate:emit -- --keep  # leave the scratch dirs for inspection
 *
 * The route each scanner took is printed in the summary, so "0 findings" can
 * always be told apart from "never ran".
 *
 * This is a release gate, not a unit test: `init` reaches the registry for
 * providers and modules, so it needs the network and a `terraform` (or `tofu`)
 * binary. Exit code is the number of documents that failed.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { errorMessage } from "@infraweaver-io/core/errors";
import { retry } from "@infraweaver-io/core/retry";
import { spawn } from "@infraweaver-io/sandbox/subprocess";

import { composeFromPrompt } from "../src/features/workspace/engine.ts";
import { type Cloud, CLOUDS, type InfraModel } from "../src/features/workspace/model.ts";
import { emitTerraform } from "../src/features/workspace/terraform.ts";
import { templateModel, WORKSPACE_TEMPLATES } from "../src/features/workspace/templates.ts";
import { SCANNER_SKIPS, skipsFor } from "./scanner-skips.ts";

const BRIEFS = [
  "create the infrastructure which allows me to deploy a lambda to AWS, powered by Python",
  "A web app with a Postgres database and Redis cache",
  "A containerised API behind a load balancer with a queue, MySQL and monitoring",
  "A static site on a CDN with its own DNS zone and object storage",
  "Serverless functions with a queue, a NoSQL store, identity and a secret store, in a private network",
  "A containerised API behind a load balancer with a cache and a Postgres database, in a private network",
];

const keep = process.argv.includes("--keep");
const terraformBin = process.env.TERRAFORM_BIN ?? "terraform";

/** Every timeout is explicit: `@infraweaver-io/sandbox` kills the process GROUP,
 *  so a `terraform init` wedged on a registry fetch cannot hang the gate. */
const INIT_TIMEOUT_MS = 180_000;
const TOOL_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 20_000;
/** one assess over every document; each is already initialised. */
const ASSESS_TIMEOUT_MS = 600_000;
/** a cold pull of the checkov image is the slow one, and it happens once. */
const PULL_TIMEOUT_MS = 600_000;

/**
 * One provider download for the whole run instead of one per document.
 *
 * Twenty documents each pull the same providers, and the Azure ones now pull five
 * (the Verified Modules bring `azapi`, `modtm`, `random` and `time` with them).
 * Terraform's own plugin cache makes that a single fetch — a large cut in both
 * wall-clock and load on the registry, which is also what makes the retry above
 * a rare path rather than a regular one. The directory has to exist before
 * Terraform will use it, and a run that cannot create one simply goes without.
 */
const pluginCache = process.env.TF_PLUGIN_CACHE_DIR ?? join(tmpdir(), "terragram-plugin-cache");
try {
  mkdirSync(pluginCache, { recursive: true });
} catch {
  /* no cache, just a slower run */
}

type Outcome = { ok: boolean; missing: boolean; detail: string };

/** "The tool is not installed" — a skip, never a failure. `spawn` reports it as a
 *  non-zero result rather than a throw, so both paths are checked. */
function looksMissing(text: string): boolean {
  return /ENOENT|not recognized|command not found|No such file or directory/i.test(text);
}

async function run(cmd: string, args: string[], cwd: string, timeout: number): Promise<Outcome> {
  try {
    const result = await spawn({
      cmd,
      args,
      cwd,
      timeout,
      // Process-group kill is what makes the timeouts real, but it is POSIX-only:
      // on Windows the sandbox can only spawn `detached`, which gives every
      // terraform child its own console window and kills nothing extra.
      killGroup: process.platform !== "win32",
      env: {
        ...process.env,
        TF_IN_AUTOMATION: "1",
        TF_PLUGIN_CACHE_DIR: pluginCache,
        CHECKOV_DISABLE_TELEMETRY: "true",
      },
    });
    const detail = `${result.stdout}\n${result.stderr}`.trim();
    if (result.exitCode === 0) return { ok: true, missing: false, detail };
    const missing = looksMissing(detail);
    return { ok: missing, missing, detail };
  } catch (error) {
    const message = errorMessage(error);
    const missing = looksMissing(message);
    return { ok: missing, missing, detail: message };
  }
}

/**
 * An optional scanner, resolved three ways in order: the native binary if this
 * machine has it, else a digest-pinned container, else skipped.
 *
 * The container route is what makes these tools actually run. None of the three
 * is installed here or on the CI runner, so until now every gate run reported
 * all three as skipped and the checks they cover were never performed at all.
 *
 * Images are VERSION+DIGEST-PINNED the way `infraweaver-action` pins
 * terraform-mcp-server: the tag is for humans, the `@sha256:` is the
 * authoritative pin, so a re-tagged upstream cannot be substituted. Bump both
 * halves together, resolving the new digest with
 * `docker buildx imagetools inspect <image>:<tag>`.
 */
type Optional = {
  id: string;
  cmd: string;
  /** The tool's arguments for one document. Paths are the host's on the native
   *  route and the container's on the docker one; cwd is the document either way. */
  args: (target: ScanTarget) => string[];
  image: string;
  /** How a finished run ended — see the header. Only "clean" passes. */
  verdict: (exitCode: number, output: string) => Verdict;
};

type Verdict = "clean" | "findings" | "crash";
type ScanTarget = { dir: string; trivyIgnore: string; checkovSkips: string[] };

/** where a document, and its trivy ignore file, are mounted inside a container. */
const MOUNT = "/plan";
const IGNORE_MOUNT = "/trivyignore";

/**
 * trivy exits 1 for its own fatal errors, so findings are given a code of their
 * own — otherwise an unknown flag and a misconfiguration look identical.
 */
const TRIVY_FINDINGS_EXIT = 2;

/**
 * trivy fetches its rules at run time. Pinned like the images, so a rule added
 * upstream cannot turn the gate red between two identical commits; bump it with
 * the image.
 */
const TRIVY_CHECKS =
  "mirror.gcr.io/aquasec/trivy-checks:2@sha256:1583562f8b90ed2a071b99f0e5ffff6b57e4ceb6ca3e4796577b4e6a339eb74c";

const OPTIONAL_TOOLS: Optional[] = [
  {
    id: "tflint",
    cmd: "tflint",
    args: () => ["--no-color", "--force"],
    image:
      "ghcr.io/terraform-linters/tflint:v0.64.0@sha256:1c595f42d794c32c45a6ea8b58655fd66433d4ca3b1bc631c574a48d120bd19f",
    // `--force` keeps issues at exit 0, so anything else is tflint failing to run.
    verdict: (code) => (code === 0 ? "clean" : "crash"),
  },
  {
    id: "trivy",
    cmd: "trivy",
    args: (t) => [
      "config",
      "--quiet",
      "--disable-telemetry",
      "--skip-version-check",
      "--exit-code", String(TRIVY_FINDINGS_EXIT),
      "--checks-bundle-repository", TRIVY_CHECKS,
      // `init` vendored the modules under .terraform — Dockerfiles, examples and
      // all. Skipping the tree as a scan root keeps those out; the modules the
      // plan calls are still evaluated through the call, and what they create
      // with the plan's inputs is judged like the plan's own resources.
      "--skip-dirs", "**/.terraform",
      "--ignorefile", t.trivyIgnore,
      t.dir,
    ],
    image: "aquasec/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969",
    verdict: (code) => (code === 0 ? "clean" : code === TRIVY_FINDINGS_EXIT ? "findings" : "crash"),
  },
  {
    id: "checkov",
    cmd: "checkov",
    args: (t) => [
      "-d", t.dir,
      "--quiet",
      "--compact",
      "--framework", "terraform",
      ...(t.checkovSkips.length > 0 ? ["--skip-check", t.checkovSkips.join(",")] : []),
    ],
    image: "bridgecrew/checkov:3.3.17@sha256:41c4701c6a56d8952e5aba7a420f871c8b70b57da94eb4f142dcdf7295bb0be3",
    // checkov exits 1 for failed checks AND for an uncaught error; only a scan
    // that reports failed checks is findings.
    verdict: (code, output) =>
      code === 0 ? "clean" : code === 1 && /Failed checks: [1-9]/.test(output) ? "findings" : "crash",
  },
];

/** How one optional tool will be run for every document in this run. Takes the
 *  HOST paths; the docker route maps them to its mounts. */
type Route = { cmd: string; args: (target: ScanTarget) => string[]; via: "native" | "docker" };

const routes = new Map<string, Route>();

/** Is this command runnable at all? `run` reports an absent binary as `missing`
 *  whether the spawn throws or exits non-zero, so both paths are covered. */
async function runnable(cmd: string, args: string[]): Promise<boolean> {
  return !(await run(cmd, args, process.cwd(), PROBE_TIMEOUT_MS)).missing;
}

/**
 * Pick each tool's route ONCE, before any document runs: probing per document
 * would spawn the same absent binary three times per case, and a cold `docker
 * pull` inside the first document would blow TOOL_TIMEOUT_MS and be reported as
 * a scanner finding rather than as what it is.
 *
 * A pull that fails (rate limit, no network, private registry) skips that tool
 * with its reason. A gate that goes red because an image could not be fetched
 * teaches people to ignore it, which is the same reason the tools are optional.
 */
async function resolveRoutes(): Promise<void> {
  const haveDocker = await runnable("docker", ["--version"]);

  for (const tool of OPTIONAL_TOOLS) {
    if (await runnable(tool.cmd, ["--version"])) {
      routes.set(tool.id, { cmd: tool.cmd, args: tool.args, via: "native" });
      continue;
    }
    if (!haveDocker) {
      skipped.set(tool.id, "no binary, no docker");
      continue;
    }
    const pull = await run("docker", ["pull", "--quiet", tool.image], process.cwd(), PULL_TIMEOUT_MS);
    if (!pull.ok || pull.missing) {
      skipped.set(tool.id, `docker pull failed: ${pull.detail.split("\n").pop() ?? "unknown"}`);
      continue;
    }
    routes.set(tool.id, {
      cmd: "docker",
      // Read-only mounts: these three read HCL and write nothing, and the
      // document is the artefact under test — a scanner must not edit it.
      args: (t) => [
        "run", "--rm",
        "-v", `${t.dir}:${MOUNT}:ro`,
        "-v", `${t.trivyIgnore}:${IGNORE_MOUNT}:ro`,
        "-w", MOUNT,
        tool.image,
        ...tool.args({ ...t, dir: MOUNT, trivyIgnore: IGNORE_MOUNT }),
      ],
      via: "docker",
    });
  }
}

/** A finished scanner run: its exit code and everything it printed. */
type Scan = { code: number; detail: string; vanished: boolean };

/**
 * Run one scanner over one document. Unlike `run`, the exit code is kept —
 * it is what separates findings from a crash — and "missing" is only the spawn
 * itself failing to find the binary. A crash that happens to print "No such file
 * or directory" is still a crash, never a quiet skip.
 */
async function scan(route: Route, target: ScanTarget): Promise<Scan> {
  try {
    const result = await spawn({
      cmd: route.cmd,
      args: route.args(target),
      cwd: target.dir,
      timeout: TOOL_TIMEOUT_MS,
      killGroup: process.platform !== "win32",
      env: { ...process.env, CHECKOV_DISABLE_TELEMETRY: "true" },
    });
    const detail = `${result.stdout}\n${result.stderr}`.trim();
    return { code: result.exitCode, detail, vanished: /\[spawn\] \S+: spawn \S+ ENOENT/.test(result.stderr) };
  } catch (error) {
    // A timeout or an abort: the tool never reached a verdict.
    return { code: -1, detail: errorMessage(error), vanished: false };
  }
}

/** Write the trivy ignore file for one document: the listed ids, each under its
 *  reason, so the file explains itself to anyone who opens the kept run. */
function writeTrivyIgnore(path: string, kinds: ReadonlySet<string>): void {
  const lines = ["# Reviewed exceptions — scripts/scanner-skips.ts"];
  for (const skip of skipsFor("trivy", kinds)) lines.push(`# ${skip.reason}`, skip.trivy ?? "");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join("\n")}\n`);
}

/** tool id -> documents it crashed on. */
const crashed = new Map<string, string[]>();

/** `slug` names the document's directory — `brief-3`, `web-app` — and is the
 *  file prefix assess reports findings under. */
type Case = { label: string; slug: string; cloud: Cloud; model: InfraModel };

const cases: Case[] = [];
for (const [i, brief] of BRIEFS.entries()) {
  for (const cloud of CLOUDS) {
    cases.push({ label: brief, slug: `brief-${i + 1}`, cloud, model: composeFromPrompt(brief).model });
  }
}
for (const template of WORKSPACE_TEMPLATES) {
  for (const cloud of CLOUDS) {
    cases.push({ label: `template:${template.id}`, slug: template.id, cloud, model: templateModel(template) });
  }
}

let failed = 0;
/** tool id -> why it did not run. */
const skipped = new Map<string, string>();

await resolveRoutes();

const RUN_PREFIX = "terragram-validate-";
/** How many previous runs to leave on disk for debugging. */
const KEEP_RUNS = 2;

/**
 * Delete the run directories older than the last few.
 *
 * A run that fails keeps its directory on purpose, so the files behind a failure
 * can be read. Nothing ever removed them again, and each one is around a
 * gigabyte once `init` has vendored the modules — seventy-seven of them filled a
 * disk before anyone noticed, which failed the next run with ENOSPC and looked
 * like a defect in the emitter. Keeping the last few is enough to debug with;
 * keeping every run since the gate was written is how a scratch directory
 * becomes an outage.
 */
function pruneOldRuns(): void {
  try {
    const runs = readdirSync(tmpdir())
      .filter((name) => name.startsWith(RUN_PREFIX))
      .map((name) => join(tmpdir(), name))
      .map((path) => ({ path, at: statSync(path).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const stale of runs.slice(KEEP_RUNS)) {
      rmSync(stale.path, { recursive: true, force: true });
    }
    if (runs.length > KEEP_RUNS) {
      console.log(`pruned ${runs.length - KEEP_RUNS} earlier run director${runs.length - KEEP_RUNS === 1 ? "y" : "ies"}`);
    }
  } catch (error) {
    // Never fail a run over housekeeping.
    console.log(`could not prune earlier runs: ${errorMessage(error)}`);
  }
}

pruneOldRuns();

/** One root for the run; each document is a subdirectory. */
const root = mkdtempSync(join(tmpdir(), RUN_PREFIX));
const dirOf = (item: Case) => join(root, `${item.slug}-${item.cloud}`);
/**
 * A second copy of the same documents, and nothing else.
 *
 * `terraform init` fills each document with `.terraform/modules/` — on Azure that
 * is twenty Verified Modules per document, tens of thousands of files across the
 * run. A scanner pointed at the run root has to walk all of it to decide it is
 * not ours, which took the assess step from seconds to past its idle timeout.
 * This tree is written before init and never touched by Terraform, so the scan
 * covers exactly the product's output and nothing a module author wrote.
 */
const scanRoot = join(root, "scan");
const scanDirOf = (item: Case) => join(scanRoot, `${item.slug}-${item.cloud}`);
const failedDirs = new Set<string>();

/** A registry fetch that fails once is not a defect in the document. Eighteen
 *  `init`s per run is eighteen chances for one to blip, and before this every
 *  blip read as a failed document. Only registry/network shapes are retried —
 *  a genuinely bad module source fails on the first attempt like anything else. */
const TRANSIENT = /timeout|timed out|EOF|connection reset|TLS handshake|could not connect|Failed to query available provider packages|Failed to download module|Error installing provider|429|503|502|context deadline/i;
async function initWithRetry(dir: string): Promise<Outcome> {
  return retry(
    async () => {
      const result = await run(terraformBin, ["init", "-backend=false", "-input=false", "-no-color"], dir, INIT_TIMEOUT_MS);
      if (!result.ok && TRANSIENT.test(result.detail)) throw new Error(result.detail);
      return result;
    },
    { delaysMs: [3_000, 10_000], shouldRetry: (error) => TRANSIENT.test(errorMessage(error)), label: "terraform init" },
  ).catch((error): Outcome => ({ ok: false, missing: false, detail: errorMessage(error) }));
}

for (const item of cases) {
  const out = emitTerraform(item.model, item.cloud);
  const dir = dirOf(item);
  mkdirSync(dir, { recursive: true });
  for (const file of out.files) {
    // A handler stub lives under src/<slug>/; the plan files at the root.
    for (const target of [join(dir, file.name), join(scanDirOf(item), file.name)]) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content);
    }
  }

  const problems: string[] = [];

  // Formatting first: it needs no network and no init, so a formatting defect is
  // reported even when the registry is unreachable.
  const fmt = await run(terraformBin, ["fmt", "-check", "-diff", "-no-color"], dir, TOOL_TIMEOUT_MS);
  if (!fmt.ok) problems.push(`terraform fmt would rewrite this document:\n${fmt.detail}`);

  const init = await initWithRetry(dir);
  if (!init.ok) {
    problems.push(`terraform init:\n${init.detail}`);
  } else {
    const validate = await run(terraformBin, ["validate", "-no-color"], dir, TOOL_TIMEOUT_MS);
    if (!validate.ok) problems.push(`terraform validate:\n${validate.detail}`);

    const kinds = new Set(item.model.nodes.map((n) => n.kind));
    const target: ScanTarget = {
      dir,
      trivyIgnore: join(root, "trivyignore", `${item.slug}-${item.cloud}`),
      checkovSkips: skipsFor("checkov", kinds).map((skip) => skip.checkov ?? ""),
    };
    writeTrivyIgnore(target.trivyIgnore, kinds);

    for (const tool of OPTIONAL_TOOLS) {
      const route = routes.get(tool.id);
      if (!route) continue;
      const result = await scan(route, target);
      if (result.vanished) {
        // The route was probed before the run, so this is the binary going
        // away mid-run rather than an ordinary absence.
        skipped.set(tool.id, `disappeared mid-run (${route.via})`);
        routes.delete(tool.id);
        continue;
      }
      const verdict = tool.verdict(result.code, result.detail);
      if (verdict === "findings") problems.push(`${tool.id} (${route.via}) findings:\n${result.detail}`);
      if (verdict === "crash") {
        crashed.set(tool.id, [...(crashed.get(tool.id) ?? []), `${item.slug}-${item.cloud}`]);
        problems.push(
          `${tool.id} (${route.via}) CRASHED — exit ${result.code}, no verdict on this document:\n${result.detail}`,
        );
      }
    }
  }

  const ok = problems.length === 0;
  console.log(`${ok ? "PASS" : "FAIL"}  ${item.cloud.padEnd(5)}  ${item.label}`);
  if (!ok) {
    failed++;
    for (const problem of problems) {
      console.log(problem.trim().split("\n").map((l) => `        ${l}`).join("\n"));
    }
    console.log(`        files: ${dir}`);
    failedDirs.add(dir);
  }
}

/* -------------------------------------------------------- infraweaver assess -- */

/**
 * Infraweaver's scorecard over the generated plans. This is the reuse that
 * matters: the scanner Infraweaver sells is a CLI, deterministic and offline, and
 * it maps what it finds to the compliance vocabulary Terragram's customers are
 * audited in.
 *
 * ONE DOCUMENT AT A TIME, for two reasons that turned out to be the same reason.
 * A customer applies one plan, not twenty siblings, so scoring them together
 * invented cross-document "repeated literal" advice about a layout only this gate
 * has — the previous run's eighteen lows were all of that kind. And the rule that
 * invents them is superlinear: two documents together took seven times one
 * document alone, which is what pushed the whole step past its idle timeout.
 * Scoring each document on its own is both the honest unit and the fast one.
 *
 * It reads `scan/`, the copy Terraform never initialised, so the subject is
 * Terragram's output rather than the module sources `init` vendored beside it.
 *
 * Critical, high and medium concerns fail the document they are in. Low and info
 * are reported only. The CLI lists at most ten concerns per document, so the
 * count is the truth and the list is the sample.
 */
type Assessed = {
  posture: string;
  total: number;
  by_severity: Record<string, number>;
  top_risks: Array<{ severity: string; rule_id: string; file: string; line: number; evidence: string }>;
  cyber_essentials?: { score: number; controls_at_risk: string[] };
};

const GATING = ["critical", "high", "medium"];

const assessCli = join(process.cwd(), "node_modules", "infraweaver", "dist", "cli.mjs");
if (!existsSync(assessCli)) {
  skipped.set("infraweaver", "not installed (npm i -D infraweaver)");
} else {
  /** Assess one document. A throw is a verdict of "no verdict", never a crash:
   *  documents that passed the toolchain must not be thrown away because the
   *  scorecard after them timed out. */
  async function assessOne(item: Case): Promise<{ item: Case; assessed: Assessed | null; why: string }> {
    try {
      const result = await spawn({
        cmd: process.execPath,
        args: [assessCli, "assess", scanDirOf(item), "--format", "json", "--fail-on", "never"],
        cwd: scanRoot,
        timeout: ASSESS_TIMEOUT_MS,
        // The CLI prints nothing until it has a verdict, so the idle guard has to
        // be the wall clock or it fires on a working process.
        activityTimeout: ASSESS_TIMEOUT_MS,
        killGroup: process.platform !== "win32",
        env: { ...process.env, TF_IN_AUTOMATION: "1" },
      });
      return { item, assessed: JSON.parse(result.stdout) as Assessed, why: "" };
    } catch (error) {
      return { item, assessed: null, why: errorMessage(error) };
    }
  }

  // Four at a time: the CLI is single-threaded and CPU-bound, and a runner with
  // two cores should not be asked to run twenty.
  const queue = [...cases];
  const results: Array<{ item: Case; assessed: Assessed | null; why: string }> = [];
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        results.push(await assessOne(next));
      }
    }),
  );

  const totals: Record<string, number> = {};
  let concerns = 0;
  let scored = 0;
  const scores: number[] = [];
  const atRisk = new Set<string>();
  const noVerdict: string[] = [];

  for (const { item, assessed, why } of results) {
    if (!assessed) {
      noVerdict.push(`${item.slug}-${item.cloud}: ${why}`);
      continue;
    }
    scored++;
    concerns += assessed.total;
    for (const [severity, count] of Object.entries(assessed.by_severity)) {
      totals[severity] = (totals[severity] ?? 0) + count;
    }
    if (assessed.cyber_essentials) {
      scores.push(assessed.cyber_essentials.score);
      for (const control of assessed.cyber_essentials.controls_at_risk) atRisk.add(control);
    }

    const gating = GATING.reduce((n, severity) => n + (assessed.by_severity[severity] ?? 0), 0);
    if (gating > 0) failedDirs.add(dirOf(item));
    for (const risk of assessed.top_risks) {
      if (!GATING.includes(risk.severity)) continue;
      console.log(`  ${risk.severity.padEnd(8)} ${risk.rule_id}  ${item.slug}-${item.cloud}/${risk.file}:${risk.line}`);
      console.log(`           ${risk.evidence.slice(0, 160)}`);
    }
  }

  if (scored === 0) {
    skipped.set("infraweaver", `no document produced a verdict: ${noVerdict[0] ?? "unknown"}`);
  } else {
    const gating = GATING.reduce((n, severity) => n + (totals[severity] ?? 0), 0);
    const advisory = ["low", "info"].reduce((n, severity) => n + (totals[severity] ?? 0), 0);
    const band = scores.length === 0
      ? ""
      : `, Cyber Essentials ${Math.min(...scores)}${Math.min(...scores) === Math.max(...scores) ? "" : `-${Math.max(...scores)}`}/100`;
    console.log(
      `\ninfraweaver assess: ${scored} document(s) — ${concerns} concern(s), ` +
        `${gating} gating, ${advisory} advisory${band}`,
    );
    if (atRisk.size > 0) console.log(`  controls at risk: ${[...atRisk].sort().join(", ")}`);
    for (const line of noVerdict) console.log(`  no verdict  ${line}`);
    failed = failedDirs.size;
  }
}

if (!keep && failedDirs.size === 0) rmSync(root, { recursive: true, force: true });
else console.log(`\nkept: ${root}`);

console.log(`\n${cases.length - failed}/${cases.length} documents pass the toolchain`);
const ran = [...routes.entries()].map(([id, route]) => `${id} (${route.via})`).sort();
console.log(`optional scanners: ${ran.length > 0 ? ran.join(", ") : "none"}`);
for (const [id, why] of [...skipped].sort()) console.log(`  skipped ${id}: ${why}`);
for (const [id, docs] of [...crashed].sort()) {
  console.log(`  CRASHED ${id} on ${docs.length} document(s): ${docs.join(", ")}`);
}

// The reviewed exceptions, every run, so what the scanners were told to ignore
// is read beside what they found.
console.log(`\nscanner skip-list (scripts/scanner-skips.ts, ${SCANNER_SKIPS.length} entries):`);
for (const skip of SCANNER_SKIPS) {
  const ids = [skip.checkov && `checkov ${skip.checkov}`, skip.trivy && `trivy ${skip.trivy}`].filter(Boolean).join(" · ");
  const scope = skip.enforcedWith ? ` [enforced where the plan has ${skip.enforcedWith}]` : "";
  console.log(`  ${ids}${scope}\n      ${skip.reason}`);
}
process.exit(failed);
