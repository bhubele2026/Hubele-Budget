/**
 * (C8) Settings is one area with a local tab bar. The tab rides the query
 * string (`/settings?tab=automation`) rather than the path, so:
 *  - every existing link to `/settings` (dashboard Reconnect, the landing
 *    tile, More, the Plaid OAuth return) still lands on Banks, the first tab;
 *  - the shell, which keys its page entrance on the PATH, does not remount
 *    the page on a tab change — unsaved edits on one tab survive a look at
 *    another, and only the tab's content moves;
 *  - `App.tsx`, `routePrefetch.ts` and the route table need no new route.
 */
export type SettingsTab =
  | "banks"
  | "household"
  | "data"
  | "automation"
  | "morning-text"
  | "ai"
  | "privacy";

export const SETTINGS_TABS: ReadonlyArray<{ key: SettingsTab; label: string }> = [
  { key: "banks", label: "Banks" },
  { key: "household", label: "Household" },
  { key: "data", label: "Data" },
  { key: "automation", label: "Automation" },
  { key: "morning-text", label: "Morning text" },
  { key: "ai", label: "AI cost" },
  { key: "privacy", label: "Privacy" },
];

const KEYS = new Set<string>(SETTINGS_TABS.map((t) => t.key));

/** The tab a query string asks for; Banks for none or an unknown one. */
export function tabOf(search: string): SettingsTab {
  const raw = new URLSearchParams(search).get("tab");
  return raw && KEYS.has(raw) ? (raw as SettingsTab) : "banks";
}

/** The link to a tab. Banks is plain `/settings`, as every old link already says. */
export function tabHref(tab: SettingsTab): string {
  return tab === "banks" ? "/settings" : `/settings?tab=${tab}`;
}

/** The three fold-in tabs are their own lazy chunks; hovering a tab warms it. */
export const importAutomationTab = () => import("./AutomationTab");
export const importMorningTextTab = () => import("./MorningTextTab");
export const importAiCostTab = () => import("./AiCostTab");

export const TAB_PREFETCH: Partial<Record<SettingsTab, () => Promise<unknown>>> = {
  automation: importAutomationTab,
  "morning-text": importMorningTextTab,
  ai: importAiCostTab,
};
