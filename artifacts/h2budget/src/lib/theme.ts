// ⭐ LIGHT AND DARK. Each person picks Auto · Light · Dark · Time of day.
//
// THE RULE (`resolveTheme`, ported from the KFI dashboard):
//   Light / Dark   always that.
//   Time of day    the local clock alone: dark 7 PM to 7 AM, whatever the device says.
//   Auto           the device's own light/dark setting; where the device states
//                  none, the same clock. A person with no pick is on Auto.
// Re-checked when the device setting changes, every five minutes, and when the
// tab comes back into view.
//
// WHERE THE ANSWER GOES: `<html data-theme="dark">` (absent = light). That one
// attribute is all the CSS reads (`index.css`, "DARK"). Colour drawn from JS
// (charts) reads `isDarkNow()` through `lib/chartTokens.ts`; `App.tsx` re-mounts
// the open page once when the theme changes, so every chart redraws.
//
// WHERE THE PICK LIVES: per person on the server (`appearance` in
// `user_ui_preferences`, read from `/api/me`, saved with PUT
// `/api/me/ui-preferences`), and remembered in this browser (`APPEARANCE_KEY`) so
// the right mode paints before the server answers. ⚠️ `index.html` carries a tiny
// inline copy of the rule for the very first paint; `theme.test.ts` runs that
// script against `resolveTheme` for every pick × device × hour, so the two cannot
// drift. The old `h2budget-theme` key (the dark mode removed in August) is never
// read.
//
// ⚠️ ON THE OPEN PATH. This file is imported by `main.tsx`: it must not import
// the generated client's `/ledger` sub-module (`featuresImportGraph.test.ts`),
// which is why the save is one direct call.
import { useSyncExternalStore } from "react";
import { customFetch } from "@workspace/api-client-react";
import { setDarkNow } from "./themeNow";

export type Theme = "light" | "dark";
/** A person's pick. "auto" = the device's setting, else the clock; "time" = the clock alone. */
export type Appearance = "auto" | "light" | "dark" | "time";
/** What the device says: `prefers-color-scheme` dark, light, or neither stated. */
export type DeviceScheme = "dark" | "light" | "none";

export const APPEARANCES: readonly Appearance[] = ["auto", "light", "dark", "time"] as const;
export const isAppearance = (v: unknown): v is Appearance =>
  v === "auto" || v === "light" || v === "dark" || v === "time";

/** The clock's dark hours: from 19:00 up to (not including) 07:00, local time. */
export const DARK_FROM_HOUR = 19;
export const DARK_UNTIL_HOUR = 7;
export const isDarkHour = (hour: number): boolean => hour >= DARK_FROM_HOUR || hour < DARK_UNTIL_HOUR;

/** The theme on screen. Pure. */
export function resolveTheme(o: { appearance: Appearance; device: DeviceScheme; hour: number }): Theme {
  if (o.appearance === "time") return isDarkHour(o.hour) ? "dark" : "light";
  if (o.appearance !== "auto") return o.appearance;
  if (o.device !== "none") return o.device;
  return isDarkHour(o.hour) ? "dark" : "light";
}

/** The browser's memory of the pick (also read by the boot script in index.html). */
export const APPEARANCE_KEY = "h2:appearance";
/** The browser chrome's colour (phone status bar). The top bar is navy in both modes. */
export const THEME_COLOR: Record<Theme, string> = { light: "#19315b", dark: "#19315b" };
/** How often the clock is re-read. */
export const CLOCK_CHECK_MS = 5 * 60_000;
/** The server's word is ignored this long after this tab saved a pick (its own pick is newer). */
export const THEME_HOLD_MS = 120_000;

const listeners = new Set<() => void>();
const emit = () => {
  for (const fn of listeners) fn();
};

function readStored(): Appearance {
  try {
    const v = window.localStorage.getItem(APPEARANCE_KEY);
    return isAppearance(v) ? v : "auto";
  } catch {
    return "auto"; // private mode / storage blocked: never throw
  }
}

// ── The pick: remembered for the first paint, confirmed by /api/me, saved by PUT ──
// Every pick is numbered, so of two quick clicks only the latest one's answer
// reaches the screen; the server's word is ignored while a pick is saving and for
// THEME_HOLD_MS after; a refused pick puts back what the server holds.
let appearance: Appearance = typeof window === "undefined" ? "auto" : readStored();
let saved: Appearance = appearance;
let posting = 0;
let lastSavedAt = 0;
let postSeq = 0;
let savedSeq = 0;
let failedSeq = 0;

function setAppearance(next: Appearance): void {
  if (next === appearance) return;
  appearance = next;
  try {
    window.localStorage.setItem(APPEARANCE_KEY, next);
  } catch {
    /* the in-memory value still drives this session */
  }
  recompute();
}

const media = (q: string): MediaQueryList | null =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(q) : null;
let darkQ: MediaQueryList | null = null;
let lightQ: MediaQueryList | null = null;
const device = (): DeviceScheme => (darkQ?.matches ? "dark" : lightQ?.matches ? "light" : "none");

const resolveNow = (): Theme => resolveTheme({ appearance, device: device(), hour: new Date().getHours() });

let current: Theme = "light";
/** Where the page was scrolled when the theme last changed; App puts the re-mounted page back there. */
let scrollAtChange = 0;

const scroller = (): HTMLElement | null =>
  typeof document === "undefined" ? null : document.querySelector<HTMLElement>("[data-shell-scroller]");
/** The page's scroll position: the shell's one scroller, or the window outside the shell. */
export function readPageScroll(): number {
  if (typeof window === "undefined") return 0;
  return scroller()?.scrollTop || window.scrollY || 0;
}
/** Put the page back at `y` (a no-op when it is there). Returns how far off it WAS. */
export function writePageScroll(y: number): number {
  const el = scroller();
  const was = Math.abs((el ? el.scrollTop : window.scrollY) - y);
  if (was <= 1) return was;
  if (el) el.scrollTop = y;
  else window.scrollTo(0, y);
  return was;
}

/** Write the theme onto <html> and the browser chrome. */
function paint(): void {
  setDarkNow(current === "dark"); // what the charts draw in (lib/chartTokens.ts)
  if (typeof document === "undefined") return;
  // Written only when it differs: the boot script in index.html has usually
  // set it already, and the attribute must not flicker.
  const html = document.documentElement;
  const want = current === "dark" ? "dark" : null;
  if (html.getAttribute("data-theme") !== want) {
    if (want) html.setAttribute("data-theme", want);
    else html.removeAttribute("data-theme");
  }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && meta.getAttribute("content") !== THEME_COLOR[current]) meta.setAttribute("content", THEME_COLOR[current]);
}

function recompute(): void {
  const next = resolveNow();
  if (next !== current) {
    scrollAtChange = readPageScroll();
    current = next;
    paint();
  }
  emit(); // the pick changed even when the theme did not (the menu shows it)
}

let booted = false;
/** At boot, before the first render: paint what this browser knows, then follow the device and the clock. */
export function bootTheme(): void {
  if (typeof window === "undefined") return;
  if (!booted) {
    darkQ = media("(prefers-color-scheme: dark)");
    lightQ = media("(prefers-color-scheme: light)");
  }
  current = resolveNow();
  paint();
  if (booted) return;
  booted = true;
  darkQ?.addEventListener?.("change", recompute);
  lightQ?.addEventListener?.("change", recompute);
  window.setInterval(recompute, CLOCK_CHECK_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) recompute();
  });
}

export const getTheme = (): Theme => current;
export const getAppearance = (): Appearance => appearance;
export const scrollBeforeThemeChange = (): number => scrollAtChange;

/** The server's word from /api/me. Wins unless this tab is saving, or saved within THEME_HOLD_MS. A person with no pick is on Auto. */
export function confirmAppearance(v: unknown): void {
  if (posting > 0) return;
  if (lastSavedAt > 0 && Date.now() - lastSavedAt < THEME_HOLD_MS) return;
  const next: Appearance = isAppearance(v) ? v : "auto";
  saved = next;
  setAppearance(next);
}

/** This person's pick: the screen flips at once, then it is saved for them. A refused save puts the old pick back. */
export async function saveAppearance(next: Appearance): Promise<boolean> {
  const seq = ++postSeq;
  setAppearance(next);
  posting += 1;
  try {
    const back = await customFetch<{ appearance?: unknown }>("/api/me/ui-preferences", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appearance: next }),
    });
    lastSavedAt = Date.now();
    if (seq > savedSeq) {
      savedSeq = seq;
      saved = isAppearance(back?.appearance) ? back.appearance : next;
    }
    if (seq === postSeq || failedSeq === postSeq) setAppearance(saved);
    return true;
  } catch {
    if (seq === postSeq) {
      failedSeq = seq;
      setAppearance(saved);
    }
    return false;
  } finally {
    posting -= 1;
  }
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
/** The theme on screen, re-rendering the caller whenever it changes. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, () => "light" as Theme);
}
/** This person's pick. */
export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, getAppearance, () => "auto" as Appearance);
}

/** Tests only: forget everything and read the browser again. */
export function _resetThemeForTests(): void {
  appearance = typeof window === "undefined" ? "auto" : readStored();
  saved = appearance;
  posting = 0;
  lastSavedAt = 0;
  postSeq = savedSeq = failedSeq = 0;
  scrollAtChange = 0;
  booted = false;
  current = "light";
  if (typeof window !== "undefined") {
    darkQ = media("(prefers-color-scheme: dark)");
    lightQ = media("(prefers-color-scheme: light)");
    current = resolveNow();
    paint();
  }
}
