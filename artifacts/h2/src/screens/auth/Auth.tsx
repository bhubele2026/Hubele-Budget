import { useState, type ReactNode } from "react";
import { Redirect } from "wouter";
import { SignIn, SignUp, Show } from "@clerk/react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

/**
 * The front door: paper, one serif line, and Clerk's form. Nothing else to
 * read before signing in.
 */
function AuthPage({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-paper-0 text-ink" data-testid="auth-page">
      <div className="mx-auto flex min-h-dvh w-full max-w-read flex-col items-center justify-center gap-8 px-4 py-12 sm:px-8">
        <p className="max-w-[28ch] text-center type-headline text-ink" data-testid="auth-line">
          H<span className="text-moss">2</span> — the household’s money, every morning.
        </p>
        {children}
      </div>
    </div>
  );
}

export function SignInPage() {
  return (
    <AuthPage>
      <SignIn path={`${basePath}/sign-in`} routing="path" signUpUrl={`${basePath}/sign-up`} />
    </AuthPage>
  );
}

/**
 * Sign-up is by invitation only, ported from the classic app.
 *
 * The invitation lands at `/sign-up?__clerk_ticket=…`, but Clerk's own steps
 * (`/sign-up/verify-email-address`, `/sign-up/continue`) drop the query
 * string. Recomputing "has a ticket" on every render would bounce the user to
 * sign-in mid-flow and leave Clerk's loader spinning, so it is latched once on
 * mount. A bare `/sign-up` with no ticket goes to sign-in.
 */
export function SignUpPage() {
  const [hasTicket] = useState(() => {
    if (typeof window === "undefined") return false;
    const params = new URLSearchParams(window.location.search);
    if (params.has("__clerk_ticket") || params.has("__clerk_invitation_token")) return true;
    return window.location.pathname.replace(/\/+$/, "") !== `${basePath}/sign-up`;
  });
  if (!hasTicket) return <Redirect to="/sign-in" />;
  return (
    <>
      {/* Once the ticket is accepted the user is signed in and <SignUp> has
          nothing left to draw; without this redirect it sits on its loader. */}
      <Show when="signed-in">
        <Redirect to="/" />
      </Show>
      <Show when="signed-out">
        <AuthPage>
          <SignUp
            path={`${basePath}/sign-up`}
            routing="path"
            signInUrl={`${basePath}/sign-in`}
            forceRedirectUrl={`${basePath}/`}
            fallbackRedirectUrl={`${basePath}/`}
          />
        </AuthPage>
      </Show>
    </>
  );
}
