"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Eye, EyeOff, KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { LogoMark } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { withNext } from "@/features/account/controllers/auth-next-core";
import type { ActionResponse } from "@/types/action-response";

const titleMap = {
  login: "Sign in to Terragram",
  signup: "Create your Terragram account",
} as const;

const subtitleMap = {
  login: "Pick up your workspaces, diagrams and evidence receipts where you left off.",
  signup:
    "Describe what you need, review the model, and generate Terraform with a signed evidence receipt — UK (London)-resident, free to start.",
} as const;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function GitHubIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" width={18} height={18} fill="currentColor" aria-hidden {...props}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function GoogleIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 48 48" width={18} height={18} aria-hidden {...props}>
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

export function AuthUI({
  mode,
  signInWithOAuth,
  signInWithPassword,
  signUpWithPassword,
  signInWithSso,
  googleEnabled = false,
  githubEnabled = false,
  notice,
  next,
}: {
  mode: "login" | "signup";
  signInWithOAuth: (provider: "github" | "google", next?: string) => Promise<ActionResponse>;
  signInWithPassword: (email: string, password: string) => Promise<ActionResponse>;
  signUpWithPassword: (email: string, password: string, next?: string) => Promise<ActionResponse>;
  signInWithSso?: (email: string, next?: string) => Promise<ActionResponse>;
  /** Show the Google button only once the provider is configured in Supabase. */
  googleEnabled?: boolean;
  /** Same for GitHub — hidden until the Supabase GitHub provider exists. */
  githubEnabled?: boolean;
  /** An informational banner shown above the form (e.g. "you already have an account"). */
  notice?: string | undefined;
  /** Where a sign-in or sign-up lands instead of the default (an already-vetted
   *  same-site path, e.g. the invite link that sent the visitor here). A password
   *  sign-in goes there itself; OAuth, SSO and an emailed confirmation hand it to
   *  the server, which re-vets it. */
  next?: string | undefined;
}) {
  const router = useRouter();
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [oauthPending, setOauthPending] = useState<"github" | "google" | null>(null);
  const [ssoPending, setSsoPending] = useState(false);
  const [pending, setPending] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const providerLabel = { github: "GitHub", google: "Google" } as const;
  // No configured provider means no "or" rule and no buttons — the card is just
  // the password form rather than a divider introducing nothing.
  const anyOauth = githubEnabled || googleEnabled;

  async function handleOAuth(provider: "github" | "google") {
    setFormError(null);
    setOauthPending(provider);
    const response = await signInWithOAuth(provider, next);
    // On success the action redirects to the provider (this never returns); only an
    // error comes back here.
    if (response && !response.ok) {
      setFormError(`Could not start ${providerLabel[provider]} sign-in. Please try again.`);
      setOauthPending(null);
    }
  }

  async function handleSso() {
    if (!signInWithSso) return;
    setFormError(null);
    setEmailError(null);
    if (!EMAIL_RE.test(email)) {
      setEmailError("Enter your work email to use SSO.");
      emailRef.current?.focus();
      return;
    }
    setSsoPending(true);
    const response = await signInWithSso(email, next);
    // On success the action redirects to the IdP (this never returns); only an error
    // (no IdP for that domain) comes back.
    if (response && !response.ok) {
      setFormError(response.error || "Could not start SSO sign-in.");
      setSsoPending(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setEmailError(null);
    setPasswordError(null);
    setFormError(null);

    // Validate inline, then focus the first invalid field (WCAG focus management).
    let firstInvalid: HTMLInputElement | null = null;
    if (!EMAIL_RE.test(email)) {
      setEmailError("Enter a valid email address.");
      firstInvalid ??= emailRef.current;
    }
    if (password.length < 8) {
      setPasswordError("Password must be at least 8 characters.");
      firstInvalid ??= passwordRef.current;
    }
    if (firstInvalid) {
      firstInvalid.focus();
      return;
    }

    setPending(true);
    if (mode === "login") {
      const res = await signInWithPassword(email, password);
      if (!res.ok) {
        setFormError(res.error || "Could not sign in. Please try again.");
        setPending(false);
        passwordRef.current?.focus();
        return;
      }
      router.push(next ?? res.redirectTo ?? "/login");
      router.refresh();
      return;
    }

    const res = await signUpWithPassword(email, password, next);
    if (!res.ok) {
      setFormError(res.error || "Could not create your account. Please try again.");
      setPending(false);
      // Already-registered (incl. GitHub/Google-only): send them to sign in, where a
      // notice explains their methods share one account (Supabase auto-links by email).
      if (res.code === "already_exists") {
        const login = withNext("/login", next);
        router.push(`${login}${login.includes("?") ? "&" : "?"}exists=1`);
      }
      return;
    }
    if (res.needsConfirmation) {
      toast.success("Check your email to confirm your account, then sign in.");
      setPending(false);
      router.push(withNext("/login", next));
      return;
    }
    router.push(next ?? res.redirectTo ?? "/login");
    router.refresh();
  }

  const busy = pending || oauthPending !== null || ssoPending;

  return (
    <div className="w-full max-w-[420px]">
      <div className="mb-7 flex flex-col items-center gap-4 text-center">
        <LogoMark className="size-11 rounded-lg" />
        <div>
          <h1 className="text-2xl font-extrabold tracking-[-0.025em]">{titleMap[mode]}</h1>
          <p className="mx-auto mt-2 max-w-[340px] text-sm leading-relaxed text-muted-foreground">
            {subtitleMap[mode]}
          </p>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card p-6 shadow-[0_8px_30px_rgba(40,30,18,0.06)]">
        {notice && (
          <p className="mb-4 rounded-lg border border-border bg-surface-subtle px-3.5 py-2.5 text-xs leading-relaxed text-muted-foreground">
            {notice}
          </p>
        )}
        <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-3.5">
          {formError && (
            <p
              role="alert"
              className="rounded-lg border border-danger-border bg-danger-bg px-3.5 py-2.5 text-xs font-medium text-danger"
            >
              {formError}
            </p>
          )}
          <div>
            <Label htmlFor="email" className="mb-1.5">
              Email
            </Label>
            <input
              ref={emailRef}
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={emailError ? true : undefined}
              aria-describedby={emailError ? "email-error" : undefined}
              placeholder="you@company.com"
              className="h-11 w-full rounded-lg border border-input bg-surface-subtle px-3.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30 aria-invalid:border-destructive aria-invalid:ring-destructive/25"
            />
            {emailError && (
              <p id="email-error" className="mt-1.5 text-xs font-medium text-danger">
                {emailError}
              </p>
            )}
          </div>
          <div>
            <Label htmlFor="password" className="mb-1.5">
              Password
            </Label>
            <div className="relative">
              <input
                ref={passwordRef}
                id="password"
                type={show ? "text" : "password"}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={passwordError ? true : undefined}
                aria-describedby={passwordError ? "password-error" : undefined}
                placeholder={mode === "signup" ? "At least 8 characters" : "••••••••"}
                className="h-11 w-full rounded-lg border border-input bg-surface-subtle px-3.5 pr-11 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30 aria-invalid:border-destructive aria-invalid:ring-destructive/25"
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                aria-label={show ? "Hide password" : "Show password"}
                className="absolute top-1/2 right-3 -translate-y-1/2 rounded-md p-1 text-muted-foreground hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none"
              >
                {show ? (
                  <EyeOff className="size-4" aria-hidden />
                ) : (
                  <Eye className="size-4" aria-hidden />
                )}
              </button>
            </div>
            {passwordError && (
              <p id="password-error" className="mt-1.5 text-xs font-medium text-danger">
                {passwordError}
              </p>
            )}
            {mode === "login" && anyOauth && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                Trouble signing in? If you started with{" "}
                {githubEnabled && <span className="font-semibold">GitHub</span>}
                {githubEnabled && googleEnabled && " or "}
                {googleEnabled && <span className="font-semibold">Google</span>}, use that button
                below — it&rsquo;s the same identity.
              </p>
            )}
          </div>
          <Button
            type="submit"
            size="lg"
            className="mt-1 w-full"
            loading={pending}
            disabled={oauthPending !== null}
          >
            {mode === "login" ? "Sign in" : "Create account"}
          </Button>
        </form>

        {anyOauth && (
          <div className="my-4 flex items-center gap-3 text-2xs font-semibold tracking-[0.05em] text-muted-foreground uppercase">
            <span className="h-px flex-1 bg-border" /> or <span className="h-px flex-1 bg-border" />
          </div>
        )}

        {githubEnabled && (
          <Button
            variant="dark"
            size="lg"
            className="w-full"
            onClick={() => handleOAuth("github")}
            disabled={busy}
          >
            {oauthPending === "github" ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <GitHubIcon />
            )}
            Continue with GitHub
          </Button>
        )}

        {googleEnabled && (
          <Button
            variant="outline"
            size="lg"
            className="mt-3 w-full"
            onClick={() => handleOAuth("google")}
            disabled={busy}
          >
            {oauthPending === "google" ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <GoogleIcon />
            )}
            Continue with Google
          </Button>
        )}

        {anyOauth && (
          <p className="mt-3 text-center text-xs leading-relaxed text-muted-foreground">
            However you sign in, it is one account — connecting a Git host for pull requests is a
            separate step inside the workspace.
          </p>
        )}

        {mode === "login" && signInWithSso && (
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="mt-3 w-full"
            onClick={handleSso}
            disabled={busy}
          >
            {ssoPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <KeyRound className="size-4" aria-hidden />
            )}
            Sign in with SSO
          </Button>
        )}
      </div>

      <p className="mt-5 text-center text-xs text-muted-foreground">
        {mode === "signup" ? (
          <>
            Already have an account?{" "}
            <Link href={withNext("/login", next)} className="font-semibold text-primary hover:underline">
              Sign in
            </Link>
          </>
        ) : (
          <>
            New to Terragram?{" "}
            <Link href={withNext("/signup", next)} className="font-semibold text-primary hover:underline">
              Create an account
            </Link>
          </>
        )}
      </p>

      {mode === "signup" && (
        <p className="mx-auto mt-4 max-w-[360px] text-center text-xs leading-relaxed text-muted-foreground">
          By continuing you agree to our{" "}
          <Link href="/terms" className="underline">
            Terms of Service
          </Link>{" "}
          and{" "}
          <Link href="/privacy" className="underline">
            Privacy Policy
          </Link>
          .
        </p>
      )}
    </div>
  );
}
