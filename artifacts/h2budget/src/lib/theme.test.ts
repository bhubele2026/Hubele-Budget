import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * ⭐ LIGHT AND DARK — the rule, the first-paint script and the pick's storage.
 *
 * `resolveTheme` is the one rule. `index.html` carries a tiny inline copy of it
 * (it has to run before any module loads, so the first paint is already right);
 * the second block here RUNS that script against `resolveTheme` for every pick
 * × device × hour, so the two cannot drift apart.
 */

const customFetch = vi.fn();
vi.mock("@workspace/api-client-react", () => ({ customFetch: (...a: unknown[]) => customFetch(...a) }));

import {
  APPEARANCE_KEY,
  APPEARANCES,
  CLOCK_CHECK_MS,
  THEME_COLOR,
  _resetThemeForTests,
  bootTheme,
  confirmAppearance,
  getAppearance,
  getTheme,
  isAppearance,
  resolveTheme,
  saveAppearance,
  type Appearance,
  type DeviceScheme,
} from "./theme";
import { isDarkNow } from "./themeNow";
import { UpdateUiPreferencesBody, GetMeResponse } from "@workspace/api-zod";

const DEVICES: DeviceScheme[] = ["dark", "light", "none"];
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const night = (h: number) => h >= 19 || h < 7;

describe("resolveTheme — the rule", () => {
  it("Light and Dark are always that, whatever the device or the hour", () => {
    for (const device of DEVICES) for (const hour of HOURS) {
      expect(resolveTheme({ appearance: "light", device, hour })).toBe("light");
      expect(resolveTheme({ appearance: "dark", device, hour })).toBe("dark");
    }
  });

  it("Time of day is the clock alone: dark 19:00 up to 07:00, ignoring the device", () => {
    for (const device of DEVICES) for (const hour of HOURS) {
      expect(resolveTheme({ appearance: "time", device, hour }), `${device} ${hour}`).toBe(night(hour) ? "dark" : "light");
    }
    expect(resolveTheme({ appearance: "time", device: "light", hour: 19 })).toBe("dark");
    expect(resolveTheme({ appearance: "time", device: "dark", hour: 18 })).toBe("light");
    expect(resolveTheme({ appearance: "time", device: "dark", hour: 7 })).toBe("light");
    expect(resolveTheme({ appearance: "time", device: "light", hour: 6 })).toBe("dark");
  });

  it("Auto follows the device, and the clock only where the device states no setting", () => {
    for (const hour of HOURS) {
      expect(resolveTheme({ appearance: "auto", device: "dark", hour })).toBe("dark");
      expect(resolveTheme({ appearance: "auto", device: "light", hour })).toBe("light");
      expect(resolveTheme({ appearance: "auto", device: "none", hour })).toBe(night(hour) ? "dark" : "light");
    }
  });

  it("knows exactly four picks", () => {
    expect([...APPEARANCES]).toEqual(["auto", "light", "dark", "time"]);
    for (const a of APPEARANCES) expect(isAppearance(a)).toBe(true);
    for (const v of ["", "system", "Dark", null, undefined, 1, {}]) expect(isAppearance(v)).toBe(false);
  });

  it("the top bar is navy in both modes, so the browser chrome's colour is the same navy", () => {
    expect(THEME_COLOR.light).toBe("#19315b");
    expect(THEME_COLOR.dark).toBe("#19315b");
  });
});

describe("index.html — the first-paint script is the same rule", () => {
  const html = readFileSync(resolve(import.meta.dirname, "../../index.html"), "utf8");
  const script = /<script id="theme-boot">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";

  /** Run the inline script in a made-up browser; returns the theme it painted. */
  function run(o: { stored: string | null; device: DeviceScheme; hour: number; storageThrows?: boolean; noMatchMedia?: boolean; other?: Record<string, string> }) {
    let painted: "light" | "dark" = "light";
    const localStorage = {
      getItem: (k: string) => {
        if (o.storageThrows) throw new Error("blocked");
        return k === APPEARANCE_KEY ? o.stored : (o.other?.[k] ?? null);
      },
    };
    const matchMedia = o.noMatchMedia
      ? undefined
      : (q: string) => ({ matches: /dark/.test(q) ? o.device === "dark" : /light/.test(q) ? o.device === "light" : false });
    const document = { documentElement: { setAttribute: (k: string, v: string) => { if (k === "data-theme" && v === "dark") painted = "dark"; } } };
    class FakeDate { getHours() { return o.hour; } }
    new Function("localStorage", "matchMedia", "document", "Date", script)(localStorage, matchMedia, document, FakeDate);
    return painted;
  }

  it("is there, small, runs before the stylesheet and the boot shell, and names the same key", () => {
    expect(script.length).toBeGreaterThan(50);
    expect(script.length, "keep it tiny: it is in every document").toBeLessThan(700);
    expect(script).toContain(`"${APPEARANCE_KEY}"`);
    expect(html.indexOf('<script id="theme-boot">')).toBeLessThan(html.indexOf("<style>"));
    expect(html.indexOf('<script id="theme-boot">')).toBeLessThan(html.indexOf('<div id="root">'));
    expect(html).toContain('<meta name="theme-color" content="#19315b" />');
  });

  it("paints what resolveTheme says for every pick × device × hour (4 picks + none + junk, 3 devices, 24 hours)", () => {
    const stored: Array<string | null> = [...APPEARANCES, null, "", "system", "DARK"];
    let n = 0;
    for (const s of stored) for (const device of DEVICES) for (const hour of HOURS) {
      const appearance: Appearance = isAppearance(s) ? s : "auto";
      expect(run({ stored: s, device, hour }), `stored=${s} device=${device} hour=${hour}`).toBe(resolveTheme({ appearance, device, hour }));
      n++;
    }
    expect(n).toBe(8 * 3 * 24);
  });

  it("storage blocked, or no matchMedia at all: still the rule (Auto; then the clock)", () => {
    for (const device of DEVICES) for (const hour of HOURS) {
      expect(run({ stored: "dark", device, hour, storageThrows: true })).toBe(resolveTheme({ appearance: "auto", device, hour }));
      expect(run({ stored: null, device, hour, noMatchMedia: true })).toBe(resolveTheme({ appearance: "auto", device: "none", hour }));
    }
  });

  it("never reads the old key from the dark mode removed in August", () => {
    expect(script).not.toContain("h2budget-theme");
    expect(run({ stored: null, device: "light", hour: 12, other: { "h2budget-theme": "dark" } })).toBe("light");
  });
});

describe("the pick — remembered here, saved for the person, rolled back when refused", () => {
  let device: DeviceScheme = "light";
  let changeListeners: Array<() => void> = [];
  const realMatchMedia = window.matchMedia;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 11, 12, 0, 0)); // noon, local
    device = "light";
    changeListeners = [];
    window.localStorage.clear();
    customFetch.mockReset();
    window.matchMedia = ((q: string) => ({
      get matches() { return /dark/.test(q) ? device === "dark" : /light/.test(q) ? device === "light" : false; },
      media: q,
      addEventListener: (_: string, fn: () => void) => { changeListeners.push(fn); },
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    document.documentElement.removeAttribute("data-theme");
    _resetThemeForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    window.matchMedia = realMatchMedia;
    document.documentElement.removeAttribute("data-theme");
    window.localStorage.clear();
    _resetThemeForTests();
  });

  const attr = () => document.documentElement.getAttribute("data-theme");

  it("a person with no pick is on Auto: the device decides", () => {
    expect(getAppearance()).toBe("auto");
    expect(getTheme()).toBe("light");
    expect(attr()).toBeNull();
    device = "dark";
    _resetThemeForTests();
    expect(getTheme()).toBe("dark");
    expect(attr()).toBe("dark");
    expect(isDarkNow()).toBe(true);
  });

  it("paints the remembered pick at boot, before any server answer", () => {
    window.localStorage.setItem(APPEARANCE_KEY, "dark");
    _resetThemeForTests();
    bootTheme();
    expect(attr()).toBe("dark");
    expect(customFetch).not.toHaveBeenCalled();
  });

  it("ignores the old h2budget-theme key", () => {
    window.localStorage.setItem("h2budget-theme", "dark");
    _resetThemeForTests();
    expect(getAppearance()).toBe("auto");
    expect(attr()).toBeNull();
  });

  it("a pick flips the screen at once, PUTs exactly { appearance }, and is remembered", async () => {
    customFetch.mockResolvedValue({ appearance: "dark" });
    const p = saveAppearance("dark");
    expect(attr()).toBe("dark"); // before the save answered
    expect(getAppearance()).toBe("dark");
    expect(await p).toBe(true);
    expect(customFetch).toHaveBeenCalledTimes(1);
    const [url, init] = customFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/me/ui-preferences");
    expect(init.method).toBe("PUT");
    expect(init.body).toBe('{"appearance":"dark"}');
    expect(window.localStorage.getItem(APPEARANCE_KEY)).toBe("dark");
    expect(attr()).toBe("dark");
  });

  it("a refused save puts back what the server holds, on screen and in memory", async () => {
    confirmAppearance("light");
    customFetch.mockRejectedValue(new Error("500"));
    const p = saveAppearance("dark");
    expect(attr()).toBe("dark");
    expect(await p).toBe(false);
    expect(getAppearance()).toBe("light");
    expect(attr()).toBeNull();
    expect(window.localStorage.getItem(APPEARANCE_KEY)).toBe("light");
  });

  it("of two quick picks only the latest one's answer reaches the screen", async () => {
    let first!: (v: unknown) => void;
    customFetch.mockImplementationOnce(() => new Promise((r) => { first = r; }));
    customFetch.mockResolvedValueOnce({ appearance: "light" });
    const a = saveAppearance("dark");
    const b = saveAppearance("light");
    await b;
    first({ appearance: "dark" });
    await a;
    expect(getAppearance()).toBe("light");
    expect(attr()).toBeNull();
  });

  it("the server's word settles it, except right after this tab's own save", async () => {
    confirmAppearance("dark");
    expect(attr()).toBe("dark");
    expect(window.localStorage.getItem(APPEARANCE_KEY)).toBe("dark");
    confirmAppearance(undefined); // a server with no pick for this person = Auto
    expect(getAppearance()).toBe("auto");
    expect(attr()).toBeNull();
    customFetch.mockResolvedValue({ appearance: "dark" });
    await saveAppearance("dark");
    confirmAppearance("light"); // a stale /me, fetched before the save
    expect(getAppearance()).toBe("dark");
  });

  it("follows the device when it changes, re-reads the clock every five minutes and when the tab comes back", () => {
    bootTheme();
    expect(changeListeners.length).toBeGreaterThanOrEqual(2);
    device = "dark";
    for (const fn of changeListeners) fn();
    expect(attr()).toBe("dark");
    device = "light";
    for (const fn of changeListeners) fn();
    expect(attr()).toBeNull();

    confirmAppearance("time");
    expect(attr()).toBeNull(); // noon
    vi.setSystemTime(new Date(2026, 10, 11, 18, 58, 0));
    vi.advanceTimersByTime(CLOCK_CHECK_MS); // 19:03
    expect(attr()).toBe("dark");

    vi.setSystemTime(new Date(2026, 10, 12, 7, 30, 0));
    expect(attr()).toBe("dark"); // nothing has looked yet
    document.dispatchEvent(new Event("visibilitychange"));
    expect(attr()).toBeNull();
    expect(CLOCK_CHECK_MS).toBe(5 * 60_000);
  });
});

describe("the API carries the pick", () => {
  it("PUT /me/ui-preferences keeps `appearance` (an unknown key would be stripped) and refuses a value that is not one of the four", () => {
    for (const a of APPEARANCES) {
      const r = UpdateUiPreferencesBody.safeParse({ appearance: a });
      expect(r.success && r.data.appearance).toBe(a);
    }
    expect(UpdateUiPreferencesBody.safeParse({ appearance: "mauve" }).success).toBe(false);
  });

  it("GET /me answers it", () => {
    const r = GetMeResponse.safeParse({ userId: "u", isOwner: false, email: null, displayName: null, appearance: "time" });
    expect(r.success && r.data.appearance).toBe("time");
  });
});
