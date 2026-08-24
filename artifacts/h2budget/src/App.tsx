import { lazy, Suspense, useEffect, useRef } from "react";
import {
  Switch,
  Route,
  Router as WouterRouter,
  Redirect,
  useLocation,
} from "wouter";
import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
  keepPreviousData,
  useQueryClient,
} from "@tanstack/react-query";
import { ClerkProvider, Show, useAuth, useClerk } from "@clerk/react";
import { getSpine, getGetSpineQueryKey } from "@workspace/api-client-react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";

import { Toaster } from "@/components/ui/toaster";
import { PlaidReconnectListener } from "@/components/plaid-reconnect-listener";
import { VersionUpdatePrompt } from "@/components/version-update-prompt";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppLayout } from "./components/layout";
import { PageErrorBoundary } from "@/components/page-error-boundary";
// Auth pages stay eagerly imported — they're on the unauthenticated
// critical path (and are small), so code-splitting them would only add
// a render-blocking chunk fetch before the user can even sign in.
import { SignInPage, SignUpPage } from "./pages/auth";
// ⚠️ THE LANDING IS EAGER, NOT `lazy()`. It is where every open lands, so
// splitting it into its own chunk bought nothing but a guaranteed extra network
// round trip on the one screen that has to feel instant. It is cheap to carry
// in the entry precisely because it holds zero charts and one query.
import LandingPage from "./pages/landing";
import { LandingSkeleton } from "./pages/landing";
import { PageSkeleton } from "@/components/page-skeleton";
// (#perf) Route-chunk importers live in one shared module so the hover/idle
// prefetch map (lib/routePrefetch) and these lazy() calls can never point at
// different chunks. Consuming the exact same importer functions here is what
// guarantees a hover warms precisely the chunk the route will render.
import {
  importCommandCenter,
  importForecast,
  importForecastOverview,
  importReports,
  importReportsDebt,
  importReportsCashFlow,
  importReportsSpending,
  importReportsBudget,
  importReportsBehavior,
  importDebts,
  importAvalanche,
  importAmex,
  importTransactions,
  importBills,
  importBillsOverview,
  importBudget,
  importAllowances,
  importMappingRules,
  importSettings,
} from "./lib/routePrefetch";

// (#819) Route-level code splitting. Each page is loaded on demand so the
// initial bundle no longer carries every page (and their heavy deps like
// recharts) up front. Navigating to a route fetches just that route's
// chunk, which is cached for subsequent visits. Behavior is unchanged —
// a brief <Suspense> fallback shows while a route's chunk streams in.
const CommandCenterPage = lazy(importCommandCenter);
const ForecastPage = lazy(importForecast);
const ForecastOverviewPage = lazy(importForecastOverview);
const ReportsPage = lazy(importReports);
const ReportsDebtPage = lazy(importReportsDebt);
const ReportsCashFlowPage = lazy(importReportsCashFlow);
const ReportsSpendingPage = lazy(importReportsSpending);
const ReportsBudgetPage = lazy(importReportsBudget);
const ReportsBehaviorPage = lazy(importReportsBehavior);
const DebtsPage = lazy(importDebts);
const AvalanchePage = lazy(importAvalanche);
const AmexPage = lazy(importAmex);
const TransactionsPage = lazy(importTransactions);
const BillsPage = lazy(importBills);
const BillsOverviewPage = lazy(importBillsOverview);
const BudgetPage = lazy(importBudget);
const AllowancesPage = lazy(importAllowances);
const MappingRulesPage = lazy(importMappingRules);
const SettingsPage = lazy(importSettings);
const PlaidOAuthPage = lazy(() => import("./pages/plaid-oauth"));
const NotFound = lazy(() => import("./pages/not-found"));

/**
 * ⭐ ONE INVALIDATION RULE FOR THE SPINE, NOT THIRTY.
 *
 * `/api/spine` is fed by cash-signal, bills, spending facts, debts and the
 * review count — so almost any write in this app can move one of its numbers.
 * The obvious implementation is to add `invalidateQueries(["/api/spine"])` to
 * every mutation that touches those namespaces. There are 34 files with
 * invalidations in them; wiring each by hand guarantees that the 35th, written
 * six months from now, forgets — and a stale spine is the exact failure mode
 * this endpoint was built to eliminate (two surfaces, two moments, two
 * answers).
 *
 * So the rule lives in ONE place: any successful mutation, anywhere, marks the
 * spine stale. This cannot drift, cannot be forgotten, and costs almost
 * nothing — `invalidateQueries` only triggers a network refetch for a query
 * that is currently MOUNTED, so a write on the Settings page simply marks it
 * stale and the next screen that reads the spine picks up fresh numbers.
 */
const mutationCache = new MutationCache({
  onSuccess: () => {
    void queryClient.invalidateQueries({ queryKey: getGetSpineQueryKey() });
  },
});

const queryClient = new QueryClient({
  mutationCache,
  defaultOptions: {
    queries: {
      // Cached responses stay "fresh" for 5 min, so revisiting a page
      // (or a previously-loaded budget month) renders from cache
      // instantly instead of triggering a full refetch + skeleton.
      // Mutations invalidate the relevant keys explicitly, so a
      // longer staleTime doesn't cause "stale data" — it just stops
      // the background refetch storm that makes navigation feel slow.
      staleTime: 5 * 60_000,
      // Keep evicted entries around for 30 min so back-and-forth
      // navigation between months hits the cache.
      gcTime: 30 * 60_000,
      // The aggressive default refetch-on-focus was causing the
      // budget grid to re-skeleton every time the user tabbed back
      // to the window.
      refetchOnWindowFocus: false,
      retry: 1,
      // Global "keep previous data on screen during a refetch" — without
      // this, every page that paginates by month (Budget, Bills,
      // Forecast) would skeleton-flash on each prev/next click. With it,
      // the previous month's content stays visible while the new month
      // streams in. Page-level loaders should gate on `!data`, not
      // `isLoading`, so the skeleton only ever shows on the very first
      // visit (when no cached data exists yet).
      placeholderData: keepPreviousData,
    },
  },
});

// (#823) Money-sensitive, high-churn data must never go stale behind the
// user's back — that's what made the same Jun 8 day show one balance on
// the 30-day forecast and a different one on the 90-day view. For these
// namespaces we override the global 5-min staleTime so the data is always
// considered stale, refetches on every mount (so switching forecast
// horizons / re-opening a page always pulls fresh numbers), and refetches
// when the user tabs back to the window. `placeholderData: keepPreviousData`
// from the root config still applies, so the previous content stays on
// screen during the background refetch instead of skeleton-flashing.
//
// We scope this with setQueryDefaults by query-key prefix so LOW-churn
// queries (categories, recurring items, debts, forecast settings, closed
// months, etc.) keep their existing 5-min cache behavior untouched.

// Forecast bundle (all daysAhead/horizon variants) + the cash-signal
// projection. These were ALWAYS_FRESH — refetched on EVERY mount — which is
// the main remaining navigation lag on Dashboard / Forecast / Reports (each
// pulls the whole bundle). With background auto-sync off they only change on
// an explicit Sync or edit, and both paths now invalidate these keys
// (transaction mutations + runSync). 5 min staleTime: any pause between
// clicks longer than the old 30s re-ran the app's most expensive handler
// (~30-40 queries) for no freshness gain — every write path invalidates.
// keepPreviousData still avoids a skeleton flash on the background
// revalidate.
const FORECAST_CACHE = {
  staleTime: 5 * 60_000,
  refetchOnWindowFocus: false,
} as const;
queryClient.setQueryDefaults(["/api/forecast"], FORECAST_CACHE);
queryClient.setQueryDefaults(["/api/forecast/cash-signal"], FORECAST_CACHE);
// Transaction lists powering Chase / Amex / Dashboard. These used
// to be ALWAYS_FRESH (refetch up to 5,000 rows on EVERY page mount) so live
// Plaid syncs showed without a manual refresh. With background auto-sync now
// off, transactions only change when the user Syncs or edits — and every one
// of those paths already invalidates this key explicitly. So cache for a
// couple of minutes instead: navigating between Chase/Amex/Dashboard
// is now instant (served from cache) rather than re-downloading the whole
// list each time. keepPreviousData (root config) still avoids skeleton flash
// on the occasional background revalidate.
const TXN_CACHE = {
  staleTime: 2 * 60_000,
  refetchOnWindowFocus: false,
} as const;
queryClient.setQueryDefaults(["/api/transactions"], TXN_CACHE);
// Amex weekly-payoff is derived from transactions; it only changes on a sync
// or a transaction edit, both of which invalidate it. Cache like transactions
// so its consumers don't re-tally on every nav.
queryClient.setQueryDefaults(["/api/amex/weekly-payoff"], TXN_CACHE);

// (#perf-1) Slow-changing reference data: settings, categories, mapping rules,
// debts (+ balance history), recurring items, avalanche/forecast settings, and
// linked Plaid accounts. These change only via explicit user edits, every one
// of which invalidates its key — so cache generously (30 min) and reuse across
// the whole app instead of refetching the same data on every page mount.
const SLOW_CACHE = { staleTime: 30 * 60_000, refetchOnWindowFocus: false } as const;
for (const key of [
  "/api/settings",
  "/api/budget/categories",
  "/api/mapping-rules",
  "/api/debts",
  "/api/recurring-items",
  "/api/avalanche/settings",
  "/api/avalanche/extra",
  "/api/forecast/settings",
  "/api/plaid/items",
  "/api/plaid/liability-accounts",
]) {
  queryClient.setQueryDefaults([key], SLOW_CACHE);
}

// (#755) Expose the React Query client on `window` so end-to-end tests can
// simulate a mid-session recovery import (insert rows into the DB out-of-
// band, then invalidate `/api/transactions` to force a fresh refetch) and
// re-assert the virtualized Amex list still scrolls all the way to the
// oldest day-group. This is a thin observability hook — the user can
// already inspect their own cached query data via React Query DevTools, so
// no new data is exposed.
if (typeof window !== "undefined") {
  (window as unknown as { __qc?: QueryClient }).__qc = queryClient;
}

// ── Instant open ────────────────────────────────────────────────────────────
//
// ⭐ "I want to open it and it just opens."
//
// The app used to render NOTHING until clerk-js had downloaded, initialised and
// round-tripped a session. On a warm, already-signed-in open that is a blank
// screen for the entire cost of an auth handshake, for a household of two
// people who are always signed in.
//
// `h2:auth-hint` records that this browser has resolved to a signed-in session
// before. When it is set we paint the shell immediately and let Clerk catch up.
// It is a HINT, never an authorisation: it gates pixels, not data. The shell it
// unlocks contains zero numbers, and every byte of real data still requires the
// server to accept the session cookie — so the worst case for a stale hint is
// that a signed-out visitor sees an empty navy frame for a moment before being
// redirected to /sign-in.
const AUTH_HINT_KEY = "h2:auth-hint";

function readAuthHint(): boolean {
  try {
    return window.localStorage.getItem(AUTH_HINT_KEY) === "1";
  } catch {
    // Safari private mode / storage disabled: fall back to the slow-but-correct
    // path rather than breaking the front door.
    return false;
  }
}

function writeAuthHint(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(AUTH_HINT_KEY, "1");
    else window.localStorage.removeItem(AUTH_HINT_KEY);
  } catch {
    /* storage unavailable — the hint is an optimisation, never a requirement */
  }
}

// ⚠️ FIRED AT MODULE SCOPE, IN PARALLEL WITH CLERK-JS — NOT AFTER IT.
// The API authenticates web requests with the same-origin `__session` cookie
// (the bearer path is Expo-only), which means this request is already
// authenticated before clerk-js has finished booting. Waiting for Clerk to
// resolve before asking for data would serialise two independent round trips
// for no reason.
//
// `retry: false` on purpose: if the session JWT has expired the server answers
// 401, and the right response is to drop it silently — the normal `useQuery`
// refetches once Clerk has refreshed the cookie. Retrying would just spend the
// open on doomed requests.
if (typeof window !== "undefined" && readAuthHint()) {
  void queryClient
    .prefetchQuery({
      queryKey: getGetSpineQueryKey(),
      queryFn: ({ signal }) => getSpine({ signal }),
      staleTime: 60_000,
      retry: false,
    })
    .catch(() => {
      /* 401 before Clerk refreshes the cookie — the mounted query refetches */
    });
}

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY");
}

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    // ⚠️ THE PNG, NOT THE SVG, AND DELIBERATELY. Clerk renders this through an
    // <img>, and an SVG in an <img> cannot reach the page's self-hosted Inter —
    // it would fall back to the platform grotesque at a size where that is
    // visible, on the one screen every user sees before they are signed in.
    // The PNG is rasterised from the real font.
    logoImageUrl: `${window.location.origin}${basePath}/h2-mark.png`,
  },
  // ⚠️ THE FRONT DOOR READS THESE. Every colour points at the app's own CSS
  // tokens, so the sign-in card is navy/platinum for free — and a bridge-layer
  // rebind moves it without touching this file. Verify `/sign-in` after any
  // token change: a broken sign-in fails "it just opens" harder than anything.
  variables: {
    colorPrimary: "hsl(var(--primary))",
    colorForeground: "hsl(var(--foreground))",
    colorMutedForeground: "hsl(var(--muted-foreground))",
    colorDanger: "hsl(var(--destructive))",
    colorBackground: "hsl(var(--card))",
    colorInput: "hsl(var(--muted))",
    colorInputForeground: "hsl(var(--foreground))",
    colorNeutral: "hsl(var(--muted-foreground))",
    colorRing: "hsl(var(--ring))",
    fontFamily:
      "'Inter Variable', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
    borderRadius: "8px",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox:
      "bg-card rounded-card w-[440px] max-w-full overflow-hidden shadow-over ring-1 ring-brand-line",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    // ⚠️ THE FRONT DOOR'S ONE HARD-CODED RULE, AND IT EARNS ITS KEEP.
    // Clerk resolves colours in JS, so a `hsl(var(--…))` string is passed
    // through for FILLS but cannot be parsed to derive a readable label —
    // `colorPrimaryForeground` therefore silently does nothing here and the
    // solid button falls back to `colorForeground`. On the old teal that was
    // merely ugly; on navy it is ink-on-navy at 1.2:1, an invisible "Continue"
    // on the sign-in card. A class beats the computed style deterministically.
    formButtonPrimary: "!text-white",
    headerTitle: "text-foreground text-xl font-semibold",
    headerSubtitle: "text-muted-foreground text-sm",
    socialButtonsBlockButtonText: "text-foreground",
    formFieldLabel: "text-foreground text-sm",
    footerActionLink: "text-primary font-medium",
    footerActionText: "text-muted-foreground",
    dividerText: "text-muted-foreground",
  },
};

function HomeRoute() {
  return (
    <>
      <Show when="signed-in">
        <Redirect to="/home" />
      </Show>
      <Show when="signed-out">
        <Redirect to="/sign-in" />
      </Show>
    </>
  );
}

// Backstop for a genuine cold chunk load (rare once route-chunk prefetch on
// hover/idle lands). Renders the shared PageSkeleton so it reads as "the page
// is loading" in-layout, not a random generic skeleton.
function RouteFallback() {
  return (
    <div data-testid="route-loading">
      <PageSkeleton />
    </div>
  );
}

// Captured ONCE, at module load, before the effect below can write it — this
// has to mean "was this browser signed in on a previous open", not "has Clerk
// answered during this render".
const HAD_AUTH_HINT = typeof window !== "undefined" && readAuthHint();

function ProtectedShell() {
  const [location] = useLocation();
  const { isLoaded, isSignedIn } = useAuth();

  // Keep the hint honest: set on a real signed-in resolve, cleared on sign-out
  // so the next open of a signed-out browser goes straight to the front door
  // instead of flashing a shell it isn't entitled to.
  useEffect(() => {
    if (!isLoaded) return;
    writeAuthHint(Boolean(isSignedIn));
  }, [isLoaded, isSignedIn]);

  // ⭐ THE OPTIMISTIC SHELL. Clerk hasn't answered yet, but this browser has
  // been signed in before — so paint the frame and the tile skeletons now
  // instead of holding a blank screen for the auth handshake.
  //
  // ⚠️ ZERO NUMBERS IN THE SKELETON, BY CONSTRUCTION. Nothing here reads a
  // query, so there is no way for a figure to paint for someone whose session
  // turns out to be invalid. The only thing an unauthorised viewer can see is
  // the shape of the app.
  if (!isLoaded) {
    if (!HAD_AUTH_HINT) return null;
    return (
      <AppLayout>
        {location === "/home" ? (
          <LandingSkeleton />
        ) : (
          <div data-testid="route-loading">
            <PageSkeleton />
          </div>
        )}
      </AppLayout>
    );
  }

  // Clerk has answered and the answer is no. Same redirect as before — it just
  // happens after the shell has painted rather than instead of it.
  if (!isSignedIn) return <Redirect to="/sign-in" />;

  return (
    <AppLayout>
          <PageErrorBoundary resetKey={location}>
          <Suspense fallback={<RouteFallback />}>
          <Switch>
            <Route path="/home" component={LandingPage} />
            <Route path="/banking" component={CommandCenterPage} />
            <Route path="/dashboard">
              <Redirect to="/banking" />
            </Route>
            <Route path="/forecast/overview" component={ForecastOverviewPage} />
            <Route path="/forecast">
              <ForecastPage mode="overall" />
            </Route>
            <Route path="/review">
              <ForecastPage mode="review" />
            </Route>
            <Route path="/reports" component={ReportsPage} />
            <Route path="/reports/debt" component={ReportsDebtPage} />
            <Route path="/reports/cashflow" component={ReportsCashFlowPage} />
            <Route path="/reports/spending" component={ReportsSpendingPage} />
            <Route path="/reports/budget" component={ReportsBudgetPage} />
            <Route path="/reports/behavior" component={ReportsBehaviorPage} />
            <Route path="/transactions" component={TransactionsPage} />
            <Route path="/amex" component={AmexPage} />
            <Route path="/debts" component={DebtsPage} />
            <Route path="/avalanche" component={AvalanchePage} />
            <Route path="/bills" component={BillsOverviewPage} />
            <Route path="/bills/all" component={BillsPage} />
            <Route path="/recurring">
              <Redirect to="/bills/all" />
            </Route>
            <Route path="/budget" component={BudgetPage} />
            <Route path="/allowances" component={AllowancesPage} />
            <Route path="/mapping-rules" component={MappingRulesPage} />
            <Route path="/settings" component={SettingsPage} />
            <Route path="/plaid-oauth" component={PlaidOAuthPage} />
            <Route component={NotFound} />
          </Switch>
          </Suspense>
          </PageErrorBoundary>
    </AppLayout>
  );
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (
        prevUserIdRef.current !== undefined &&
        prevUserIdRef.current !== userId
      ) {
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

        <TooltipProvider>
          <Switch>
            <Route path="/" component={HomeRoute} />
            <Route path="/sign-in/*?" component={SignInPage} />
            <Route path="/sign-up/*?" component={SignUpPage} />
            <Route component={ProtectedShell} />
          </Switch>
          <Toaster />
          {/* (#357) Mounts a global listener that opens Plaid Link in
              update mode whenever any surface (sync-error toast,
              Settings → Recent activity row) dispatches the
              "plaid:reconnect" event for a specific itemId. */}
          <PlaidReconnectListener />
          {/* (#823) Non-intrusive "a new version is available" banner.
              Polls /api/version and prompts a one-click reload when a
              new bundle has been deployed. No-op in dev. */}
          <VersionUpdatePrompt />
        </TooltipProvider>

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
