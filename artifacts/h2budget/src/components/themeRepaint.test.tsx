import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { ThemeRepaint } from "./theme-repaint";
import { _resetThemeForTests, bootTheme, confirmAppearance, getRepaintEpoch } from "@/lib/theme";
import { CHART, themed } from "@/lib/chartTokens";
import { inkWasRead, resetInkRead } from "@/lib/themeNow";
import { _resetPerfMarksForTests } from "@/lib/perfMarks";

/**
 * (perf phase 2) THE SAVED APPEARANCE SETTLING AT THE OPEN REPAINTS IN PLACE.
 * Before: /me's pick differing from the browser's re-mounted the page, which cancelled the requests in flight and
 * asked for them again. Now the page re-mounts only when something has drawn in a JS colour (a chart), and even
 * then every request in flight is held across it: nothing is ever asked twice.
 */

const marks = () => performance.getEntriesByType("mark").map((m) => m.name).filter((n) => n.startsWith("h2:theme"));

let mounts = 0;
let fetches = 0;
let abort: AbortSignal | null = null;
function Page({ ink }: { ink: boolean }) {
  // A chart reads its colour in JS at draw time; a plain page does not.
  const colour = ink ? CHART.navy : "token";
  const q = useQuery({
    queryKey: ["/api/slow"],
    queryFn: ({ signal }) => {
      fetches += 1;
      abort = signal;
      return new Promise<string>(() => {});
    },
  });
  useEffect(() => {
    mounts += 1;
  }, []);
  return <div data-testid="page">{colour}:{q.status}</div>;
}

let qc: QueryClient;
const mount = (ink: boolean) =>
  render(
    <QueryClientProvider client={qc}>
      <ThemeRepaint>
        <Page ink={ink} />
      </ThemeRepaint>
    </QueryClientProvider>,
  );

beforeEach(() => {
  window.localStorage.setItem("h2:appearance", "light");
  _resetThemeForTests();
  bootTheme();
  _resetPerfMarksForTests();
  performance.clearMarks();
  resetInkRead();
  mounts = 0;
  fetches = 0;
  abort = null;
  qc = new QueryClient();
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("ThemeRepaint", () => {
  it("nothing drew in JS: the saved pick repaints in place — no re-mount, nothing asked again", async () => {
    mount(false);
    expect(fetches).toBe(1);
    const epoch = getRepaintEpoch();
    await act(async () => confirmAppearance("dark"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(getRepaintEpoch()).toBe(epoch);
    expect(mounts).toBe(1);
    expect(fetches).toBe(1);
    expect(abort!.aborted).toBe(false);
    expect(marks()).toEqual(["h2:theme-settle"]);
  });

  it("a chart drew in JS: the page re-mounts (it must redraw its inks), and the request in flight is held, not asked twice", async () => {
    mount(true);
    expect(screen.getByTestId("page").textContent).toMatch(/^#19315b/);
    await act(async () => confirmAppearance("dark"));
    expect(mounts).toBe(2);
    // The re-mounted chart reads the dark ink.
    expect(screen.getByTestId("page").textContent).not.toMatch(/^#19315b/);
    expect(marks()).toEqual(["h2:theme-repaint"]);
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
    expect(fetches).toBe(1);
    expect(abort!.aborted).toBe(false);
    // …and the hold is let go: the page's own observer is the only one left.
    expect(qc.getQueryCache().find({ queryKey: ["/api/slow"] })!.getObserversCount()).toBe(1);
  });

  it("the theme not changing changes nothing", async () => {
    mount(true);
    await act(async () => confirmAppearance("light"));
    expect(mounts).toBe(1);
    expect(marks()).toEqual([]);
  });
});

describe("what counts as drawing in a JS colour", () => {
  it("building a themed table is not; reading one is", () => {
    resetInkRead();
    const t = themed(() => ({ a: CHART.navy }));
    expect(inkWasRead()).toBe(false);
    void t.a;
    expect(inkWasRead()).toBe(true);
  });
  it("a theme change with no JS colour read leaves the epoch; one after a read moves it, once", async () => {
    resetInkRead();
    const e0 = getRepaintEpoch();
    confirmAppearance("dark");
    expect(getRepaintEpoch()).toBe(e0);
    void CHART.navy;
    confirmAppearance("light");
    expect(getRepaintEpoch()).toBe(e0 + 1);
    confirmAppearance("dark");
    expect(getRepaintEpoch()).toBe(e0 + 1);
  });
});
