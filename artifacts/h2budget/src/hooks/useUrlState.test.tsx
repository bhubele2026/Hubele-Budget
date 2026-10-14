import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { Router, useSearch } from "wouter";
import { useUrlState, replaceUrlParam, removeUrlParams } from "./useUrlState";
import { modeParam, monthParam, pickParam, urlHasMonth } from "@/lib/ledgerUrl";
import type { MonthKey } from "@/components/account-page/month-navigator";

/**
 * (W1) The ledgers' view lives in the address: month, mode, card/account. A
 * write adds no history entry, keeps every other param, and a fresh mount (a
 * refresh, a shared link, Back) reads the same state.
 */
function Probe() {
  const [month, setMonth] = useUrlState<MonthKey>("month", monthParam, { year: 2026, month: 9 });
  const [mode, setMode] = useUrlState("mode", modeParam, "wk" as const);
  const [card, setCard] = useUrlState("card", pickParam, "all");
  const search = useSearch();
  return (
    <div>
      <span data-testid="state">{`${month.year}-${month.month + 1}|${mode}|${card}`}</span>
      <span data-testid="search">{search}</span>
      <button onClick={() => setMonth({ year: 2026, month: 7 })}>aug</button>
      <button onClick={() => setMode("yr")}>year</button>
      <button onClick={() => setCard("ext-blue")}>blue</button>
      <button onClick={() => setCard("all")}>all</button>
    </div>
  );
}
const mount = () => render(<Router><Probe /></Router>);
const state = () => screen.getByTestId("state").textContent;

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("useUrlState", () => {
  it("starts from the fallbacks when the address names nothing", () => {
    window.history.replaceState(null, "", "/amex");
    mount();
    expect(state()).toBe("2026-10|wk|all");
    expect(urlHasMonth()).toBe(false);
  });

  it("reads month, mode and card from the address", () => {
    window.history.replaceState(null, "", "/amex?month=2026-03-01&mode=month&card=ext-plat");
    mount();
    expect(state()).toBe("2026-3|mo|ext-plat");
    expect(urlHasMonth()).toBe(true);
  });

  it("ignores a month that is not YYYY-MM-01 and a mode it does not know", () => {
    window.history.replaceState(null, "", "/amex?month=2026-03-15&mode=decade");
    mount();
    expect(state()).toBe("2026-10|wk|all");
  });

  it("writes with replaceState: the address changes, history does not grow, wouter's search follows", () => {
    window.history.replaceState(null, "", "/amex");
    const before = window.history.length;
    mount();
    fireEvent.click(screen.getByText("aug"));
    fireEvent.click(screen.getByText("year"));
    fireEvent.click(screen.getByText("blue"));
    expect(window.location.search).toBe("?month=2026-08-01&mode=year&card=ext-blue");
    // (wouter hands `useSearch` the query without the "?".)
    expect(screen.getByTestId("search").textContent).toBe("month=2026-08-01&mode=year&card=ext-blue");
    expect(window.history.length).toBe(before);
    expect(state()).toBe("2026-8|yr|ext-blue");
  });

  it("round-trips: write, remount, same state", () => {
    window.history.replaceState(null, "", "/transactions");
    mount();
    fireEvent.click(screen.getByText("aug"));
    fireEvent.click(screen.getByText("blue"));
    cleanup();
    mount();
    expect(state()).toBe("2026-8|wk|ext-blue");
  });

  it("keeps other params on every write (tx, category, anything)", () => {
    window.history.replaceState(null, "", "/amex?tx=abc&category=Dining%20%26%20Coffee");
    mount();
    fireEvent.click(screen.getByText("blue"));
    const p = new URLSearchParams(window.location.search);
    expect(p.get("tx")).toBe("abc");
    expect(p.get("category")).toBe("Dining & Coffee");
    expect(p.get("card")).toBe("ext-blue");
  });

  it("the default ('all') removes the param instead of writing it", () => {
    window.history.replaceState(null, "", "/amex?card=ext-blue&month=2026-03-01");
    mount();
    fireEvent.click(screen.getByText("all"));
    expect(window.location.search).toBe("?month=2026-03-01");
  });

  it("removing tx keeps the other params", () => {
    window.history.replaceState(null, "", "/transactions?account=r-chk&month=2026-09-01&tx=t1");
    removeUrlParams("tx");
    expect(window.location.search).toBe("?account=r-chk&month=2026-09-01");
  });

  it("Back/Forward (popstate) re-reads the address", () => {
    window.history.replaceState(null, "", "/amex?card=ext-blue");
    mount();
    expect(state()).toBe("2026-10|wk|ext-blue");
    act(() => {
      window.history.replaceState(null, "", "/amex?card=ext-plat&mode=year");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(state()).toBe("2026-10|yr|ext-plat");
    act(() => {
      window.history.replaceState(null, "", "/amex");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(state()).toBe("2026-10|wk|all");
  });

  it("replaceUrlParam is a no-op when the address already says it", () => {
    window.history.replaceState(null, "", "/amex?card=x");
    const spy = window.history.replaceState;
    let calls = 0;
    window.history.replaceState = function (...a: Parameters<History["replaceState"]>) {
      calls++;
      return spy.apply(this, a);
    };
    try {
      replaceUrlParam("card", "x");
      expect(calls).toBe(0);
    } finally {
      window.history.replaceState = spy;
    }
  });
});

describe("useUrlState — a page embedded in another route (url: false)", () => {
  function Embedded() {
    const [card, setCard] = useUrlState("card", pickParam, "acct-1", { url: false });
    return (
      <div>
        <span data-testid="card">{card}</span>
        <button onClick={() => setCard("acct-2")}>go</button>
      </div>
    );
  }
  it("ignores the address and never writes to it", () => {
    window.history.replaceState(null, "", "/next/accounts/acct-1?card=other");
    render(<Router><Embedded /></Router>);
    expect(screen.getByTestId("card").textContent).toBe("acct-1");
    fireEvent.click(screen.getByText("go"));
    expect(screen.getByTestId("card").textContent).toBe("acct-2");
    expect(window.location.search).toBe("?card=other");
  });

  it("(W7) a link inside the app that pushes a new ?card= (the Amex section tabs) re-reads it; All cards clears it", () => {
    window.history.replaceState(null, "", "/amex");
    mount();
    expect(state()).toBe("2026-10|wk|all");
    act(() => window.history.pushState(null, "", "/amex?card=hs-amex-blue-2002"));
    expect(state()).toBe("2026-10|wk|hs-amex-blue-2002");
    act(() => window.history.pushState(null, "", "/amex"));
    expect(state()).toBe("2026-10|wk|all");
  });

  it("(W7) a push that leaves this param alone does not disturb a state the page set", () => {
    window.history.replaceState(null, "", "/amex");
    mount();
    fireEvent.click(screen.getByText("year"));
    act(() => window.history.pushState(null, "", "/amex?mode=year&tx=r1"));
    expect(state()).toBe("2026-10|yr|all");
  });
});
