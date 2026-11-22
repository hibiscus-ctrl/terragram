/**
 * Wrap a client behind a lazily-initialized Proxy so its factory — which reads
 * runtime secrets — runs on first *use*, not at import time.
 *
 * Why this exists: `next build` imports every route module to collect page data,
 * evaluating top-level code. A client constructed at module scope (the Supabase
 * service-role client, Stripe) would read its secret right then — but
 * those secrets are runtime-only on the host and absent during the Docker build,
 * so the build crashed with `Reference to undefined env var`. (SES email is no
 * longer constructed this way — it reads creds per-call — but Supabase/Stripe
 * still are.) Deferring
 * construction to the first property access keeps the import side-effect-free;
 * the secret is read at request time, where it exists. A genuinely missing secret
 * then surfaces as a clean error on the one request that needs it, instead of
 * failing the whole build.
 *
 * The returned proxy is a drop-in for the real client — same shape, same usage.
 * Top-level methods are bound to the instance so `this` is preserved when a
 * method is destructured or passed around.
 */
export function lazyClient<T extends object>(factory: () => T): T {
  let instance: T | undefined;
  const resolve = (): T => (instance ??= factory());

  return new Proxy({} as T, {
    get(_target, prop) {
      const target = resolve() as Record<PropertyKey, unknown>;
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
    has(_target, prop) {
      return prop in resolve();
    },
  });
}
