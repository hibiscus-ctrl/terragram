// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assembleModel } from "terragram-engine/engine";
import { type HclBlock, parseHcl } from "terragram-engine/hcl";
import { isDeadLetterTopic } from "terragram-engine/kinds";
import { parseTerraform } from "terragram-engine/parse";
import { emitTerraform } from "terragram-engine/terraform";

/**
 * A Pub/Sub queue is a topic, a subscription and the topic the subscription gives up on, and reads back
 * as one node. Only the dead-letter topic the generator writes for that queue folds into it: a topic of
 * the file's own is a node of its own, however it is named.
 */

const planOf = (kinds: string[]): string => emitTerraform(assembleModel(kinds, undefined, true).model, "gcp").files[0]?.content ?? "";

const PLAIN = planOf(["queue"]);
const KEYED = planOf(["queue", "key-vault"]);

const queues = (source: string): number => {
  const parsed = parseTerraform(source);
  assert.ok(parsed.ok);
  return parsed.model.nodes.filter((n) => n.kind === "queue").length;
};

/** Whether the block is read as a dead-letter topic; a block the file does not have is not. */
function folded(source: string, name: string): boolean {
  const blocks = parseHcl(source);
  const found = blocks.find((b) => b.type === "resource" && b.labels[0] === "google_pubsub_topic" && b.labels[1] === name);
  return found !== undefined && isDeadLetterTopic(found as HclBlock, blocks);
}

/** One resource block's text, to edit. */
function blockText(source: string, type: string, name: string): string {
  const start = source.indexOf(`resource "${type}" "${name}" {`);
  assert.notEqual(start, -1, `${type}.${name}`);
  return source.slice(start, source.indexOf("\n}\n", start) + 3);
}

describe("a queue's dead-letter topic reads back as part of the queue", () => {
  it("is one queue, not a topic and a second one", () => {
    assert.equal(queues(PLAIN), 1);
    assert.equal(queues(KEYED), 1);
    assert.equal(folded(PLAIN, "queue_dead_letter"), true);
    assert.equal(folded(KEYED, "queue_dead_letter"), true);
    assert.equal(folded(PLAIN, "queue"), false);
  });

  it("leaves nothing untranslated and draws no edge from the queue to its own dead-letter topic", () => {
    const parsed = parseTerraform(KEYED);
    assert.ok(parsed.ok);
    assert.deepEqual(parsed.untranslated, []);
    assert.deepEqual(parsed.model.edges.filter((e) => e.source === e.target), []);
  });

  it("keeps a queue that is the file's own as a node when it is a second, separately named topic", () => {
    const own = `${PLAIN}
resource "google_pubsub_topic" "audit" {
  name = "audit"
}
`;
    assert.equal(queues(own), 2);
  });

  /** The queue's three blocks, written again for a queue of another name. */
  const another = (source: string, label: string, slug: string): string =>
    ["google_pubsub_topic", "google_pubsub_topic", "google_pubsub_subscription"]
      .map((type, i) => blockText(source, type, i === 1 ? "queue_dead_letter" : "queue"))
      .map((text) => text.replace(/queue_dead_letter/g, `${label}_dead_letter`).replace(/google_pubsub_topic\.queue\.id/g, `google_pubsub_topic.${label}.id`).replace(/" "queue"/g, `" "${label}"`).replace(/-queue"/g, `-${slug}"`))
      .join("\n");

  it("folds each queue's dead-letter topic into its own queue when there are several, one's name starting the other's", () => {
    for (const source of [PLAIN, KEYED]) {
      const two = `${source}\n${another(source, "queue_2", "queue-2")}`;
      assert.equal(queues(two), 2);
      assert.equal(folded(two, "queue_dead_letter"), true);
      assert.equal(folded(two, "queue_2_dead_letter"), true);
    }
  });
});

describe("only the dead-letter topic the generator writes is folded", () => {
  const dead = blockText(PLAIN, "google_pubsub_topic", "queue_dead_letter");
  const nearMisses: Array<[string, (b: string) => string]> = [
    ["a name of its own", (b) => b.replace(/dlq-\$\{var\.name_prefix\}-queue/, "orders-failed")],
    ["another retention", (b) => b.replace('"604800s"', '"86400s"')],
    ["an attribute the generator does not write", (b) => b.replace(/\n\}\n$/, '\n  labels = { team = "payments" }\n}\n')],
    ["a nested block", (b) => b.replace(/\n\}\n$/, "\n  message_storage_policy {\n    allowed_persistence_regions = [\"europe-west2\"]\n  }\n}\n")],
    ["a key the main topic does not use", (b) => b.replace(/\n\}\n$/, "\n  kms_key_name = google_kms_crypto_key.other.id\n}\n")],
  ];
  for (const [label, change] of nearMisses) {
    it(`draws a dead-letter topic with ${label}`, () => {
      const source = PLAIN.replace(dead, change(dead));
      assert.notEqual(source, PLAIN, label);
      assert.equal(folded(source, "queue_dead_letter"), false, label);
      assert.equal(queues(source), 2, label);
    });
  }

  it("draws a topic named like a dead-letter topic that no subscription gives up on", () => {
    const sub = blockText(PLAIN, "google_pubsub_subscription", "queue");
    const source = PLAIN.replace(sub, sub.replace(/dead_letter_topic\s+= google_pubsub_topic\.queue_dead_letter\.id/, 'dead_letter_topic = "projects/p/topics/elsewhere"'));
    assert.equal(folded(source, "queue_dead_letter"), false);
    assert.equal(queues(source), 2);
  });

  it("draws a topic named like one when the subscription is not the queue's own", () => {
    const sub = blockText(PLAIN, "google_pubsub_subscription", "queue");
    assert.equal(folded(PLAIN.replace(sub, sub.replace('"google_pubsub_subscription" "queue"', '"google_pubsub_subscription" "other"')), "queue_dead_letter"), false);
    assert.equal(folded(PLAIN.replace(sub, sub.replace(/topic\s+= google_pubsub_topic\.queue\.id/, 'topic = "projects/p/topics/t"')), "queue_dead_letter"), false);
  });

  it("draws a dead-letter topic whose queue has no topic of the generator's name", () => {
    const main = blockText(PLAIN, "google_pubsub_topic", "queue");
    assert.equal(folded(PLAIN.replace(main, main.replace("topic-${var.name_prefix}-queue", "orders")), "queue_dead_letter"), false);
  });

  it("draws a dead-letter topic under another key than its queue's, and one under a key the file lacks", () => {
    const main = blockText(KEYED, "google_pubsub_topic", "queue");
    const dead2 = blockText(KEYED, "google_pubsub_topic", "queue_dead_letter");
    assert.equal(folded(KEYED.replace(main, main.replace(/\n\s+kms_key_name\s+= [^\n]+/, "")), "queue_dead_letter"), false);
    assert.equal(folded(KEYED.replace(dead2, dead2.replace(/kms_key_name\s+= google_kms_crypto_key\.key_vault\.id/, "kms_key_name = google_kms_crypto_key.gone.id")), "queue_dead_letter"), false);
  });

  it("still folds a dead-letter topic that something else is granted on", () => {
    const source = `${KEYED}
resource "google_pubsub_topic_iam_member" "writer" {
  topic  = google_pubsub_topic.queue_dead_letter.name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:x@p.iam.gserviceaccount.com"
}
`;
    // A grant over it is a grant over the queue; the topic itself is still folded.
    assert.equal(folded(source, "queue_dead_letter"), true);
    assert.equal(queues(source), 1);
  });
});

describe("what is granted on a dead-letter topic is granted on its queue", () => {
  it("draws the grant's edge to the queue the topic belongs to, not to the first queue its name starts with", () => {
    const plan = planOf(["queue", "functions"]);
    const second = `${plan}
resource "google_pubsub_topic" "queue_2" {
  name                       = "topic-\${var.name_prefix}-queue-2"
  message_retention_duration = "604800s"
}

resource "google_pubsub_topic" "queue_2_dead_letter" {
  name                       = "dlq-\${var.name_prefix}-queue-2"
  message_retention_duration = "604800s"
}

resource "google_pubsub_subscription" "queue_2" {
  name                         = "sub-\${var.name_prefix}-queue-2"
  topic                        = google_pubsub_topic.queue_2.id
  ack_deadline_seconds         = 30
  message_retention_duration   = "604800s"
  enable_message_ordering      = false
  enable_exactly_once_delivery = false

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.queue_2_dead_letter.id
    max_delivery_attempts = 5
  }

  expiration_policy {
    ttl = ""
  }
}

resource "google_pubsub_topic_iam_member" "writer" {
  topic  = google_pubsub_topic.queue_2_dead_letter.name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:\${google_service_account.functions.email}"
}
`;
    const parsed = parseTerraform(second);
    assert.ok(parsed.ok);
    const queueNodes = parsed.model.nodes.filter((n) => n.kind === "queue").map((n) => n.id);
    assert.equal(queueNodes.length, 2);
    const writes = parsed.model.edges.filter((e) => e.access === "write" && queueNodes.includes(e.target));
    assert.deepEqual(writes.map((e) => e.target), [queueNodes[1]]);
  });
});

describe("a subscription the plan did not write is shown, never absorbed into the queue", () => {
  const sub = blockText(PLAIN, "google_pubsub_subscription", "queue");
  const nodes = (source: string) => {
    const parsed = parseTerraform(source);
    assert.ok(parsed.ok);
    return parsed;
  };
  /** The flagged nodes the file's own subscriptions are drawn as. */
  const flagged = (source: string) =>
    nodes(source)
      .model.nodes.filter((n) => n.kind === "external" && n.label.startsWith("google_pubsub_subscription "))
      .map((n) => n.label);

  const PUSH = `
resource "google_pubsub_subscription" "to_partner" {
  name  = "to-partner"
  topic = google_pubsub_topic.queue.id

  push_config {
    push_endpoint = "https://partner.example.com/hook?token=s3cret-value"
  }
}
`;

  it("leaves the plan's own subscription part of its queue, with nothing flagged", () => {
    for (const source of [PLAIN, KEYED]) {
      assert.deepEqual(flagged(source), []);
      assert.deepEqual(nodes(source).untranslated, []);
    }
  });

  it("draws a push subscription on the queue's topic as a flagged node of its own, and lists it as untranslated", () => {
    const parsed = nodes(`${PLAIN}${PUSH}`);
    assert.equal(queues(`${PLAIN}${PUSH}`), 1);
    assert.deepEqual(flagged(`${PLAIN}${PUSH}`), ["google_pubsub_subscription to_partner"]);
    assert.deepEqual(parsed.untranslated, ["google_pubsub_subscription.to_partner"]);
    const node = parsed.model.nodes.find((n) => n.label === "google_pubsub_subscription to_partner");
    assert.ok(node?.flag?.reason);
    // Only the name of the block reaches the model: not the endpoint, and not the token in it.
    assert.doesNotMatch(JSON.stringify(parsed.model), /partner\.example|s3cret|push_endpoint/);
  });

  it("draws a pull subscription of the file's own, on a topic of its own or the queue's, the same way", () => {
    const own = `
resource "google_pubsub_topic" "audit" {
  name = "audit"
}

resource "google_pubsub_subscription" "audit" {
  name  = "audit-reader"
  topic = google_pubsub_topic.audit.id
}

resource "google_pubsub_subscription" "second_reader" {
  name  = "second-reader"
  topic = google_pubsub_topic.queue.id
}
`;
    assert.deepEqual(flagged(`${PLAIN}${own}`).sort(), ["google_pubsub_subscription audit", "google_pubsub_subscription second_reader"]);
    assert.equal(queues(`${PLAIN}${own}`), 2);
  });

  it("draws a grant on the file's own subscription as a grant on that node, not on the queue", () => {
    const source = `${PLAIN}${PUSH}
resource "google_service_account" "reader" {
  account_id = "reader"
}

resource "google_pubsub_subscription_iam_member" "reader" {
  subscription = google_pubsub_subscription.to_partner.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:\${google_service_account.reader.email}"
}
`;
    const parsed = nodes(source);
    const target = parsed.model.nodes.find((n) => n.label === "google_pubsub_subscription to_partner")?.id;
    const queue = parsed.model.nodes.find((n) => n.kind === "queue")?.id;
    assert.ok(target && queue);
    const grants = parsed.model.edges.filter((e) => e.access !== undefined && e.access !== "runs-as");
    assert.ok(grants.some((e) => e.target === target));
    assert.ok(!grants.some((e) => e.target === queue));
  });

  it("does not take the plan's own subscription for the plan's once it is changed in anything it writes", () => {
    const changes: Array<[string, (b: string) => string]> = [
      ["a push endpoint", (b) => b.replace(/\n\}\n$/, '\n  push_config {\n    push_endpoint = "https://partner.example.com"\n  }\n}\n')],
      ["a filter", (b) => b.replace(/\n\}\n$/, '\n  filter = "attributes.kind = \\"order\\""\n}\n')],
      ["another acknowledgement deadline", (b) => b.replace("ack_deadline_seconds         = 30", "ack_deadline_seconds         = 600")],
      ["a name of its own", (b) => b.replace(/sub-\$\{var\.name_prefix\}-queue/, "orders-reader")],
      ["no dead-letter policy", (b) => b.replace(/\n {2}dead_letter_policy \{[\s\S]*?\n {2}\}\n/, "\n")],
      ["another attempt limit", (b) => b.replace("max_delivery_attempts = 5", "max_delivery_attempts = 100")],
      ["a topic it names by text", (b) => b.replace(/topic\s+= google_pubsub_topic\.queue\.id/, 'topic = "projects/p/topics/t"')],
      ["ordering and exactly-once that disagree", (b) => b.replace("enable_message_ordering      = false", "enable_message_ordering      = true")],
    ];
    for (const [label, change] of changes) {
      const source = PLAIN.replace(sub, change(sub));
      assert.notEqual(source, PLAIN, label);
      assert.deepEqual(flagged(source), ["google_pubsub_subscription queue"], label);
      assert.deepEqual(nodes(source).untranslated.filter((u) => u.startsWith("google_pubsub_subscription")), ["google_pubsub_subscription.queue"], label);
      // And so the dead-letter topic is no longer part of a queue the plan wrote.
      assert.equal(folded(source, "queue_dead_letter"), false, label);
    }
  });

  it("draws the dead-letter topic of its own when another subscription reads it or gives up on it", () => {
    const readsIt = `${PLAIN}
resource "google_pubsub_subscription" "inspector" {
  name  = "dead-letter-inspector"
  topic = google_pubsub_topic.queue_dead_letter.id
}
`;
    assert.equal(folded(readsIt, "queue_dead_letter"), false);
    assert.equal(queues(readsIt), 2);
    assert.ok(flagged(readsIt).includes("google_pubsub_subscription inspector"));

    const givesUpOnIt = `${PLAIN}
resource "google_pubsub_subscription" "other" {
  name  = "other"
  topic = google_pubsub_topic.queue.id

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.queue_dead_letter.id
    max_delivery_attempts = 5
  }
}
`;
    assert.equal(folded(givesUpOnIt, "queue_dead_letter"), false);
    assert.equal(queues(givesUpOnIt), 2);
    assert.ok(flagged(givesUpOnIt).includes("google_pubsub_subscription other"));

    const byText = `${PLAIN}
resource "google_pubsub_subscription" "by_name" {
  name  = "by-name"
  topic = "projects/p/topics/\${google_pubsub_topic.queue_dead_letter.name}"
}
`;
    assert.equal(folded(byText, "queue_dead_letter"), false);
  });

  it("folds a dead-letter topic that only a word of another subscription's text mentions", () => {
    const mention = `${PLAIN}
resource "google_pubsub_subscription" "note" {
  name   = "note"
  topic  = google_pubsub_topic.queue.id
  labels = { about = "google_pubsub_topic.queue_dead_letter.id" }
}
`;
    assert.equal(folded(mention, "queue_dead_letter"), true);
    assert.ok(flagged(mention).includes("google_pubsub_subscription note"));
  });
});
