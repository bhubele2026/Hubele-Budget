import { useState } from "react";
import { Redirect } from "wouter";
import { SignIn, SignUp, Show } from "@clerk/react";
import { useCheckInvitation } from "@workspace/api-client-react";
import { Mail, LineChart, Layers, ShieldCheck } from "lucide-react";
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
      className="bg-card border border-card-border rounded-2xl w-[440px] max-w-full overflow-hidden shadow-sm p-5 text-sm space-y-3"
      data-testid="card-pending-invite-check"
    >
      <div className="flex items-start gap-2.5">
        <Mail className="w-4 h-4 mt-0.5 text-accent-foreground shrink-0" />
        <div>
          <p className="font-semibold text-foreground">Invited recently?</p>
          <p className="text-muted-foreground">
            H2 Budget is invite-only. Open the link from your invitation
            email to finish setting up your account — signing in here
            won&apos;t work until the invite is accepted.
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
          {checkInvitation.isPending ? "Checking…" : "Check"}
        </button>
      </form>
      {result.kind === "pending" && (
        <div
          className="rounded-md border border-positive/40 bg-positive/10 text-positive px-3 py-2"
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

function MarketingHero() {
  return (
    <div
      className="hidden lg:flex flex-col justify-between h-full p-12 xl:p-16"
      data-testid="auth-marketing-hero"
    >
      <div className="flex items-center gap-3">
        <H2Logo className="w-9 h-9 rounded-md" />
        <span className="text-base font-semibold tracking-tight text-foreground">
          H2 Budget
        </span>
      </div>

      <div className="space-y-6 max-w-md">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-primary">
          The household, handled
        </p>
        <h1 className="text-4xl xl:text-5xl font-bold tracking-tight text-foreground leading-[1.05]">
          Where your money has nowhere to hide.
        </h1>
        <p className="text-base text-muted-foreground leading-relaxed">
          Every account, every dollar, every &ldquo;where did THAT go&rdquo; —
          tracked, forecast, and roasted. Built for the two of you.
        </p>
      </div>

      <dl className="grid grid-cols-1 gap-4 max-w-md">
        <HeroBullet
          icon={<LineChart className="w-4 h-4" />}
          title="Forecast, not guesswork"
          body="See the dips before they hit — bills, paychecks, and buckets as one running balance."
        />
        <HeroBullet
          icon={<Layers className="w-4 h-4" />}
          title="A coach that won't sugarcoat it"
          body="Over budget? You'll hear about it. Crushing it? You'll hear about that too."
        />
        <HeroBullet
          icon={<ShieldCheck className="w-4 h-4" />}
          title="Just the two of you"
          body="Invite-only. No public sign-ups, no nosy in-laws."
        />
      </dl>
    </div>
  );
}

function HeroBullet({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="flex items-center justify-center w-7 h-7 rounded-md bg-accent text-accent-foreground shrink-0 mt-0.5">
        {icon}
      </span>
      <div className="space-y-0.5">
        <dt className="text-sm font-medium text-foreground">{title}</dt>
        <dd className="text-sm text-muted-foreground leading-snug">{body}</dd>
      </div>
    </div>
  );
}

function MobileBrandHeader() {
  return (
    <div
      className="lg:hidden flex flex-col items-center gap-3 text-center"
      data-testid="auth-brand-header"
    >
      <H2Logo className="w-11 h-11 rounded-lg" />
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          H2 Budget
        </h1>
        <p className="text-sm text-muted-foreground max-w-xs">
          Your money, forecast and roasted. Built for the two of you.
        </p>
      </div>
    </div>
  );
}

function AuthLayout({
  intro,
  children,
}: {
  intro: { eyebrow: string; title: string; body: string };
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto grid min-h-screen w-full max-w-[1280px] grid-cols-1 lg:grid-cols-[1.05fr_1fr]">
        <MarketingHero />
        <div className="flex flex-col items-center justify-center px-4 py-10 sm:px-8 lg:px-10 lg:py-12 gap-6 lg:border-l lg:border-border/60">
          <MobileBrandHeader />
          <div className="w-full max-w-[440px] space-y-2 lg:text-left text-center">
            <p
              className="hidden lg:block text-xs font-medium uppercase tracking-[0.18em] text-accent-foreground"
              data-testid="auth-eyebrow"
            >
              {intro.eyebrow}
            </p>
            <h2
              className="text-2xl lg:text-[28px] font-semibold tracking-tight text-foreground"
              data-testid="auth-title"
            >
              {intro.title}
            </h2>
            <p
              className="text-sm text-muted-foreground"
              data-testid="auth-subtitle"
            >
              {intro.body}
            </p>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

export function SignInPage() {
  return (
    <AuthLayout
      intro={{
        eyebrow: "Welcome back",
        title: "Let's see the damage.",
        body: "Pick up right where you left off — the month, the buckets, and the running balance are waiting.",
      }}
    >
      <SignIn
        path={`${basePath}/sign-in`}
        routing="path"
        signUpUrl={`${basePath}/sign-up`}
      />
      <PendingInvitationCheck />
    </AuthLayout>
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
        <AuthLayout
          intro={{
            eyebrow: "Accept your invitation",
            title: "Finish setting up your account",
            body: "You\u2019re a few details away from joining the household ledger.",
          }}
        >
          <SignUp
            path={`${basePath}/sign-up`}
            routing="path"
            signInUrl={`${basePath}/sign-in`}
            forceRedirectUrl={`${basePath}/dashboard`}
            fallbackRedirectUrl={`${basePath}/dashboard`}
          />
        </AuthLayout>
      </Show>
    </>
  );
}
