/**
 * Result shape for the auth server actions (`src/app/(auth)/auth-actions.ts`) —
 * the same `ok` union every feature action returns, plus the auth-specific
 * extras: `needsConfirmation` (signup with email confirmation on) and a
 * machine-readable `code` (`"already_exists"` drives the sign-in redirect).
 */
export type ActionResponse =
  | { ok: true; needsConfirmation?: boolean; redirectTo?: string }
  | { ok: false; error: string; code?: string };
