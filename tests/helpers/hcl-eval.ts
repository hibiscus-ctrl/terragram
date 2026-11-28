// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from "node:crypto";

/**
 * Evaluates the small subset of HCL expressions the generator writes for a name: string templates, `var.<name>`,
 * `trim`, `substr`, `sha256`, `length`, `<=` and `a ? b : c`. Anything else throws, so a test never
 * passes on an expression it did not understand.
 */
export function evalHcl(source: string, vars: Record<string, string>): string | number | boolean {
  let i = 0;
  const peek = () => source.slice(i);
  const skip = () => {
    while (source[i] === " ") i++;
  };
  const fail = (what: string): never => {
    throw new Error(`cannot evaluate ${what} at ${i} of ${source}`);
  };
  type Value = string | number | boolean;

  function str(): string {
    i++; // opening quote
    let out = "";
    while (source[i] !== '"') {
      if (i >= source.length) fail("an unclosed string");
      if (source.startsWith("${", i)) {
        i += 2;
        out += String(ternary());
        skip();
        if (source[i] !== "}") fail("an unclosed interpolation");
        i++;
      } else out += source[i++];
    }
    i++;
    return out;
  }

  function call(name: string): Value {
    i++; // (
    const args: Value[] = [];
    skip();
    while (source[i] !== ")") {
      args.push(ternary());
      skip();
      if (source[i] === ",") i++;
      skip();
    }
    i++;
    const [a, b, c] = args;
    switch (name) {
      case "trim": {
        const set = String(b);
        let s = String(a);
        while (s.length > 0 && set.includes(s[0] as string)) s = s.slice(1);
        while (s.length > 0 && set.includes(s.at(-1) as string)) s = s.slice(0, -1);
        return s;
      }
      case "substr":
        return String(a).slice(Number(b), Number(b) + Number(c));
      case "sha256":
        return createHash("sha256").update(String(a)).digest("hex");
      case "length":
        return String(a).length;
      default:
        return fail(`the function ${name}`);
    }
  }

  function primary(): Value {
    skip();
    if (source[i] === '"') return str();
    const num = /^\d+/.exec(peek());
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }
    const id = /^[A-Za-z_][A-Za-z0-9_.-]*/.exec(peek());
    if (!id) return fail("a value");
    i += (id[0] as string).length;
    if (source[i] === "(") return call(id[0] as string);
    const ref = /^var\.([a-z_]+)$/.exec(id[0] as string);
    if (ref && vars[ref[1] as string] !== undefined) return vars[ref[1] as string] as string;
    return fail(`the reference ${id[0]}`);
  }

  function compare(): Value {
    const left = primary();
    skip();
    if (source.startsWith("<=", i)) {
      i += 2;
      return Number(left) <= Number(primary());
    }
    return left;
  }

  function ternary(): Value {
    const condition = compare();
    skip();
    if (source[i] !== "?") return condition;
    i++;
    const yes = ternary();
    skip();
    if (source[i] !== ":") fail("a ':'");
    i++;
    const no = ternary();
    return condition ? yes : no;
  }

  const value = ternary();
  skip();
  if (i !== source.length) fail("trailing text");
  return value;
}
