/**
 * Dev helper: create a CONFIRMED email/password user so you can sign in without
 * the GitHub OAuth dance (and without waiting on an email-confirmation link).
 * Then verifies the credential by signing in with the publishable key.
 *
 *   npm run db:test-user                         # test@terragram.dev / terragram-test-1234
 *   npm run db:test-user -- you@example.com pw   # custom email + password
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const publishable =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const email = process.argv[2] || "test@terragram.dev";
const password = process.argv[3] || "terragram-test-1234";

if (!url || !secret) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY in .env.local");
  process.exit(1);
}

const admin = createClient(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// 1. Create (idempotent — a re-run on an existing email is fine).
const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (error && !/already|exists/i.test(`${error.code} ${error.message}`)) {
  console.error("createUser failed:", error.message);
  process.exit(1);
}
console.log(
  error
    ? `User ${email} already exists — continuing.`
    : `Created confirmed user ${email} (${data.user.id}).`,
);

// 2. Verify the credential really signs in (proves the password path end-to-end).
if (!publishable) {
  console.warn("No publishable key — skipping the sign-in verification.");
  process.exit(0);
}
const anon = createClient(url, publishable, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const signIn = await anon.auth.signInWithPassword({ email, password });
if (signIn.error) {
  console.error("Sign-in verification FAILED:", signIn.error.message);
  process.exit(1);
}
console.log(`Sign-in verified ✓  email=${email}  password=${password}`);
