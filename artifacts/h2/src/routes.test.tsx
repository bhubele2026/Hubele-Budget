import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";

/**
 * ⭐ EVERY ROUTE LANDS WHERE IT SHOULD, INSIDE THE SHELL — NEVER A BLANK PAGE.
 *
 * Mounts the REAL App.tsx (its real <Switch>, routes, redirects and shell) and
 * checks each path against a table typed out by hand below: where you end up,
 * which screen renders, and whether the shell is around it. Only leaves are
 * mocked: Clerk, the network client, and each screen (a stub naming itself).
 *
 * The last block holds App.tsx, this table and lib/routePrefetch.ts in
 * lockstep: a new `path=` without a row, a lazy route without an importer, or
 * an importer without a route all fail here.
 */

const auth = vi.hoisted(() => ({ signedIn: true }));

vi.mock("@clerk/react", () => ({
  ClerkProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  Show: ({ when, children }: { when: string; children: ReactNode }) =>
    (when === "signed-in") === auth.signedIn ? <>{children}</> : null,
  useAuth: () => ({ isLoaded: true, isSignedIn: auth.signedIn }),
  useClerk: () => ({ addListener: () => () => {} }),
  UserButton: () => <div data-testid="user-button" />,
}));
vi.mock("@clerk/react/internal", () => ({ publishableKeyFromHost: () => "pk_test_routes" }));
vi.mock("@workspace/api-client-react", () => ({
  getSpine: vi.fn(() => new Promise(() => {})),
  getGetSpineQueryKey: () => ["/api/spine"],
  getGetForecastBankBalanceExplainQueryKey: () => ["/api/forecast/bank-balance/explain"],
}));

vi.mock("./lib/routePrefetch", () => {
  const page = (id: string) => () =>
    Promise.resolve({ default: () => <div data-testid={`page-${id}`} /> });
  return {
    importDesign: page("design"),
    importPlaidOAuth: page("plaid-oauth"),
    routeImporters: {},
    prefetchRoute: () => {},
  };
});
vi.mock("./screens/today/Today", () => ({
  default: () => <div data-testid="page-today" />,
  TodaySkeleton: () => <div data-testid="today-skeleton" />,
}));
vi.mock("./screens/auth/Auth", () => ({
  SignInPage: () => <div data-testid="page-sign-in" />,
  SignUpPage: () => <div data-testid="page-sign-up" />,
}));
vi.mock("./shell/VersionUpdatePrompt", () => ({ VersionUpdatePrompt: () => null }));
vi.mock("./data/spineRecovery", () => ({ askForSpineAgainIfFailed: () => () => {} }));

import App from "./App";
import * as prefetchModule from "./lib/routePrefetch";

type Row = {
  /** The path as typed. */
  from: string;
  /** Where you end up. */
  lands: string;
  /** The screen that renders there. */
  page: string;
  /** Inside the masthead/dock shell, or the bare front door. */
  shell: boolean;
};

const ROUTES: Row[] = [
  { from: "/", lands: "/", page: "today", shell: true },
  { from: "/design", lands: "/design", page: "design", shell: true },
  { from: "/plaid-oauth", lands: "/plaid-oauth", page: "plaid-oauth", shell: true },
  { from: "/sign-in", lands: "/sign-in", page: "sign-in", shell: false },
  { from: "/sign-up", lands: "/sign-up", page: "sign-up", shell: false },
];

function open(path: string) {
  window.history.replaceState(null, "", path);
  return render(<App />);
}

afterEach(() => {
  cleanup();
  auth.signedIn = true;
  window.history.replaceState(null, "", "/");
});

describe("every route lands where it should", () => {
  it.each(ROUTES)("$from → $lands renders $page", async ({ from, lands, page, shell }) => {
    open(from);
    expect(await screen.findByTestId(`page-${page}`)).toBeTruthy();
    expect(window.location.pathname).toBe(lands);
    expect(screen.queryByTestId("not-found")).toBeNull();
    expect(Boolean(screen.queryByTestId("shell")), "shell present").toBe(shell);
  });

  it("an unknown path renders NotFound INSIDE the shell — never a blank page", async () => {
    open("/no-such-page");
    expect(await screen.findByTestId("not-found")).toBeTruthy();
    expect(screen.getByTestId("shell")).toBeTruthy();
    expect(screen.getByTestId("masthead")).toBeTruthy();
    expect(screen.getByTestId("dock")).toBeTruthy();
    expect(window.location.pathname).toBe("/no-such-page");
  });

  it("signed out, Today sends you to sign-in", async () => {
    auth.signedIn = false;
    open("/");
    expect(await screen.findByTestId("page-sign-in")).toBeTruthy();
    expect(window.location.pathname).toBe("/sign-in");
  });

  it("signed out, /design still opens: it holds no data", async () => {
    auth.signedIn = false;
    open("/design");
    expect(await screen.findByTestId("page-design")).toBeTruthy();
    expect(screen.getByTestId("shell")).toBeTruthy();
  });
});

describe("App.tsx, this table and routePrefetch.ts move in lockstep", () => {
  const source = readFileSync(join(import.meta.dirname, "App.tsx"), "utf8");
  const declared = Array.from(source.matchAll(/path="([^"]+)"/g), (m) =>
    // "/sign-in/*?" is Clerk's catch-all; its row visits "/sign-in".
    m[1]!.replace(/\/\*\?$/, ""),
  );

  it("has a row for every path App.tsx declares, and no row for a path it does not", () => {
    const covered = new Set(ROUTES.map((r) => r.from));
    expect(declared.length).toBeGreaterThanOrEqual(5);
    expect(declared.filter((p) => !covered.has(p))).toEqual([]);
    expect([...covered].filter((p) => !declared.includes(p))).toEqual([]);
  });

  it("every lazy() route uses an importer exported by routePrefetch.ts", () => {
    const lazyImporters = Array.from(source.matchAll(/lazy\((\w+)\)/g), (m) => m[1]!);
    expect(lazyImporters.length).toBeGreaterThan(0);
    for (const name of lazyImporters) {
      expect(Object.keys(prefetchModule), `${name} is not exported by routePrefetch`).toContain(name);
    }
    // No inline `lazy(() => import(...))` that would bypass the shared importers.
    expect(source).not.toMatch(/lazy\(\s*\(\)\s*=>/);
  });

  it("every prefetch key is a declared route, and every lazy route has a key", async () => {
    const real = await vi.importActual<typeof import("./lib/routePrefetch")>("./lib/routePrefetch");
    const keys = Object.keys(real.routeImporters);
    expect(keys.filter((k) => !declared.includes(k))).toEqual([]);
    expect(keys.sort()).toEqual(["/design", "/plaid-oauth"]);
  });
});
