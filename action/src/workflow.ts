// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

/**
 * The runner protocol and the host seams.
 *
 * Everything the Action needs from outside (the environment, the network, git, the
 * clock) is a field of `Host`, so the end-to-end tests run the real code against a
 * local fake of GitHub. `Workflow` is the other direction: outputs, annotations,
 * masks and the step summary, written the way the runner reads them, with no
 * dependency on `@actions/core`.
 */

export type Host = {
  env: Readonly<Record<string, string | undefined>>;
  /** Where relative paths resolve when `GITHUB_WORKSPACE` is not set. */
  cwd: string;
  fetch: typeof fetch;
  /** Standard output: the runner reads workflow commands from it. */
  stdout(text: string): void;
  /** Run git (no shell) in `cwd`. `ok` is false on a non-zero exit or a failure to start. */
  git(args: readonly string[], cwd: string): { ok: boolean; stdout: string };
  now(): Date;
};

export function processHost(): Host {
  return {
    env: process.env,
    cwd: process.cwd(),
    fetch: globalThis.fetch,
    stdout: (text) => void process.stdout.write(text),
    git: (args, cwd) => {
      const result = spawnSync("git", [...args], {
        cwd,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
      return { ok: result.status === 0, stdout: result.stdout ?? "" };
    },
    now: () => new Date(),
  };
}

/** A failure with a message meant for the user: reported as an error annotation, exit 1. */
export class ActionError extends Error {
  override name = "ActionError";
}

const escapeData = (text: string) => text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
const escapeProperty = (text: string) => escapeData(text).replaceAll(":", "%3A").replaceAll(",", "%2C");

export type Workflow = ReturnType<typeof createWorkflow>;

export function createWorkflow(host: Host) {
  const command = (name: string, message: string, properties: Record<string, string> = {}) => {
    const props = Object.entries(properties)
      .map(([key, value]) => `${key}=${escapeProperty(value)}`)
      .join(",");
    host.stdout(`::${name}${props ? ` ${props}` : ""}::${escapeData(message)}\n`);
  };

  /** Print lines with every workflow command switched off, in one window per call. */
  const untrusted = (lines: readonly string[]) => {
    if (lines.length === 0) return;
    const token = randomUUID().replaceAll("-", "");
    const text = lines.join("\n").replace(/\r\n|\r|\u2028|\u2029|\u0085/g, "\n");
    host.stdout(`::stop-commands::${token}\n${text}\n::${token}::\n`);
  };

  return {
    /**
     * A plain log line. Some of what is logged (component labels, diffs) comes from a
     * pull request, and the runner reads workflow commands in both syntaxes (`::cmd::`,
     * and the legacy `##[cmd]` anywhere in a line). Pattern-matching that is fragile, so
     * the text is printed inside a `stop-commands` window with an unguessable token: the
     * runner processes no command at all until the token is echoed back.
     */
    log(line: string) {
      untrusted([line]);
    },
    notice(message: string) {
      command("notice", message);
    },
    warning(message: string) {
      command("warning", message);
    },
    error(message: string, file?: string) {
      command("error", message, file ? { file } : {});
    },
    /** Register a value the runner must replace with *** in every later log line. */
    mask(value: string) {
      if (value.length > 0) command("add-mask", value);
    },
    group(title: string, lines: readonly string[]) {
      command("group", title);
      untrusted(lines);
      host.stdout("::endgroup::\n");
    },
    setOutput(name: string, value: string) {
      const file = host.env.GITHUB_OUTPUT;
      if (!file) {
        this.log(`output ${name}=${value}`);
        return;
      }
      // The heredoc form carries any value; the delimiter is random so a value cannot close it.
      const delimiter = `terragram_${randomUUID()}`;
      appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
    },
    summary(markdown: string) {
      const file = host.env.GITHUB_STEP_SUMMARY;
      if (file) appendFileSync(file, `${markdown}\n`);
    },
  };
}
