// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/** @jsxRuntime automatic @jsxImportSource react */
import "./setup.ts";

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { NodeInspector } from "../../src/components/workspace/node-inspector.tsx";
import { fieldsForKind } from "../../src/features/workspace/inspector.ts";
import type { ModelNode } from "../../src/features/workspace/model.ts";

/**
 * The inspector is what makes the review gate real: a flagged node asks for the
 * missing attribute, the reviewer chooses one, "Mark resolved" clears the flag, and
 * the emitted Terraform reflects that choice. Every assertion here is about the
 * contract the parent relies on — which callback fires, with which arguments —
 * because that is what the rest of the workspace is coupled to.
 */

function nodeOf(overrides: Partial<ModelNode> = {}): ModelNode {
  return {
    id: "db-1",
    kind: "postgres",
    category: "storage",
    label: "Orders DB",
    ...overrides,
  } as ModelNode;
}

const noop = () => {};

function renderInspector(node: ModelNode, handlers: Record<string, unknown> = {}) {
  const calls: Record<string, unknown[][]> = {
    label: [],
    attribute: [],
    resolve: [],
    close: [],
    delete: [],
  };
  render(
    <NodeInspector
      node={node}
      onClose={() => calls.close.push([])}
      onLabelChange={(...a) => calls.label.push(a)}
      onAttributeChange={(...a) => calls.attribute.push(a)}
      onResolve={(...a) => calls.resolve.push(a)}
      onDelete={(...a) => calls.delete.push(a)}
      {...handlers}
    />,
  );
  return calls;
}

afterEach(() => {
  cleanup();
});

describe("NodeInspector", () => {
  it("shows the node's label", () => {
    renderInspector(nodeOf());
    const input = screen.getByDisplayValue("Orders DB");
    assert.ok(input, "the label should be editable and pre-filled");
  });

  it("reports a renamed label to the parent on blur", () => {
    const calls = renderInspector(nodeOf());
    const input = screen.getByDisplayValue("Orders DB");
    fireEvent.change(input, { target: { value: "Billing DB" } });
    fireEvent.blur(input);
    assert.deepEqual(calls.label, [["db-1", "Billing DB"]]);
  });

  it("does not report a rename that only added whitespace", () => {
    // The parent writes a snapshot per change; a no-op rename would record an
    // edit that changes nothing and show up in the workspace history as one.
    const calls = renderInspector(nodeOf());
    const input = screen.getByDisplayValue("Orders DB");
    fireEvent.change(input, { target: { value: "  Orders DB  " } });
    fireEvent.blur(input);
    assert.deepEqual(calls.label, [], "a whitespace-only change is not a rename");
  });

  it("does not report an empty label", () => {
    const calls = renderInspector(nodeOf());
    const input = screen.getByDisplayValue("Orders DB");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    assert.deepEqual(calls.label, [], "a node must not be left unnamed");
    assert.equal(
      (screen.getByDisplayValue("Orders DB") as HTMLInputElement).value,
      "Orders DB",
      "and the field should snap back to the real label",
    );
  });

  it("re-syncs the draft when the selected node changes underneath it", () => {
    // Chat can rewrite the model while the inspector is open; showing the previous
    // node's name over the new node's attributes is how a reviewer approves the
    // wrong thing.
    const { rerender } = render(
      <NodeInspector
        node={nodeOf()}
        onClose={noop}
        onLabelChange={noop}
        onAttributeChange={noop}
        onResolve={noop}
        onDelete={noop}
      />,
    );
    rerender(
      <NodeInspector
        node={nodeOf({ id: "db-2", label: "Renamed elsewhere" })}
        onClose={noop}
        onLabelChange={noop}
        onAttributeChange={noop}
        onResolve={noop}
        onDelete={noop}
      />,
    );
    assert.ok(screen.getByDisplayValue("Renamed elsewhere"));
  });

  it("reports an attribute choice with the node id and field key", () => {
    const node = nodeOf();
    const fields = fieldsForKind(node.kind);
    const choice = fields.find((f) => (f.options?.length ?? 0) > 0);
    if (!choice) return; // kind registry has no option-bearing field for this kind

    const calls = renderInspector(node);
    const select = screen.getByLabelText(choice.key) as HTMLSelectElement;
    const value = choice.options?.[1] ?? choice.options?.[0];
    fireEvent.change(select, { target: { value } });

    assert.deepEqual(calls.attribute, [["db-1", choice.key, value]]);
  });

  it("offers Mark resolved only for a flagged node", () => {
    renderInspector(nodeOf());
    assert.equal(screen.queryByText(/mark resolved/i), null, "a clear node has nothing to resolve");

    cleanup();
    const calls = renderInspector(nodeOf({ flag: { reason: "Pick a compute tier." } }));
    const button = screen.getByText(/mark resolved/i);
    fireEvent.click(button);
    assert.deepEqual(calls.resolve, [["db-1"]]);
  });

  it("reports close and delete against the right node", () => {
    const calls = renderInspector(nodeOf());
    fireEvent.click(screen.getByLabelText("Close inspector"));
    assert.equal(calls.close.length, 1);
    fireEvent.click(screen.getByText(/remove from diagram/i));
    assert.deepEqual(calls.delete, [["db-1"]]);
  });
});
