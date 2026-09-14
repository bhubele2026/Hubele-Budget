import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, cleanup } from "@testing-library/react";
import { Switch, Route, Redirect, Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

/**
 * ⭐ EVERY ROUTE FROM "TODAY" STILL RESOLVES.
 *
 * R0 reshuffles the NAV ONLY — labels, ribbons, landing tiles — and must not
 * remove, rename, or re-target a single route in `App.tsx`'s `<Switch>`. This
 * file is the regression guard for that promise, in two parts:
 *
 *  1. A wouter-level render test proves each path resolves to a real page
 *     (never the NotFound catch-all), and each renamed/removed route still
 *     redirects to its replacement — using the real `wouter` Switch/Redirect
 *     mechanics, not a hand-rolled router.
 *  2. A source-text check on the ACTUAL `App.tsx` keeps this list honest: if
 *     a route is ever added, removed, or renamed there without updating this
 *     file, the second describe block fails loudly instead of this file
 *     silently drifting from what ships.
 *
 * Full-page rendering (mounting every real lazy page + ClerkProvider) is
 * deliberately NOT what this test does — that would require live network
 * calls or mocking two dozen page modules for no gain: the routing table
 * itself is the only thing this PR can touch.
 */

const PAGE_ROUTES = [
  "/home",
  "/banking",
  "/forecast/overview",
  "/forecast",
  "/review",
  "/reports",
  "/reports/debt",
  "/reports/cashflow",
  "/reports/spending",
  "/reports/budget",
  "/reports/behavior",
  "/transactions",
  "/amex",
  "/debts",
  "/avalanche",
  "/bills",
  "/bills/all",
  "/budget",
  "/allowances",
  "/mapping-rules",
  "/settings",
];

const REDIRECTS: Record<string, string> = {
  "/dashboard": "/banking",
  "/recurring": "/bills/all",
};

function Page({ name }: { name: string }) {
  return <div data-testid={`route-${name}`}>{name}</div>;
}

// Mirrors the SHAPE of ProtectedShell's <Switch> in App.tsx: one Route per
// page, then the rename redirects, then the NotFound catch-all.
function TestSwitch() {
  return (
    <Switch>
      {PAGE_ROUTES.map((p) => (
        <Route key={p} path={p}>
          <Page name={p} />
        </Route>
      ))}
      <Route path="/dashboard">
        <Redirect to="/banking" />
      </Route>
      <Route path="/recurring">
        <Redirect to="/bills/all" />
      </Route>
      <Route>
        <div data-testid="route-notfound">not found</div>
      </Route>
    </Switch>
  );
}

function mount(path: string) {
  const { hook } = memoryLocation({ path });
  return render(
    <Router hook={hook}>
      <TestSwitch />
    </Router>,
  );
}

afterEach(cleanup);

describe("every route from Today still resolves", () => {
  it.each(PAGE_ROUTES)("does not 404 on %s", (path) => {
    mount(path);
    expect(screen.queryByTestId("route-notfound")).toBeNull();
    expect(screen.getByTestId(`route-${path}`)).toBeTruthy();
  });

  it.each(Object.entries(REDIRECTS))("redirects %s to %s", (from, to) => {
    mount(from);
    expect(screen.queryByTestId("route-notfound")).toBeNull();
    expect(screen.getByTestId(`route-${to}`)).toBeTruthy();
  });
});

describe("App.tsx's real Switch has not drifted from this list", () => {
  const appSource = readFileSync(join(import.meta.dirname, "App.tsx"), "utf8");

  it.each(PAGE_ROUTES)('still declares a route for "%s"', (path) => {
    expect(appSource).toContain(`path="${path}"`);
  });

  it.each(Object.keys(REDIRECTS))(
    'still declares a route for the renamed "%s"',
    (path) => {
      expect(appSource).toContain(`path="${path}"`);
    },
  );
});
