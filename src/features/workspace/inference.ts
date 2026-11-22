// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import { type ComposeResult } from "terragram-engine/engine";
import type { ManagedModelId } from "terragram-engine/managed-models";
import {
  extractToolUse,
  resolveManagedModel,
  runManagedCompose as composeManaged,
  toolNameOf,
} from "terragram-engine/managed-compose";
import { EMPTY_MODEL, type InfraModel } from "terragram-engine/model";
import { ManagedCapReachedError, type ModelClient } from "terragram-engine/ports";

import { overManagedCap } from "@/features/billing/managed-meter";
import { isModelProxyConfigured, mintProxyToken, type ProxyToken } from "@/features/billing/proxy";

export { ManagedCapReachedError };

/**
 * Managed UK inference for Chat → Model: the host side. The engine
 * (`terragram-engine/managed-compose`) decides what the model is asked and reads its
 * answer; this file is the `ModelClient` it is given — it enforces the spend cap,
 * mints the `tmpx_` HMAC token, posts to the EU Bedrock gateway's Anthropic
 * `/v1/messages` endpoint and reports the mint to the ledger.
 */

/**
 * The model specifier a managed turn resolves to: the user's choice, else this
 * deployment's configured default (`TERRAGRAM_WORKSPACE_MODEL`), else Sonnet. The
 * validation lives in the engine's `resolveManagedModel`; the environment read is the
 * host's.
 */
export function resolvedModel(override?: string): ManagedModelId {
  return resolveManagedModel(override, process.env.TERRAGRAM_WORKSPACE_MODEL);
}

/** Injected for tests so the client can run without a live gateway. */
export type InferenceDeps = {
  fetchImpl?: typeof fetch;
  mint?: (orgId: string, model?: string | null, budgetPence?: number) => ProxyToken;
  /** Full managed spend this cycle, pence. Injected so the cap is testable without a DB. */
  cycleSpendPence?: (orgId: string) => Promise<number>;
  /** The org's cycle ceiling, pence. */
  capPence?: (orgId: string) => Promise<number>;
};

/**
 * Record the `managed_mint` ledger row for a token just minted, with the budget it
 * carried. Required rather than defaulted: the binding needs Next's `after()` so
 * the runtime awaits the write, which is the caller's (a route's) to supply.
 */
export type MintLedger = (orgId: string, budgetPence: number) => void;

/**
 * The two spend-cap reads, from the caller's deps or the billing module.
 *
 * The billing module is imported on use rather than at the top of this file: it
 * pulls in the service-role Supabase client, and keeping that out of the module
 * graph is what lets the compose logic be exercised by a plain unit test.
 */
async function capReads(deps: InferenceDeps | undefined): Promise<{
  cycleSpendPence: (orgId: string) => Promise<number>;
  capPence: (orgId: string) => Promise<number>;
}> {
  if (deps?.cycleSpendPence && deps?.capPence) {
    return { cycleSpendPence: deps.cycleSpendPence, capPence: deps.capPence };
  }
  const billing = await import("@/features/billing/managed-usage");
  return {
    cycleSpendPence: deps?.cycleSpendPence ?? billing.managedCycleSpendPence,
    capPence: deps?.capPence ?? billing.managedCapPence,
  };
}

/** Whether the managed engine can run in this deployment (proxy configured). */
export function isManagedInferenceConfigured(): boolean {
  return isModelProxyConfigured();
}

/**
 * One managed call with a forced tool: enforce the spend cap, mint a token carrying
 * the remaining budget, post the request to the gateway and return the tool's
 * input. Shared by chat → model and the diagram reader so both pay the same way
 * and neither can mint without the cap.
 */
async function managedToolCall(args: {
  orgId: string;
  request: { model: string } & Record<string, unknown>;
  recordMint: MintLedger;
  deps?: InferenceDeps | undefined;
}): Promise<unknown> {
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const mint = args.deps?.mint ?? mintProxyToken;
  const { cycleSpendPence: cycleSpend, capPence: cap } = await capReads(args.deps);

  // The spend cap, enforced here because this is the only place a token is minted.
  // Both reads fail CLOSED: an unreadable ledger refuses the call rather than
  // minting blind, because a managed call spends real Bedrock money.
  const [spendPence, capPence] = await Promise.all([cycleSpend(args.orgId), cap(args.orgId)]);
  if (overManagedCap(spendPence, capPence)) throw new ManagedCapReachedError();

  // The remaining budget rides in the signed claims so the gateway enforces the cap
  // for the token's whole TTL — without it, a token minted one pence under the cap
  // could spend unbounded for an hour.
  const budgetPence = Math.max(0, capPence - spendPence);
  const credential = mint(args.orgId, args.request.model, budgetPence);

  // Mint ledger (reconciliation signal): a mint with no `managed_cost` report in
  // the window is the "gateway spent but never reported" smell the reconcile job
  // looks for. Recorded after the mint returns, so a mint that threw leaves no row.
  // Guarded here rather than trusting every binding to be best-effort: a throw
  // escaping would fail a managed call whose token is already signed.
  try {
    args.recordMint(args.orgId, budgetPence);
  } catch {
    // Nothing to do: the row is a reconciliation hint, not the call's business.
  }

  const url = `${credential.endpoint.replace(/\/$/, "")}/v1/messages`;

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${credential.token}`,
    },
    body: JSON.stringify(args.request),
  });

  if (!response.ok) {
    throw new Error(`managed inference failed: ${response.status}`);
  }

  const data: unknown = await response.json();
  return extractToolUse(data, toolNameOf(args.request));
}

/**
 * The managed `ModelClient` for one org: every call goes through `managedToolCall`,
 * so it enforces the cap, mints and meters like any other managed call.
 */
export function managedModelClient(args: {
  orgId: string;
  recordMint: MintLedger;
  deps?: InferenceDeps | undefined;
}): ModelClient {
  return {
    toolCall: (request) =>
      managedToolCall({ orgId: args.orgId, request, recordMint: args.recordMint, deps: args.deps }),
  };
}

/**
 * Translate a plain-English instruction into the model via managed inference.
 * Throws on transport/parse failure so the caller can fall back to the stub.
 */
export async function runManagedCompose(args: {
  orgId: string;
  prompt: string;
  prev?: InfraModel;
  model?: string;
  recordMint: MintLedger;
  deps?: InferenceDeps;
}): Promise<ComposeResult> {
  return composeManaged({
    client: managedModelClient({ orgId: args.orgId, recordMint: args.recordMint, deps: args.deps }),
    prompt: args.prompt,
    prev: args.prev ?? EMPTY_MODEL,
    model: resolvedModel(args.model),
  });
}
