// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Create / converge the Terragram Stripe catalogue — the managed-cost Billing Meter,
 * the PAYG / Team products, and their prices (flat or banded base + the metered
 * managed-model cost unit, 1 unit = 1 penny).
 *
 * Idempotent: re-running reuses existing objects (matched by meter `event_name`,
 * product `metadata.terragram_key`, and price `lookup_key`). Prices are immutable,
 * so if you change a number in `src/config/pricing.json` and re-run, the script
 * creates a NEW price, transfers the lookup key onto it, and archives the old one —
 * then prints the new id to copy into your env.
 *
 * Usage (loads .env.local; needs STRIPE_SECRET_KEY — use a TEST key first):
 *   npm run stripe:setup
 *
 * After it prints the env block, paste those `STRIPE_*` lines into Railway (and
 * .env.local for local testing), then configure the webhook + Customer Portal in
 * the Stripe dashboard. No live charge happens until those env vars are set.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";

const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  console.error("Set STRIPE_SECRET_KEY in .env.local (use a test key, sk_test_…, first).");
  process.exit(1);
}
if (key.startsWith("sk_live_")) {
  console.warn(
    "⚠️  Using a LIVE Stripe key — this creates real products/prices. Ctrl-C now to abort.\n",
  );
}

const stripe = new Stripe(key, { appInfo: { name: "Terragram Cloud (setup)", version: "0.1.0" } });
const cfg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/config/pricing.json", import.meta.url)), "utf8"),
);

async function findOrCreateMeter(eventName) {
  const meters = await stripe.billing.meters.list({ status: "active", limit: 100 });
  const found = meters.data.find((m) => m.event_name === eventName);
  if (found) return { obj: found, created: false };
  const obj = await stripe.billing.meters.create({
    display_name: "Terragram managed runs",
    event_name: eventName,
    default_aggregation: { formula: "sum" },
    value_settings: { event_payload_key: "value" },
    customer_mapping: { type: "by_id", event_payload_key: "stripe_customer_id" },
  });
  return { obj, created: true };
}

async function findOrCreateProduct(tkey, name) {
  const products = await stripe.products.list({ active: true, limit: 100 });
  const found = products.data.find((p) => p.metadata?.terragram_key === tkey);
  if (found) {
    // Keep the display name current (it shows on Checkout + invoices) even when the
    // product already exists — renaming a product is non-destructive, unlike a price.
    if (found.name !== name) await stripe.products.update(found.id, { name });
    return { obj: found, created: false };
  }
  const obj = await stripe.products.create({ name, metadata: { terragram_key: tkey } });
  return { obj, created: true };
}

function priceMatches(price, { unitAmount, interval, metered, meterId }) {
  const r = price.recurring;
  return (
    price.unit_amount === unitAmount &&
    price.currency === cfg.currency &&
    !!r &&
    r.interval === interval &&
    r.usage_type === (metered ? "metered" : "licensed") &&
    (!metered || r.meter === meterId)
  );
}

async function ensurePrice({ product, lookupKey, unitAmount, interval, metered = false, meterId }) {
  const recurring = metered ? { interval, usage_type: "metered", meter: meterId } : { interval };
  const existing = (await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 }))
    .data[0];

  if (existing && priceMatches(existing, { unitAmount, interval, metered, meterId })) {
    return { obj: existing, created: false };
  }
  const obj = await stripe.prices.create({
    product,
    currency: cfg.currency,
    unit_amount: unitAmount,
    recurring,
    lookup_key: lookupKey,
    ...(existing ? { transfer_lookup_key: true } : {}),
  });
  if (existing) await stripe.prices.update(existing.id, { active: false });
  return { obj, created: true };
}

// Marginal Team banding maps 1:1 onto Stripe graduated tiered pricing — let Stripe
// do the band math (don't hand-roll it into checkout). `bands` come straight from
// pricing.json; the inf band's `upTo:null` becomes Stripe's `up_to: 'inf'`.
function tieredPriceMatches(price, { interval, bands }) {
  const r = price.recurring;
  if (!r || r.interval !== interval || r.usage_type !== "licensed") return false;
  if (price.currency !== cfg.currency) return false;
  if (price.billing_scheme !== "tiered" || price.tiers_mode !== "graduated") return false;
  const got = price.tiers ?? [];
  if (got.length !== bands.length) return false;
  return bands.every((b, i) => {
    const t = got[i];
    return t && t.unit_amount === b.pence && (t.up_to ?? null) === (b.upTo ?? null);
  });
}

async function ensureTieredPrice({ product, lookupKey, interval, bands }) {
  const existing = (
    await stripe.prices.list({
      lookup_keys: [lookupKey],
      active: true,
      limit: 1,
      expand: ["data.tiers"],
    })
  ).data[0];

  if (existing && tieredPriceMatches(existing, { interval, bands })) {
    return { obj: existing, created: false };
  }
  const obj = await stripe.prices.create({
    product,
    currency: cfg.currency,
    billing_scheme: "tiered",
    tiers_mode: "graduated",
    tiers: bands.map((b) => ({ up_to: b.upTo ?? "inf", unit_amount: b.pence })),
    recurring: { interval, usage_type: "licensed" },
    lookup_key: lookupKey,
    ...(existing ? { transfer_lookup_key: true } : {}),
  });
  if (existing) await stripe.prices.update(existing.id, { active: false });
  return { obj, created: true };
}

const tag = (r) => (r.created ? "created" : "exists ");

// The money meter (Phase D): bills the marked-up Bedrock cost in pence — the metered
// price is 1 unit = 1 penny (sum of `value`, mapped to the customer by id).
const costMeter = await findOrCreateMeter(cfg.managedCost.meterEventName);
console.log(`${tag(costMeter)} meter         ${costMeter.obj.event_name} (${costMeter.obj.id})`);

const teamProduct = await findOrCreateProduct("team", "Terragram Team");
const paygProduct = await findOrCreateProduct("payg", "Terragram Pay-as-you-go");
const managedProduct = await findOrCreateProduct("managed_runs", "Terragram Managed Models");

// Lookup keys come from pricing.json so the app's runtime resolver and this script
// can never drift on the keys they match prices by.
const lk = cfg.stripe.lookupKeys;
const teamMonthly = await ensureTieredPrice({
  product: teamProduct.obj.id,
  lookupKey: lk.teamMonthly,
  interval: "month",
  bands: cfg.tiers.team.bands.month,
});
const teamAnnual = await ensureTieredPrice({
  product: teamProduct.obj.id,
  lookupKey: lk.teamAnnual,
  interval: "year",
  bands: cfg.tiers.team.bands.year,
});
const payg = await ensurePrice({
  product: paygProduct.obj.id,
  lookupKey: lk.payg,
  unitAmount: cfg.tiers.payg.baseMonthlyPence,
  interval: "month",
});
// 1 unit = 1 penny: the proxy reports the marked-up cost in pence, so per-model rate
// differences never reach Stripe — adding a model is a `model-rates.json` edit.
const managedCost = await ensurePrice({
  product: managedProduct.obj.id,
  lookupKey: lk.managedCost,
  unitAmount: 1,
  interval: "month",
  metered: true,
  meterId: costMeter.obj.id,
});

// Webhook endpoint — converge by URL so a paid checkout actually flips the org's
// plan in the deployed app (without this, Stripe has nowhere to deliver events and
// the plan never changes). Set TERRAGRAM_PUBLIC_URL=https://your-app to register;
// localhost is skipped (use `stripe listen` locally). Stripe returns the signing
// secret ONLY on creation, so an existing endpoint is left as-is.
const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
];
const publicUrl = (
  process.env.TERRAGRAM_PUBLIC_URL ||
  process.env.NEXT_PUBLIC_SITE_URL ||
  ""
).replace(/\/+$/, "");
if (publicUrl.startsWith("https://")) {
  const endpointUrl = `${publicUrl}/api/webhooks`;
  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
  const existingEndpoint = endpoints.data.find((e) => e.url === endpointUrl);
  if (existingEndpoint) {
    await stripe.webhookEndpoints.update(existingEndpoint.id, { enabled_events: WEBHOOK_EVENTS });
    console.log(`exists  webhook       ${endpointUrl} (${existingEndpoint.id}) — secret unchanged`);
  } else {
    const created = await stripe.webhookEndpoints.create({
      url: endpointUrl,
      enabled_events: WEBHOOK_EVENTS,
    });
    console.log(`created webhook       ${endpointUrl} (${created.id})`);
    console.log(`\n⚠️  Set this on Railway + .env.local NOW — Stripe shows it only once:`);
    console.log(`      STRIPE_WEBHOOK_SECRET=${created.secret}\n`);
  }
} else {
  console.log(
    "skip    webhook       (set TERRAGRAM_PUBLIC_URL=https://… to register the prod endpoint)",
  );
}

// Customer Portal — lets a paying org cancel (→ OSS), update its card and download
// invoices self-serve. Account-wide config (not per-URL). Plan SWITCHING is left to
// the in-app upgrade action so we control the banded repo quantity, so it's not
// enabled here. `subscription_cancel.mode` is at_period_end (the customer keeps what
// they paid for; the deletion event at period end flips them back to OSS).
const portalFeatures = {
  customer_update: { enabled: true, allowed_updates: ["email", "address", "tax_id"] },
  invoice_history: { enabled: true },
  payment_method_update: { enabled: true },
  subscription_cancel: { enabled: true, mode: "at_period_end" },
};
const portalConfigs = await stripe.billingPortal.configurations.list({ limit: 100 });
const portalConfig = portalConfigs.data.find((c) => c.is_default) ?? portalConfigs.data[0];
if (portalConfig) {
  await stripe.billingPortal.configurations.update(portalConfig.id, { features: portalFeatures });
  console.log(`exists  portal        ${portalConfig.id} (features synced)`);
} else {
  const created = await stripe.billingPortal.configurations.create({
    features: portalFeatures,
    business_profile: { headline: "Terragram billing" },
  });
  console.log(`created portal        ${created.id}`);
}

const bandSummary = (bands) => bands.map((b) => `${b.upTo ?? "∞"}:${b.pence}`).join(" ");
console.log(
  `${tag(teamMonthly)} price team monthly [tiered] ${bandSummary(cfg.tiers.team.bands.month)} (${teamMonthly.obj.id})`,
);
console.log(
  `${tag(teamAnnual)} price team annual  [tiered] ${bandSummary(cfg.tiers.team.bands.year)} (${teamAnnual.obj.id})`,
);
for (const [label, r] of [
  ["payg base   ", payg],
  ["managed cost", managedCost],
]) {
  console.log(`${tag(r)} price ${label} ${r.obj.unit_amount} ${cfg.currency} (${r.obj.id})`);
}

console.log(`\n# These price/meter ids are now resolved automatically at runtime from`);
console.log(`# the lookup keys in pricing.json — you do NOT need to set any of them. They are`);
console.log(`# printed only for reference / optional pinning (an env value, if set, wins):`);
console.log(`#   STRIPE_COST_METER_EVENT_NAME=${cfg.managedCost.meterEventName}`);
console.log(`#   STRIPE_TEAM_PRICE_ID=${teamMonthly.obj.id}`);
console.log(`#   STRIPE_TEAM_ANNUAL_PRICE_ID=${teamAnnual.obj.id}`);
console.log(`#   STRIPE_PAYG_PRICE_ID=${payg.obj.id}`);
console.log(`#   STRIPE_MANAGED_COST_PRICE_ID=${managedCost.obj.id}`);
console.log(
  `\nDone (re-run safe). The ONLY Stripe env required: STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET.`,
);
console.log(
  `The webhook endpoint + Customer Portal are converged above when TERRAGRAM_PUBLIC_URL is set;`,
);
console.log(
  `copy any printed STRIPE_WEBHOOK_SECRET into Railway + .env.local, then re-run is safe.`,
);
