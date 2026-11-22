// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stripe webhook receiver: signature, body and flood contracts.
 *
 * .env.test pins a deterministic STRIPE_WEBHOOK_SECRET on the test server, so the
 * suite can produce both valid and invalid signatures. Every VALID-signature
 * payload here is an event type the route ignores, so it terminates before the
 * first database write or Stripe API call.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { api, CONFIGURED, stripeSignature, uniqueIp } from "./helpers/client.ts";
import { assertApiError, assertRateLimited } from "./helpers/shape.ts";

const STRIPE = CONFIGURED && Boolean(process.env.STRIPE_WEBHOOK_SECRET);
const PATH = "/api/webhooks";

/** A minimal event of a type the route does not act on. */
const ignoredEvent = () =>
  JSON.stringify({
    id: "evt_apitest_terragram",
    object: "event",
    type: "invoice.created",
    api_version: "2025-01-01",
    data: { object: { id: "in_apitest", object: "invoice" } },
  });

function post(rawBody: string, signature?: string, ip = uniqueIp()) {
  let req = api().post(PATH).set("content-type", "application/json").set("x-forwarded-for", ip);
  if (signature !== undefined) req = req.set("stripe-signature", signature);
  return req.send(rawBody);
}

describe("POST /api/webhooks (Stripe)", { skip: !STRIPE }, () => {
  it("WH-N1: a missing signature is 400 before anything is parsed", async () => {
    assertApiError(await post(ignoredEvent()), 400, "Missing Stripe signature or webhook secret");
  });

  it("WH-N2: a signature made with the wrong secret is 400", async () => {
    const raw = ignoredEvent();
    assertApiError(await post(raw, stripeSignature(raw, "whsec_the_wrong_secret")), 400, "Invalid Stripe signature");
  });

  it("WH-N3: a signature over different bytes is 400 (the body is verified raw)", async () => {
    const signed = ignoredEvent();
    const tampered = signed.replace("invoice.created", "customer.subscription.deleted");
    assertApiError(await post(tampered, stripeSignature(signed)), 400, "Invalid Stripe signature");
  });

  it("WH-N4: a correctly signed but stale timestamp is 400 (replay window)", async () => {
    const raw = ignoredEvent();
    const anHourAgo = Math.floor(Date.now() / 1000) - 3600;
    assertApiError(await post(raw, stripeSignature(raw, undefined, anHourAgo)), 400, "Invalid Stripe signature");
  });

  it("WH-N5: a garbage signature header is 400, not a 500", async () => {
    assertApiError(await post(ignoredEvent(), "not-a-stripe-signature"), 400, "Invalid Stripe signature");
  });

  it("WH-P1: a correctly signed event the route ignores is acknowledged", async () => {
    const raw = ignoredEvent();
    const res = await post(raw, stripeSignature(raw));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { received: true });
  });

  it("WH-B1: an oversized body is 413 before the signature is even checked", async () => {
    const huge = JSON.stringify({ type: "invoice.created", pad: "x".repeat(2_100_000) });
    assertApiError(await post(huge, "t=1,v1=00"), 413, "Request body too large");
  });

  it("WH-RL1: past 100 requests a minute from one address it answers the 429 envelope", async () => {
    // Unsigned on purpose: each request is refused at the signature check, so the
    // flood costs nothing but the limiter itself.
    const ip = uniqueIp();
    let last: Awaited<ReturnType<typeof post>> | undefined;
    for (let i = 0; i < 101; i++) last = await post("{}", undefined, ip);
    assert.ok(last);
    assertRateLimited(last);
    // A different address is unaffected.
    assert.equal((await post("{}")).status, 400);
  });

  it("WH-N6: GET is 405", async () => {
    assert.equal((await api().get(PATH)).status, 405);
  });
});
