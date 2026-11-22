import assert from "node:assert/strict";
import { test } from "node:test";

import { formatDate, formatDateTime, relativeTime } from "@/utils/format-date";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

test("formats in en-GB and UTC whatever the process locale and zone", () => {
  // 23:30 UTC is already the next day east of UTC; the output must not follow the host.
  assert.equal(formatDate("2026-10-10T23:30:00Z"), "10 Oct 2026");
  assert.equal(formatDateTime("2026-10-10T23:30:00Z"), "10 Oct 2026, 23:30 UTC");
});

test("answers empty, not 'Invalid Date' or a throw, for an unparseable timestamp", () => {
  assert.equal(formatDate("nope"), "");
  assert.equal(formatDateTime("nope"), "");
  assert.equal(relativeTime("nope", NOW), "");
});

test("relativeTime measures from the clock it is given", () => {
  assert.equal(relativeTime(ago(20_000), NOW), "just now");
  // 30s rounds up to a minute: the boundary the server and browser used to disagree on.
  assert.equal(relativeTime(ago(30_000), NOW), "1m ago");
  assert.equal(relativeTime(ago(5 * 60_000), NOW), "5m ago");
  assert.equal(relativeTime(ago(2 * 3_600_000), NOW), "2h ago");
  assert.equal(relativeTime(ago(30 * 3_600_000), NOW), "yesterday");
  assert.equal(relativeTime(ago(3 * 86_400_000), NOW), "3d ago");
  assert.equal(relativeTime("2026-01-02T00:00:00Z", NOW), "2 Jan 2026");
});
