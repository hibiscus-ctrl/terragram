import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { CONSENT_COOKIE } from "@/config/analytics";

// The Cypress support commands pre-record consent under a copied cookie name. If
// the app's name changes and the copy does not, the banner returns in every
// spec and covers low-sitting elements only where a GA id is set.
test("the Cypress support commands pre-set the app's consent cookie", () => {
  const support = readFileSync("cypress/support/commands.ts", "utf8");
  assert.match(support, new RegExp(`CONSENT_COOKIE = "${CONSENT_COOKIE}"`));
});
