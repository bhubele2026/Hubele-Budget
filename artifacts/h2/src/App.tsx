import { lazy, Suspense, useEffect, useRef } from "react";
import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { QueryClientProvider, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ClerkProvider, useAuth, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";

import { createQueryClient, prefetchSpineOnHint } from "@/data/queryClient";
import { askForSpineAgainIfFailed } from "@/data/spineRecovery";
import { readAuthHint, writeAuthHint } from "@/lib/authHint";
import { prefetchTodayOnIdle } from "@/data/todayData";
import { useActivityBadge } from "@/data/activityBadge";
import { importActivity, importDesign, importDesignActivity, importDesignToday, importPlaidOAuth } from "@/lib/routePrefetch";
import { SkeletonFigure, SkeletonLine } from "@/kit/Skeleton";
import { BootFrame, Shell } from "@/shell/Shell";
import { NotFound } from "@/shell/NotFound";
import { PageErrorBoundary } from "@/shell/PageErrorBoundary";
import { VersionUpdatePrompt } from "@/shell/VersionUpdatePrompt";
import { clerkAppearance } from "@/shell/clerkAppearance";
// The front door's screens are eager: they are on the signed-out critical
// path, and a chunk fetch there only delays the form.
import { SignInPage, SignUpPage } from "@/screens/auth/Auth";
// ⚠️ TODAY IS EAGER, NOT lazy(). Every open lands on it; splitting it would
// buy a guaranteed extra round trip on the one screen that must feel instant.
import Today, { TodaySkeleton } from "@/screens/today/Today";

const DesignPage = lazy(importDesign);
const DesignTodayPage = lazy(importDesignToday);
const DesignActivityPage = lazy(importDesignActivity);
// One chunk for the three Activity views (ledger, review, rules): they share the
// sheets, the picker and the toasts, and none of it belongs on the open path.
const ActivityPage = lazy(importActivity);
const PlaidOAuthPage = lazy(importPlaidOAuth);

const queryClient = createQueryClient();

// Exposed for end-to-end tests (seed out of band, then invalidate), as the
// classic app does. It exposes nothing the signed-in user cannot already see.
if (typeof window !== "undefined") {
  (window as unknown as { __qc?: QueryClient }).__qc = queryClient;
}

// Ask for the spine now, in parallel with clerk-js, when this browser has been
// signed in before. See `prefetchSpineOnHint`.
prefetchSpineOnHint(queryClient);
// …then, once it lands and the browser is idle, everything else Today reads.
prefetchTodayOnIdle(queryClient);

// Captured ONCE at load, before the effect below can write it: "was this
// browser signed in on a previous open", not "has Clerk answered yet".
const HAD_AUTH_HINT = typeof window !== "undefined" && readAuthHint();

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || "/" : path;
}

/** The in-shell fallback while a lazy screen's chunk streams in. */
function RouteFallback() {
  return (
    <div className="flex flex-col gap-4" data-testid="route-loading" aria-busy="true">
      <SkeletonLine className="w-48" />
      <SkeletonFigure size="md" />
      <SkeletonLine className="w-64" />
    </div>
  );
}

function ProtectedShell() {
  const [location] = useLocation();
  const { isLoaded, isSignedIn } = useAuth();
  const activityBadge = useActivityBadge(Boolean(isLoaded && isSignedIn));

  // Keep the hint honest: set on a real signed-in answer, cleared on sign-out.
  useEffect(() => {
    if (!isLoaded) return;
    writeAuthHint(Boolean(isSignedIn));
  }, [isLoaded, isSignedIn]);

  // ⚠️ A screen can join the prefetch's failure (a 401 before Clerk refreshed
  // the cookie). Once signed in, a first spine request that failed is asked
  // for again: one ask, never a loop.
  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    return askForSpineAgainIfFailed(queryClient);
  }, [isLoaded, isSignedIn]);

  // ⭐ THE OPTIMISTIC SHELL. Clerk has not answered, but this browser has been
  // signed in before: paint the frame and the skeleton now. ZERO NUMBERS by
  // construction — nothing here reads a query.
  if (!isLoaded) {
    if (!HAD_AUTH_HINT) return <BootFrame />;
    return <Shell>{location === "/" ? <TodaySkeleton /> : <RouteFallback />}</Shell>;
  }

  if (!isSignedIn) return <Redirect to="/sign-in" />;

  return (
    <Shell activityBadge={activityBadge}>
      <PageErrorBoundary resetKey={location}>
        <Suspense fallback={<RouteFallback />}>
          <Switch>
            <Route path="/">
              <Today />
            </Route>
            <Route path="/activity">
              <ActivityPage view="ledger" />
            </Route>
            <Route path="/activity/review">
              <ActivityPage view="review" />
            </Route>
            <Route path="/activity/rules">
              <ActivityPage view="rules" />
            </Route>
            <Route path="/plaid-oauth">
              <PlaidOAuthPage />
            </Route>
            <Route>
              <NotFound />
            </Route>
          </Switch>
        </Suspense>
      </PageErrorBoundary>
    </Shell>
  );
}

/**
 * The design page is public: it holds no data (every sample is made up), and
 * the owner should be able to open it from any browser to judge the look.
 */
function PublicDesign() {
  const [location] = useLocation();
  return (
    <Shell>
      <PageErrorBoundary resetKey={location}>
        <Suspense fallback={<RouteFallback />}>
          <DesignPage />
        </Suspense>
      </PageErrorBoundary>
    </Shell>
  );
}

/** Today on made-up data: public, no network, so the composition can be judged signed out. */
function PublicDesignToday() {
  const [location] = useLocation();
  return (
    <Shell>
      <PageErrorBoundary resetKey={location}>
        <Suspense fallback={<RouteFallback />}>
          <DesignTodayPage />
        </Suspense>
      </PageErrorBoundary>
    </Shell>
  );
}

/** Activity on made-up data: public, no network, so the screens can be judged signed out. */
function PublicDesignActivity() {
  const [location] = useLocation();
  return (
    <Shell>
      <PageErrorBoundary resetKey={location}>
        <Suspense fallback={<RouteFallback />}>
          <DesignActivityPage />
        </Suspense>
      </PageErrorBoundary>
    </Shell>
  );
}

/** Drops every cached figure when the signed-in user changes (ported). */
function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);
  return null;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <Switch>
          <Route path="/sign-in/*?" component={SignInPage} />
          <Route path="/sign-up/*?" component={SignUpPage} />
          <Route path="/design/today" component={PublicDesignToday} />
          <Route path="/design/activity/*?" component={PublicDesignActivity} />
          <Route path="/design" component={PublicDesign} />
          <Route component={ProtectedShell} />
        </Switch>
        <VersionUpdatePrompt />
      </QueryClientProvider>
    </ClerkProvider>
  );
}

export default function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}
