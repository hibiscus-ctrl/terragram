/**
 * Tests for the server-side log sink (`src/libs/log.ts`).
 *
 * The property that matters most is that nothing reaches the log store
 * unredacted — including a secret nested inside a field a caller passed whole,
 * and the `tmpx_` gateway token this product mints. The rest pins the record
 * shape: one parseable JSON line per call, on the stream its level names.
 *
 * Secrets below are synthetic shapes, never issued values.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { logger } from "../src/libs/log.ts";

type Captured = { stream: "log" | "warn" | "error"; line: string };

const real = { log: console.log, warn: console.warn, error: console.error };
const ORIGINAL_LEVEL = process.env.LOG_LEVEL;

let captured: Captured[] = [];

beforeEach(() => {
  captured = [];
  console.log = (line: string) => captured.push({ stream: "log", line });
  console.warn = (line: string) => captured.push({ stream: "warn", line });
  console.error = (line: string) => captured.push({ stream: "error", line });
});

afterEach(() => {
  Object.assign(console, real);
  if (ORIGINAL_LEVEL === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = ORIGINAL_LEVEL;
});

/** The single record a log call produced, parsed back from its JSON line. */
function record(): Record<string, unknown> {
  assert.equal(captured.length, 1, `expected exactly one line, got ${captured.length}`);
  return JSON.parse(captured[0]?.line ?? "{}");
}

const log = logger("test/scope");

describe("logger — redaction", () => {
  it("masks a tmpx_ gateway token in the message", () => {
    log.error("gateway refused Bearer tmpx_9f8e7d6c5b4a3210.sig");
    assert.doesNotMatch(captured[0]?.line ?? "", /tmpx_9f8e7d6c5b4a3210/);
  });

  it("masks a secret nested inside a field, not just the message", () => {
    log.error("upstream rejected", {
      err: { request: { headers: { authorization: "Bearer ghu_16C7e42F292c6912E7710c838347Ae178B4a" } } },
    });
    assert.doesNotMatch(captured[0]?.line ?? "", /ghu_16C7e42F292c6912E7710c838347Ae178B4a/);
  });

  it("masks a secret carried by an Error's message", () => {
    log.error("handler failed", { err: new Error('{"access_token":"plain-looking-value"}') });
    assert.doesNotMatch(captured[0]?.line ?? "", /plain-looking-value/);
  });
});

describe("logger — record shape", () => {
  it("writes one parseable JSON line carrying level, scope, message and time", () => {
    log.info("environment checked", { ok: true });
    const r = record();
    assert.equal(r.level, "info");
    assert.equal(r.scope, "test/scope");
    assert.equal(r.message, "environment checked");
    assert.equal(r.ok, true);
    assert.equal(typeof r.time, "string");
  });

  it("unwraps an Error field to name + message instead of an empty object", () => {
    log.warn("failed", { err: new TypeError("boom") });
    assert.deepEqual(record().err, { name: "TypeError", message: "boom" });
  });

  it("routes each level to its own stream", () => {
    log.info("a");
    log.warn("b");
    log.error("c");
    assert.deepEqual(
      captured.map((c) => c.stream),
      ["log", "warn", "error"],
    );
  });

  it("drops lines below LOG_LEVEL, and ignores an unrecognised value", () => {
    process.env.LOG_LEVEL = "warn";
    log.info("hidden");
    assert.equal(captured.length, 0);
    process.env.LOG_LEVEL = "loud";
    log.info("shown");
    assert.equal(captured.length, 1);
  });

  it("survives a circular field rather than throwing on the request path", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    assert.doesNotThrow(() => log.error("circular", { loop }));
    assert.equal(record().fields, "[unserialisable]");
  });
});

describe("logger — errors passed as fields", () => {
  it("keeps the message as given and masks a tmpx_ token inside an Error field", () => {
    log.error("compose failed", { err: new Error("Bearer tmpx_abcdef0123456789.sig rejected") });
    const r = record();
    assert.equal(r.message, "compose failed");
    assert.equal((r.err as { name?: string }).name, "Error");
    assert.doesNotMatch(captured[0]?.line ?? "", /tmpx_abcdef0123456789/);
  });
});
