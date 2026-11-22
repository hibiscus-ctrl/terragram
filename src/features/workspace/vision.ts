// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import {
  type DiagramImage,
  type DiagramReadResult,
  runManagedDiagramRead as readDiagram,
} from "terragram-engine/vision";

import { type InferenceDeps, managedModelClient, type MintLedger, resolvedModel } from "./inference.ts";

/**
 * Managed diagram reading, host side. The engine (`terragram-engine/vision`) builds
 * the picture request and turns the reading into a model; this binds it to the managed
 * gateway, so the diagram reader pays the same way a chat turn does and cannot mint
 * without the spend cap.
 */
export async function runManagedDiagramRead(args: {
  orgId: string;
  image: DiagramImage;
  model?: string;
  recordMint: MintLedger;
  deps?: InferenceDeps;
}): Promise<DiagramReadResult> {
  // Same gate as a chat turn: the diagram reader reaches the same proxy, so it
  // cannot be the path that forwards an unserved model id.
  return readDiagram({
    client: managedModelClient({ orgId: args.orgId, recordMint: args.recordMint, deps: args.deps }),
    image: args.image,
    model: resolvedModel(args.model),
  });
}
