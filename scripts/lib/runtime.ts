// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { spawn as nodeSpawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * What the release-gate scripts need from the outside, kept here so that `npm ci` reaches
 * nothing but the public registry: a message for an unknown thrown value, a bounded retry,
 * and a subprocess with a timeout whose result is data rather than an exception.
 */

/** The text of whatever was thrown, with its causes. */
export function errorMessage(value: unknown): string {
  if (value instanceof Error) {
    const own = value.message.trim() || value.name;
    return value.cause === undefined || value.cause === null ? own : `${own}: ${errorMessage(value.cause)}`;
  }
  return typeof value === "string" && value !== "" ? value : String(value);
}

/**
 * Run `fn`, and run it again after each of `delaysMs` while `shouldRetry` says the error was
 * transient. The last error is thrown once the delays run out.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: { delaysMs: readonly number[]; shouldRetry: (error: unknown) => boolean; label: string },
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const delay = options.delaysMs[attempt];
      if (delay === undefined || !options.shouldRetry(error)) throw error;
      console.log(`${options.label} failed (${errorMessage(error).split("\n")[0]}); retrying in ${Math.round(delay / 1000)}s`);
      await sleep(delay);
    }
  }
}

export type SpawnOptions = {
  cmd: string;
  args: readonly string[];
  cwd: string;
  /** Milliseconds before the process is stopped and the call rejects. */
  timeout: number;
  /** Run the command in its own process group and stop the whole group on a timeout (POSIX only). */
  killGroup?: boolean;
  env: NodeJS.ProcessEnv;
};

export type SpawnResult = { stdout: string; stderr: string; exitCode: number };

/** The most of each stream that is kept: the end of it, which is where a tool says why it failed. */
const KEEP_BYTES = 8 * 1024 * 1024;

const tail = (text: string) => (text.length > KEEP_BYTES ? text.slice(text.length - KEEP_BYTES) : text);

/**
 * Run a command to completion. A command that cannot start (not installed) or is killed by a
 * signal resolves with a non-zero `exitCode` and a `[spawn] <cmd>: ...` line on stderr, so a caller
 * can tell "not installed" from a failure; only a timeout rejects.
 */
export function spawn(options: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(options.cmd, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: options.killGroup === true,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const stop = (signal: NodeJS.Signals) => {
      if (options.killGroup && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The group is already gone; fall through to the process itself.
        }
      }
      child.kill(signal);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop("SIGTERM");
      setTimeout(() => stop("SIGKILL"), 5000).unref();
    }, options.timeout);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout = tail(stdout + chunk);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = tail(stderr + chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      const line = `[spawn] ${options.cmd}: ${error.message}`;
      resolve({ stdout, stderr: stderr ? `${stderr}\n${line}` : line, exitCode: 1 });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`process timed out after ${options.timeout}ms`));
      if (code === null) {
        const line = `[spawn] ${options.cmd}: killed by signal ${signal}`;
        return resolve({ stdout, stderr: stderr ? `${stderr}\n${line}` : line, exitCode: 1 });
      }
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}
