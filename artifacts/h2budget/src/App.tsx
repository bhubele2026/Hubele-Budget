import { lazy, Suspense, useEffect, useRef } from "react";
import {
  Switch,
  Route,
  Router as WouterRouter,
  Redirect,
  useLocation,
} from "wouter";
import {
  QueryClient,
  QueryClientProvider,
  keepPreviousData,
  useQueryClient,
} from "@tanstack/react-query";
import { ClerkProvider, Show, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";

import { Toaster } from "@/components/ui/toaster";
import { PlaidReconnectListener } from "@/components/plaid-reconnect-listener";
import { VersionUpdatePrompt } from "@/components/version-update-prompt";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppLayout } from "./components/layout";
import { ThemeProvider } from "@/hooks/use-theme";
import { Skeleton } from "@/components/ui/skeleton";
// Auth pages stay eagerly imported — they're on the unauthenticated
// critical path (and are small), so code-splitting them would only add
// a render-blocking chunk fetch before the user can even sign in.
import { SignInPage, SignUpPage } from "./pages/auth";

// (#819) Route-level code splitting. Each page is loaded on demand so the
// initial bundle no longer carries every page (and their heavy deps like
// recharts) up front. Navigating to a route fetches just that route's
// chunk, which is cached for subsequent visits. Behavior is unchanged —
// a brief <Suspense> fallback shows while a route's chunk streams in.
const ForecastPage = lazy(() => import("./pages/forecast"));
const ReportsPage = lazy(() => import("./pages/reports"));
const DebtsPage = lazy(() => import("./pages/debts"));
const AvalanchePage = lazy(() => import("./pages/avalanche"));
const AmexPage = lazy(() => import("./pages/amex"));
const TransactionsPage = lazy(() => import("./pages/transactions"));
const BillsPage = lazy(() => import("./pages/bills"));
const BudgetPage = lazy(() => import("./pages/budget"));
const AllowancesPage = lazy(() => import("./pages/allowances"));
const MappingRulesPage = lazy(() => import("./pages/mapping-rules"));
const DebriefPage = lazy(() => import("./pages/debrief"));
const SettingsPage = lazy(() => import("./pages/settings"));
const PlaidOAuthPage = lazy(() => import("./pages/plaid-oauth"));
const NotFound = lazy(() => import("./pages/not-found"));

const queryClient = new QueryClient({
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
const ALWAYS_FRESH = {
  staleTime: 0,
  refetchOnMount: "always",
  refetchOnWindowFocus: true,
} as const;

// Forecast bundle (all daysAhead/horizon variants) + the cash-signal
// projection. These were ALWAYS_FRESH — refetched on EVERY mount — which is
// the main remaining navigation lag on Dashboard / Forecast / Reports (each
// pulls the whole bundle). With background auto-sync off they only change on
// an explicit Sync or edit, and both paths now invalidate these keys
// (transaction mutations + runSync). A short 30s staleTime lets rapid
// Dashboard↔Forecast↔Reports navigation reuse the cache, while any missed
// invalidation self-heals within 30s. keepPreviousData still avoids a
// skeleton flash on the background revalidate.
const FORECAST_CACHE = {
  staleTime: 30_000,
  refetchOnWindowFocus: false,
} as const;
queryClient.setQueryDefaults(["/api/forecast"], FORECAST_CACHE);
queryClient.setQueryDefaults(["/api/forecast/cash-signal"], FORECAST_CACHE);
// Transaction lists powering Chase / Amex / Debrief / Dashboard. These used
// to be ALWAYS_FRESH (refetch up to 5,000 rows on EVERY page mount) so live
// Plaid syncs showed without a manual refresh. With background auto-sync now
// off, transactions only change when the user Syncs or edits — and every one
// of those paths already invalidates this key explicitly. So cache for a
// couple of minutes instead: navigating between Chase/Amex/Debrief/Dashboard
// is now instant (served from cache) rather than re-downloading the whole
// list each time. keepPreviousData (root config) still avoids skeleton flash
// on the occasional background revalidate.
const TXN_CACHE = {
  staleTime: 2 * 60_000,
  refetchOnWindowFocus: false,
} as const;
queryClient.setQueryDefaults(["/api/transactions"], TXN_CACHE);
// Weekly-debrief summaries (the list of weeks). Per-week detail keys are
// distinct strings, so those opt in via per-call overrides on /debrief.
queryClient.setQueryDefaults(["/api/debrief/weeks"], ALWAYS_FRESH);

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
    logoImageUrl: `${window.location.origin}${basePath}/logo.png`,
  },
  variables: {
    colorPrimary: "hsl(218, 30%, 15%)",
    colorForeground: "hsl(218, 30%, 15%)",
    colorMutedForeground: "hsl(217, 14%, 41%)",
    colorDanger: "hsl(0, 56%, 39%)",
    colorBackground: "hsl(216, 17%, 94%)",
    colorInput: "hsl(210, 11%, 98%)",
    colorInputForeground: "hsl(218, 30%, 15%)",
    colorNeutral: "hsl(218, 15%, 75%)",
    fontFamily: "'Geist', Inter, sans-serif",
    borderRadius: "0.5rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox:
      "bg-card rounded-2xl w-[440px] max-w-full overflow-hidden shadow-xl",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
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
        <Redirect to="/reports" />
      </Show>
      <Show when="signed-out">
        <Redirect to="/sign-in" />
      </Show>
    </>
  );
}

function RouteFallback() {
  return (
    <div className="space-y-4 p-2" data-testid="route-loading">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function ProtectedShell() {
  return (
    <>
      <Show when="signed-in">
        <AppLayout>
          <Suspense fallback={<RouteFallback />}>
          <Switch>
            <Route path="/dashboard">
              <Redirect to="/reports" />
            </Route>
            <Route path="/forecast">
              <ForecastPage mode="overall" />
            </Route>
            <Route path="/review">
              <ForecastPage mode="review" />
            </Route>
            <Route path="/debrief" component={DebriefPage} />
            <Route path="/debrief/:week" component={DebriefPage} />
            <Route path="/reports" component={ReportsPage} />
            <Route path="/transactions" component={TransactionsPage} />
            <Route path="/amex" component={AmexPage} />
            <Route path="/debts" component={DebtsPage} />
            <Route path="/avalanche" component={AvalanchePage} />
            <Route path="/bills" component={BillsPage} />
            <Route path="/recurring">
              <Redirect to="/bills" />
            </Route>
            <Route path="/budget" component={BudgetPage} />
            <Route path="/allowances" component={AllowancesPage} />
            <Route path="/mapping-rules" component={MappingRulesPage} />
            <Route path="/settings" component={SettingsPage} />
            <Route path="/plaid-oauth" component={PlaidOAuthPage} />
            <Route component={NotFound} />
          </Switch>
          </Suspense>
        </AppLayout>
      </Show>
      <Show when="signed-out">
        <Redirect to="/sign-in" />
      </Show>
    </>
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
        <ThemeProvider>
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
        </ThemeProvider>
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
