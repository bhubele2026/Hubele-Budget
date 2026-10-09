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
// The list, `tabOf` and `tabHref` live in `settingsTabList.ts` (the shell
// reads them); the lazy importers stay here, off the landing path.
export * from "./settingsTabList";
import type { SettingsTab } from "./settingsTabList";

/** The fold-in tabs are their own lazy chunks; hovering a tab warms it. */
export const importAutomationTab = () => import("./AutomationTab");
export const importMorningTextTab = () => import("./MorningTextTab");
export const importAiCostTab = () => import("./AiCostTab");
/** (F8) What H2 remembers — the Ask memory, edited here. */
export const importMemoryTab = () => import("./MemoryTab");

export const TAB_PREFETCH: Partial<Record<SettingsTab, () => Promise<unknown>>> = {
  automation: importAutomationTab,
  "morning-text": importMorningTextTab,
  ai: importAiCostTab,
  memory: importMemoryTab,
};
