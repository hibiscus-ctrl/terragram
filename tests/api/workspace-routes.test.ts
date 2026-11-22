// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The workspace model routes, signed out. Both are session-authed and must
 * refuse before they read a byte of the body — the 401 is asserted for bodies
 * that would otherwise be a 400 or a 413, so a refusal that moved behind body
 * parsing would show up here. The signed-in contracts are in seeded.test.ts.
 */
import { describe, it } from "node:test";

import { api, CONFIGURED } from "./helpers/client.ts";
import { assertApiError } from "./helpers/shape.ts";

const ROUTES = ["/api/workspace/translate", "/api/workspace/read-diagram"];

describe("workspace model routes, signed out", { skip: !CONFIGURED }, () => {
  for (const path of ROUTES) {
    it(`WS-N1: ${path} is 401 for a valid-looking body`, async () => {
      const body =
        path.endsWith("translate")
          ? { prompt: "a web app with a database" }
          : { mediaType: "image/png", data: "iVBORw0KGgo=" };
      assertApiError(await api().post(path).send(body), 401, "unauthorized");
    });

    it(`WS-N2: ${path} is 401 for a malformed body`, async () => {
      assertApiError(
        await api().post(path).set("content-type", "application/json").send("{not json"),
        401,
        "unauthorized",
      );
    });

    it(`WS-N3: ${path} is 401 for an oversized body`, async () => {
      assertApiError(
        await api().post(path).send({ prompt: "x".repeat(8_000_000) }),
        401,
        "unauthorized",
      );
    });

    it(`WS-N4: ${path} ignores a forged session cookie`, async () => {
      const res = await api()
        .post(path)
        .set("cookie", "sb-forged-auth-token=base64-eyJhY2Nlc3NfdG9rZW4iOiJmb3JnZWQifQ")
        .send({ prompt: "x" });
      assertApiError(res, 401, "unauthorized");
    });
  }
});
