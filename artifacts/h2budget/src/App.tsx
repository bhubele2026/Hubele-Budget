import { useEffect, useRef } from "react";
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
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppLayout } from "./components/layout";
import { SignInPage, SignUpPage } from "./pages/auth";
import DashboardPage from "./pages/dashboard";
import ForecastPage from "./pages/forecast";
import ReportsPage from "./pages/reports";
import DebtsPage from "./pages/debts";
import AvalanchePage from "./pages/avalanche";
import AmexPage from "./pages/amex";
import TransactionsPage from "./pages/transactions";
import BillsPage from "./pages/bills";
import BudgetPage from "./pages/budget";
import MappingRulesPage from "./pages/mapping-rules";
import SettingsPage from "./pages/settings";
import PlaidOAuthPage from "./pages/plaid-oauth";
import NotFound from "./pages/not-found";

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
        <Redirect to="/dashboard" />
      </Show>
      <Show when="signed-out">
        <Redirect to="/sign-in" />
      </Show>
    </>
  );
}

function ProtectedShell() {
  return (
    <>
      <Show when="signed-in">
        <AppLayout>
          <Switch>
            <Route path="/dashboard" component={DashboardPage} />
            <Route path="/forecast">
              <ForecastPage mode="overall" />
            </Route>
            <Route path="/review">
              <ForecastPage mode="review" />
            </Route>
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
            <Route path="/mapping-rules" component={MappingRulesPage} />
            <Route path="/settings" component={SettingsPage} />
            <Route path="/plaid-oauth" component={PlaidOAuthPage} />
            <Route component={NotFound} />
          </Switch>
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
