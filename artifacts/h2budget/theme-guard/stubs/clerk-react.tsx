// Guard-only stand-in for `@clerk/react`: a signed-in, invented user ("Alex").
// No network, no keys. With `guard:signed-out` = "1" in localStorage the same
// stand-in says signed out, and <SignIn> draws a plain card in the app's own
// token classes (NOT Clerk's real card, which needs Clerk's network). Exports everything the app's graph imports from Clerk
// (App.tsx, account-menu, WhatsNewMount, auth pages) so any of them can load.
import type { ReactNode } from "react";

const USER = {
  id: "user_fixture_alex",
  firstName: "Alex",
  lastName: "Rivera",
  fullName: "Alex Rivera",
  username: "alex",
  imageUrl: "",
  hasImage: false,
  primaryEmailAddress: { emailAddress: "alex@example.com" },
  emailAddresses: [{ emailAddress: "alex@example.com" }],
};

const OUT = (() => {
  try {
    return window.localStorage.getItem("guard:signed-out") === "1";
  } catch {
    return false;
  }
})();

const AUTH = {
  isLoaded: true,
  isSignedIn: !OUT,
  userId: OUT ? null : USER.id,
  sessionId: "sess_fixture",
  orgId: null,
  getToken: async () => null,
  signOut: async () => {},
};

export function useAuth() {
  return AUTH;
}
export function useUser() {
  return { isLoaded: true, isSignedIn: !OUT, user: OUT ? null : USER };
}
export function useSession() {
  return { isLoaded: true, isSignedIn: !OUT, session: OUT ? null : { id: AUTH.sessionId, user: USER } };
}
export function useClerk() {
  return {
    loaded: true,
    user: OUT ? null : USER,
    session: OUT ? null : { id: AUTH.sessionId },
    addListener: () => () => {},
    signOut: async () => {},
    openUserProfile: () => {},
    openSignIn: () => {},
  };
}
export function useOrganization() {
  return { isLoaded: true, organization: null };
}

export function ClerkProvider({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}
export function Show({ when, children }: { when?: string; children?: ReactNode }) {
  return (when === "signed-out") === OUT ? <>{children}</> : null;
}
export function SignedIn({ children }: { children?: ReactNode }) {
  return OUT ? null : <>{children}</>;
}
export function SignedOut({ children }: { children?: ReactNode }) {
  return OUT ? <>{children}</> : null;
}
/** A stand-in card in the app's own tokens (the classes App.tsx hands Clerk). */
export function SignIn() {
  return (
    <div data-testid="guard-sign-in" className="bg-card rounded-card w-[440px] max-w-full overflow-hidden shadow-over ring-1 ring-brand-line p-8 space-y-4">
      <div>
        <h1 className="text-foreground text-xl font-semibold">Sign in to H2 Budget</h1>
        <p className="text-muted-foreground text-sm">Welcome back! Please sign in to continue</p>
      </div>
      <label className="block text-foreground text-sm">
        Email address
        <input type="email" placeholder="you@example.com" className="mt-1 block h-9 w-full rounded-md border border-input bg-muted px-3 text-sm text-foreground" />
      </label>
      <button type="button" className="h-9 w-full rounded-md bg-primary text-sm font-medium text-white">Continue</button>
      <p className="text-muted-foreground text-sm">
        No account? <span className="text-primary font-medium">Sign up</span>
      </p>
    </div>
  );
}
export function SignUp() {
  return null;
}
export function RedirectToSignIn() {
  return null;
}

/** The avatar Clerk draws in the header: a plain initial, no menu. */
function UserButtonImpl(_props: { children?: ReactNode }) {
  return (
    <span
      aria-label="Account"
      data-testid="fixture-user-button"
      style={{
        display: "inline-grid",
        placeItems: "center",
        width: 28,
        height: 28,
        borderRadius: 9999,
        // The top bar's own ink and press ground, so the stub sits on the white bar (and on dark's card) like Clerk's avatar.
        background: "var(--color-chrome-press)",
        color: "var(--color-chrome-ink)",
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      A
    </span>
  );
}
const Noop = (_p: Record<string, unknown>) => null;
export const UserButton = Object.assign(UserButtonImpl, {
  MenuItems: Noop,
  Action: Noop,
  Link: Noop,
  UserProfilePage: Noop,
  UserProfileLink: Noop,
});

export default {};
