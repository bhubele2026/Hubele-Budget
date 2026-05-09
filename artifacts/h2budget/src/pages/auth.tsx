import { useState } from "react";
import { Redirect } from "wouter";
import { SignIn, SignUp, Show } from "@clerk/react";
import { useCheckInvitation } from "@workspace/api-client-react";
import { Mail } from "lucide-react";
import { H2Logo } from "@/components/h2-logo";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function PendingInvitationCheck() {
  const [email, setEmail] = useState("");
  const [result, setResult] = useState<
    | { kind: "idle" }
    | { kind: "pending"; email: string }
    | { kind: "none"; email: string }
    | { kind: "error" }
  >({ kind: "idle" });
  const checkInvitation = useCheckInvitation();

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;
    checkInvitation.mutate(
      { data: { email: trimmed } },
      {
        onSuccess: (data) => {
          setResult(
            data.hasPending
              ? { kind: "pending", email: data.email }
              : { kind: "none", email: data.email },
          );
        },
        onError: () => setResult({ kind: "error" }),
      },
    );
  };

  return (
    <div
      className="bg-card rounded-2xl w-[440px] max-w-full overflow-hidden shadow-xl p-6 text-sm space-y-3"
      data-testid="card-pending-invite-check"
    >
      <div className="flex items-start gap-2">
        <Mail className="w-4 h-4 mt-0.5 text-muted-foreground shrink-0" />
        <div>
          <p className="font-semibold text-foreground">Were you invited?</p>
          <p className="text-muted-foreground">
            This app is invite-only. If you were invited, you must open the
            link in your invitation email — signing in here won&apos;t work
            until you accept the invite.
          </p>
        </div>
      </div>
      <form onSubmit={onSubmit} className="flex gap-2" data-testid="form-check-invite">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className="flex-1 h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="input-check-invite-email"
        />
        <button
          type="submit"
          disabled={checkInvitation.isPending}
          className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50"
          data-testid="button-check-invite"
        >
          {checkInvitation.isPending ? "Checking..." : "Check"}
        </button>
      </form>
      {result.kind === "pending" && (
        <div
          className="rounded-md border border-emerald-500/40 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300 px-3 py-2"
          data-testid="text-invite-pending"
        >
          You have a pending invitation for <strong>{result.email}</strong>.
          Please open the invitation email we sent and click the link to
          finish creating your account.
        </div>
      )}
      {result.kind === "none" && (
        <div
          className="rounded-md border border-border bg-muted/30 text-muted-foreground px-3 py-2"
          data-testid="text-invite-none"
        >
          No pending invitation found for <strong>{result.email}</strong>.
          Ask the family owner to send you an invite.
        </div>
      )}
      {result.kind === "error" && (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2"
          data-testid="text-invite-error"
        >
          Couldn&apos;t check right now. Please try again.
        </div>
      )}
    </div>
  );
}

function AuthBrandHeader() {
  return (
    <div
      className="flex flex-col items-center gap-3 mb-2 text-center"
      data-testid="auth-brand-header"
    >
      <H2Logo className="w-12 h-12 rounded-lg" />
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          H2 Budget
        </h1>
        <p className="text-sm text-muted-foreground">
          Family finance, focused.
        </p>
      </div>
    </div>
  );
}

export function SignInPage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background p-4 gap-5">
      <AuthBrandHeader />
      <SignIn
        path={`${basePath}/sign-in`}
        routing="path"
        signUpUrl={`${basePath}/sign-up`}
      />
      <PendingInvitationCheck />
    </div>
  );
}

export function SignUpPage() {
  // The invitation flow lands at `/sign-up?__clerk_ticket=…`, but Clerk's
  // own internal navigation pushes the user through sub-paths like
  // `/sign-up/verify-email-address` and `/sign-up/continue` *without*
  // re-attaching the original query string. If we recompute `hasTicket`
  // from `window.location.search` on every render, the redirect fires
  // mid-flow and unmounts the <SignUp> component, leaving the user
  // staring at Clerk's "Just a moment" loader forever. Latching the
  // decision once on mount keeps the SignUp surface mounted for the
  // whole invite hand-off.
  const [hasTicket] = useState(() => {
    if (typeof window === "undefined") return false;
    const params = new URLSearchParams(window.location.search);
    if (params.has("__clerk_ticket") || params.has("__clerk_invitation_token")) {
      return true;
    }
    // If the user lands on (or refreshes) a Clerk sub-path like
    // `/sign-up/verify-email-address`, treat it as in-flow too — only
    // the bare `/sign-up` URL with no ticket should bounce to sign-in.
    return window.location.pathname.replace(/\/+$/, "") !== `${basePath}/sign-up`;
  });
  if (!hasTicket) {
    return <Redirect to="/sign-in" />;
  }
  return (
    <>
      {/* Once Clerk finishes accepting the invite ticket the user is
          signed in, but the <SignUp> component has nothing left to
          render and just sits on its "Just a moment" loader forever.
          Forcing a redirect to /dashboard the moment the session
          appears is what actually unblocks the invitation flow. */}
      <Show when="signed-in">
        <Redirect to="/dashboard" />
      </Show>
      <Show when="signed-out">
        <div className="min-h-screen flex flex-col items-center justify-center bg-background p-4 gap-5">
          <AuthBrandHeader />
          <SignUp
            path={`${basePath}/sign-up`}
            routing="path"
            signInUrl={`${basePath}/sign-in`}
            forceRedirectUrl={`${basePath}/dashboard`}
            fallbackRedirectUrl={`${basePath}/dashboard`}
          />
        </div>
      </Show>
    </>
  );
}
