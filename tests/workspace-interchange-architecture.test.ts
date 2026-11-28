// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { type InterchangeResult, looksLikeMermaid, parseMermaid } from "terragram-engine/interchange";
import { emitTerraform } from "terragram-engine/terraform";

/**
 * The `architecture-beta` reader keeps the flowchart reader's promises: every
 * service lands on the diagram, every edge is the reviewer's own, and nothing is
 * guessed: an icon the engine has no map for makes a flagged generic component.
 */

function ok(source: string): Extract<InterchangeResult, { ok: true }> {
  const res = parseMermaid(source);
  if (!res.ok) assert.fail(res.error);
  return res;
}

function error(source: string): string {
  const res = parseMermaid(source);
  if (res.ok) assert.fail("expected the diagram to be refused");
  return res.error;
}

const userEdges = (res: Extract<InterchangeResult, { ok: true }>): string[] =>
  res.model.edges.filter((e) => e.origin === "user").map((e) => e.id);

describe("architecture-beta: a well-formed diagram", () => {
  const source = `architecture-beta
    title Shop
    %% the public tier
    group api(cloud)[API]

    service gateway(internet)[Users] in api
    service web(server)[Web app] in api
    service db(database)[Postgres database] in api
    service cache(disk)[Redis cache] in api

    gateway:R -- L:web
    web:R --> L:db
    web:B --> T:cache
`;

  it("is recognised as Mermaid", () => {
    assert.equal(looksLikeMermaid(source), true);
    assert.equal(looksLikeMermaid("%% note\n\narchitecture-beta\n  service a(server)[A]"), true);
  });

  it("maps labels to kinds, the internet icon to the internet node, and edges to the reviewer's topology", () => {
    const res = ok(source);
    assert.deepEqual(res.model.nodes.map((n) => n.kind).sort(), ["app-service", "internet", "postgres", "redis-cache"]);
    assert.equal(res.model.topology, "manual");
    assert.deepEqual(userEdges(res).sort(), ["app-service->postgres", "app-service->redis-cache"]);
    assert.ok(res.model.edges.some((e) => e.source === "internet" && e.target === "app-service"));
    assert.deepEqual(res.untranslated, []);
  });

  it("reports the group it flattened, and nothing else", () => {
    assert.deepEqual(ok(source).warnings, [
      'group "API" is not kept: the model has no groups. Its 4 services are kept.',
    ]);
  });

  it("emits Terraform for the model it read", () => {
    const { model } = ok(source);
    assert.ok(emitTerraform(model, "aws").files.some((f) => f.name === "main.tf"));
  });

  it("gives the same model whatever the whitespace, comments and trailing semicolons", () => {
    const plain = ok(source);
    const spaced = ok(
      source
        .split("\n")
        .map((line) => `${line};  %% trailing`)
        .join("\r\n"),
    );
    assert.deepEqual(spaced.model, plain.model);
  });

  it("reads quoted titles, titles without an icon and both arrow heads", () => {
    const res = ok(`architecture-beta
  service a["Web app"]
  service b(database)[Postgres]
  service c(server)[Redis cache]
  a:R --> L:b
  c:R <-- L:a
`);
    assert.deepEqual(userEdges(res).sort(), ["app-service->postgres", "app-service->redis-cache"]);
  });

  it("keeps a service it cannot match, flagged, as documentation", () => {
    const res = ok(`architecture-beta
  service web(server)[Web app]
  service crm(server)[Legacy CRM]
  web:R -- L:crm
`);
    assert.deepEqual(res.untranslated, ["Legacy CRM"]);
    const crm = res.model.nodes.find((n) => n.kind === "external");
    assert.equal(crm?.label, "Legacy CRM");
    assert.match(crm?.flag?.reason ?? "", /does not match/);
  });

  it("notes that <--> keeps one direction", () => {
    const res = ok(`architecture-beta
  service a(server)[Web app]
  service b(database)[Postgres]
  a:R <--> L:b
`);
    assert.deepEqual(userEdges(res), ["app-service->postgres"]);
    assert.equal(res.warnings.length, 1);
    assert.match(res.warnings[0] ?? "", /^line 4: .*<-->/);
  });
});

describe("architecture-beta: nested groups", () => {
  const source = `architecture-beta
    group cloud1(cloud)[Production]
    group data(database)[Data tier] in cloud1
    group inner(server)[Replicas] in data

    service web(server)[Web app] in cloud1
    service db(database)[Postgres primary] in data
    service replica(database)[Postgres replica] in inner
    service out(internet)[Internet]

    out:R -- L:web
    web{group}:R --> L:db{group}
    db:B --> T:replica
`;

  it("keeps every member and counts members through the nesting", () => {
    const res = ok(source);
    assert.deepEqual(res.model.nodes.map((n) => n.id).sort(), ["app-service", "internet", "postgres", "postgres-2"]);
    assert.deepEqual(res.warnings, [
      'group "Production" is not kept: the model has no groups. Its 3 services are kept.',
      'group "Data tier" (in "Production") is not kept: the model has no groups. Its 2 services are kept.',
      'group "Replicas" (in "Data tier") is not kept: the model has no groups. Its 1 service is kept.',
    ]);
    assert.deepEqual(userEdges(res).sort(), ["app-service->postgres", "postgres->postgres-2"]);
  });

  it("refuses a parent that is declared later, is not a group, or does not exist", () => {
    assert.match(
      error("architecture-beta\n  service a(server)[A] in later\n  group later(cloud)[L]"),
      /^Line 2: "a" is placed in "later", which is not declared above it\./,
    );
    assert.match(
      error("architecture-beta\n  service a(server)[A]\n  service b(server)[B] in a"),
      /^Line 3: "b" is placed in "a", which is not a group\./,
    );
  });

  it("refuses an edge that leaves a group from a service outside every group", () => {
    assert.match(
      error("architecture-beta\n  service a(server)[A]\n  service b(server)[B]\n  a{group}:R -- L:b"),
      /^Line 4: "a\{group\}" is not in a group/,
    );
  });

  it("refuses an edge that names a group", () => {
    assert.match(
      error("architecture-beta\n  group g(cloud)[G]\n  service a(server)[A] in g\n  a:R -- L:g"),
      /^Line 4: "g" is a group/,
    );
  });
});

describe("architecture-beta: junctions", () => {
  it("joins what comes in to what goes out and keeps no node for the junction", () => {
    const res = ok(`architecture-beta
  service web(server)[Web app]
  service db(database)[Postgres]
  service cache(disk)[Redis cache]
  junction fan

  web:R -- L:fan
  fan:T -- L:db
  fan:B -- L:cache
`);
    assert.equal(res.model.nodes.some((n) => n.id === "fan"), false);
    assert.deepEqual(userEdges(res).sort(), ["app-service->postgres", "app-service->redis-cache"]);
    assert.deepEqual(res.warnings, []);
  });

  it("resolves a chain of junctions, and a junction inside a group", () => {
    const res = ok(`architecture-beta
  group g(cloud)[G]
  service web(server)[Web app] in g
  service db(database)[Postgres]
  junction one in g
  junction two

  web:R -- L:one
  one:R -- L:two
  two:R -- L:db
`);
    assert.deepEqual(userEdges(res), ["app-service->postgres"]);
  });

  it("warns, and joins nothing, when a junction has edges on one side only", () => {
    const res = ok(`architecture-beta
  service web(server)[Web app]
  service db(database)[Postgres]
  junction j
  web:R -- L:j
  db:R -- L:j
`);
    assert.deepEqual(userEdges(res), []);
    assert.deepEqual(res.warnings, [
      'junction "j" has edges into it only, so it joins nothing and its edges are dropped.',
    ]);
  });
});

describe("architecture-beta: icons", () => {
  it("keeps a service with an unknown icon as a generic component, with a warning, whatever its label says", () => {
    const res = ok(`architecture-beta
  service web(server)[Web app]
  service fn(logos:aws-lambda)[Postgres loader]
  web:R -- L:fn
`);
    const fn = res.model.nodes.find((n) => n.label === "Postgres loader");
    assert.equal(fn?.kind, "external", "an unmapped icon must not be turned into a kind by its label");
    assert.match(fn?.flag?.reason ?? "", /logos:aws-lambda/);
    assert.deepEqual(res.untranslated, ["Postgres loader"]);
    assert.deepEqual(res.warnings, [
      'service "fn": icon "logos:aws-lambda" is not a built-in icon; kept as a generic component, not matched to a resource kind.',
    ]);
    assert.ok(res.model.edges.some((e) => e.target === fn?.id && e.origin === "user"), "its edge survives");
  });

  it("does not warn for the built-in icons, which say shape rather than resource", () => {
    const res = ok(`architecture-beta
  service a(cloud)[Web app]
  service b(database)[Postgres]
  service c(disk)[Object storage]
  service d(server)[Redis cache]
  a:R -- L:b
`);
    assert.deepEqual(res.warnings, []);
    assert.deepEqual(res.model.nodes.map((n) => n.kind).sort(), [
      "app-service",
      "internet",
      "object-storage",
      "postgres",
      "redis-cache",
    ]);
  });
});

describe("architecture-beta: malformed input", () => {
  it("names the line it cannot read", () => {
    assert.equal(
      error("architecture-beta\n  service a(server)[A]\n  a ==> b"),
      'Line 3: cannot read "a ==> b". Expected group, service, junction or an edge such as `a:R -- L:b`.',
    );
  });

  it("refuses a bad side, an unknown service, a second declaration and a self edge", () => {
    assert.match(error("architecture-beta\n  service a(server)[A]\n  service b(server)[B]\n  a:X -- L:b"), /^Line 4: cannot read/);
    assert.match(error("architecture-beta\n  service a(server)[A]\n  a:R -- L:ghost"), /^Line 3: the edge uses "ghost", which is not declared above it\./);
    assert.match(error("architecture-beta\n  service a(server)[A]\n  service a(server)[B]"), /^Line 3: "a" is declared twice\./);
    assert.match(error("architecture-beta\n  service a(server)[A]\n  a:R -- L:a"), /^Line 3: "a" is connected to itself\./);
  });

  it("refuses text after the header and a diagram with no services", () => {
    assert.match(error("architecture-beta LR\n  service a(server)[A]"), /^Line 1: nothing may follow/);
    assert.equal(error("architecture-beta\n  group g(cloud)[G]"), "No services were found in this architecture diagram.");
    assert.equal(error("architecture-beta"), "No services were found in this architecture diagram.");
  });

  it("refuses text before the header, and anything that is not Mermaid", () => {
    assert.match(error("service a(server)[A]\narchitecture-beta"), /should start with `flowchart`, `graph` or `architecture-beta`/);
    assert.match(error("a web app with a database"), /should start with `flowchart`, `graph` or `architecture-beta`/);
  });
});

describe("architecture-beta: determinism", () => {
  it("gives the same bytes on every read", () => {
    const source = `architecture-beta
  group g(cloud)[G]
  service a(internet)[Users] in g
  service b(server)[Web app] in g
  service c(database)[Postgres]
  junction j
  a:R -- L:b
  b:R -- L:j
  j:R -- L:c
`;
    assert.equal(JSON.stringify(parseMermaid(source)), JSON.stringify(parseMermaid(source)));
  });
});

describe("architecture-beta: hostile input", () => {
  // Whitespace between a name and the optional icon, title and `in` parts used to backtrack polynomially: this took 36 s.
  const bounded = (source: string, ms = 1000) => {
    const started = performance.now();
    const res = parseMermaid(source);
    const took = performance.now() - started;
    assert.ok(took < ms, `took ${Math.round(took)} ms`);
    return res;
  };

  it("reads a long run of spaces after a declaration in linear time", () => {
    const res = bounded(`architecture-beta\nservice a${" ".repeat(4000)}x`);
    assert.equal(res.ok, false);
  });

  it("reads runs of spaces between the parts of a declaration in linear time", () => {
    for (const filler of [" ", "\t", " \t"]) {
      const pad = filler.repeat(2000);
      bounded(`architecture-beta\ngroup g\nservice a${pad}(cloud)${pad}[A]${pad}in${pad}g${pad}x`);
      bounded(`architecture-beta\nservice a${pad}(cloud${pad}`);
      bounded(`architecture-beta\nservice a${pad}[A${pad}`);
      bounded(`architecture-beta\njunction j${pad}in${pad}`);
      bounded(`architecture-beta\nservice a\nservice b\na:R${pad}<${pad}--${pad}L:b${pad}x`);
    }
  });

  it("still reads a declaration with the spacing people write", () => {
    const res = ok(`architecture-beta
      group g(cloud)[Group]
      service a (server) [A server] in g
      service b(database) in g
      service c   [C]
      service d
      junction j in g
      a:R -- L:b`);
    assert.deepEqual(res.model.nodes.map((n) => n.label).filter((l) => l !== "Internet").sort(), ["A server", "C", "b", "d"]);
  });

  it("refuses a line over the cap with a message that names the line and the cap", () => {
    const message = error(`architecture-beta\nservice a[${"x".repeat(5000)}]`);
    assert.match(message, /^Line 2: .*over 2000 characters/);
  });

  it("accepts a title just under the cap", () => {
    ok(`architecture-beta\nservice a[${"x".repeat(1900)}]`);
  });
});
