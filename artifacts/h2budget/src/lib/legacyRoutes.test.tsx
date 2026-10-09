import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Route, Router, Switch } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { legacyTarget } from "@/lib/legacyRoutes";
import NotFound from "@/pages/not-found";

/**
 * (The switch) Every route of the interim H2 app that used to live at `/`
 * lands on the page of this app that holds the same thing. The not-found page
 * does the redirect, so the table never reaches the open path.
 */
const OLD: Array<[string, string]> = [
  ["/today", "/home"],
  ["/activity", "/review/categories"],
  ["/activity/review", "/review/categories"],
  ["/activity/rules", "/mapping-rules"],
  ["/plan", "/allowances"],
  ["/plan/bills", "/bills"],
  ["/plan/debt", "/avalanche"],
  ["/plan/categories", "/budget"],
  ["/plan/wishlist", "/wishlist"],
  ["/plan/proposals", "/review/suggestions"],
  ["/ask/memory", "/settings?tab=memory"],
  ["/household", "/settings?tab=household"],
  ["/household/members", "/settings?tab=household"],
  ["/household/ai", "/settings?tab=ai"],
  ["/household/automation", "/settings?tab=automation"],
  ["/recap", "/settings?tab=morning-text"],
  ["/design", "/home"],
  ["/design/activity/review", "/home"],
];

afterEach(cleanup);

function renderAt(path: string) {
  const { hook, searchHook, history } = memoryLocation({ path, record: true });
  // As in App.tsx: the real routes first, the not-found page last.
  render(
    <Router hook={hook} searchHook={searchHook}>
      <Switch>
        <Route path="/settings">
          <div data-testid="landed-settings" />
        </Route>
        <Route path="/transactions">
          <div data-testid="landed-transactions" />
        </Route>
        <Route component={NotFound} />
      </Switch>
    </Router>,
  );
  return history;
}

describe("legacyTarget", () => {
  it.each(OLD)("%s → %s", (from, to) => {
    expect(legacyTarget(from)).toBe(to);
    expect(legacyTarget(`${from}/`)).toBe(to);
  });

  it("an Ask answer's transaction link opens that transaction on Chase", () => {
    expect(legacyTarget("/activity", "?txn=abc-123")).toBe("/transactions?tx=abc-123");
    expect(legacyTarget("/activity", "?txn=a%26b")).toBe("/transactions?tx=a%26b");
  });

  it("anything that was never a route stays a 404; this app's own paths are not touched", () => {
    for (const p of ["/nope", "/planner", "/activityx", "/home", "/ask", "/plaid-oauth", "/settings", "/"]) {
      expect(legacyTarget(p), p).toBeNull();
    }
  });
});

describe("the not-found page", () => {
  it("redirects a known old path, replacing the history entry", () => {
    const history = renderAt("/household/automation");
    expect(history.at(-1)).toBe("/settings?tab=automation");
    expect(history).toHaveLength(1);
    expect(screen.getByTestId("landed-settings")).toBeTruthy();
    expect(screen.queryByText("404")).toBeNull();
  });

  it("carries an old transaction link's id across", () => {
    const history = renderAt("/activity?txn=t9");
    expect(history.at(-1)).toBe("/transactions?tx=t9");
    expect(screen.getByTestId("landed-transactions")).toBeTruthy();
  });

  it("is still a 404 for a path that never existed", () => {
    renderAt("/never-a-route");
    expect(screen.getByText("404")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /doesn.t exist/i })).toBeTruthy();
  });
});
