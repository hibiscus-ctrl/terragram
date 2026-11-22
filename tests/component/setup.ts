// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DOM setup for component tests.
 *
 * The rest of the suite is `node --test` over pure modules; components need a DOM
 * and JSX, neither of which Node's type-stripping provides. `tsx` supplies the JSX
 * transform (as a loader, so no build step) and happy-dom supplies the globals —
 * both only for `tests/component`, so the fast pure suite stays exactly as it was.
 *
 * Imported for its side effects by every component test, before React is touched:
 * React reads `document` at import time, so registering afterwards is too late.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!globalThis.document) {
  GlobalRegistrator.register({ url: "http://localhost:3000/" });
}

// React Flow and anything measuring layout expect these; happy-dom ships neither,
// and their absence throws during render rather than degrading.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

if (!globalThis.matchMedia) {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof matchMedia;
}

// React 19 checks this to decide whether `act` warnings apply.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
