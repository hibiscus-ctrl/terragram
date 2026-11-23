// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { errorMessage, retry, spawn } from "../scripts/lib/runtime.ts";

/**
 * The helpers the release-gate scripts (validate-emit, check-module-inputs) run on. A failing
 * gate script teaches people to ignore it, so what they report on a missing tool, a timeout or a
 * transient failure is pinned here.
 */

const run = (script: string, timeout = 10_000, killGroup = false) =>
  spawn({ cmd: process.execPath, args: ["-e", script], cwd: process.cwd(), timeout, killGroup, env: process.env });

describe("spawn", () => {
  it("returns what the command printed and its exit code", async () => {
    const ok = await run("process.stdout.write('out'); process.stderr.write('err')");
    assert.deepEqual(ok, { stdout: "out", stderr: "err", exitCode: 0 });
    const failed = await run("process.stdout.write('partial'); process.exit(3)");
    assert.equal(failed.exitCode, 3);
    assert.equal(failed.stdout, "partial");
  });

  it("says a command that is not installed was not found, as a result and not a throw", async () => {
    const result = await spawn({ cmd: "terragram-no-such-tool", args: [], cwd: process.cwd(), timeout: 5000, env: process.env });
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /\[spawn\] terragram-no-such-tool: spawn terragram-no-such-tool ENOENT/);
  });

  it("reports a command killed by a signal as a failure that names the signal", async () => {
    const result = await run("process.kill(process.pid, 'SIGKILL')");
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /killed by signal SIGKILL/);
  });

  it("rejects a command that runs past its timeout, and stops it", async () => {
    const started = Date.now();
    await assert.rejects(run("setInterval(() => {}, 1000)", 300), /timed out after 300ms/);
    assert.ok(Date.now() - started < 4000, "the process was stopped, not waited for");
  });

  it("stops a command's children with its process group", { skip: process.platform === "win32" }, async () => {
    const script = "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }); setInterval(() => {}, 1000)";
    await assert.rejects(run(script, 300, true), /timed out/);
  });

  it("keeps the end of an output larger than its cap", async () => {
    const result = await run("process.stdout.write('a'.repeat(9 * 1024 * 1024) + 'END')");
    assert.equal(result.stdout.length, 8 * 1024 * 1024);
    assert.ok(result.stdout.endsWith("END"));
  });
});

describe("retry", () => {
  const options = { delaysMs: [1, 1], shouldRetry: (error: unknown) => /transient/.test(errorMessage(error)), label: "step" };

  it("runs again after a transient failure and returns the first success", async () => {
    let calls = 0;
    const value = await retry(async () => {
      if (++calls < 3) throw new Error("transient blip");
      return "done";
    }, options);
    assert.equal(value, "done");
    assert.equal(calls, 3);
  });

  it("throws the last error once the delays run out", async () => {
    let calls = 0;
    await assert.rejects(
      retry(async () => {
        calls++;
        throw new Error(`transient ${calls}`);
      }, options),
      /transient 3/,
    );
    assert.equal(calls, 3);
  });

  it("does not retry an error that is not transient", async () => {
    let calls = 0;
    await assert.rejects(
      retry(async () => {
        calls++;
        throw new Error("bad module source");
      }, options),
      /bad module source/,
    );
    assert.equal(calls, 1);
  });
});

describe("errorMessage", () => {
  it("reads an error, its causes, a string and anything else", () => {
    assert.equal(errorMessage(new Error("outer", { cause: new Error("inner") })), "outer: inner");
    assert.equal(errorMessage(new Error("")), "Error");
    assert.equal(errorMessage("plain"), "plain");
    assert.equal(errorMessage(42), "42");
  });
});
