/**
 * (C12) Settings' tab list, on its own so the shell can list the sub-pages in
 * the drawer and in More without pulling the tabs' lazy importers (which stay
 * in `settingsTabs.ts`) into the landing chunk: Rollup keeps a module whole,
 * so importing anything from `settingsTabs.ts` would bring all of it.
 * The tab rides the query string; see `settingsTabs.ts`.
 */
export type SettingsTab =
  | "banks"
  | "household"
  | "data"
  | "automation"
  | "morning-text"
  | "ai"
  | "memory"
  | "privacy";

export const SETTINGS_TABS: ReadonlyArray<{ key: SettingsTab; label: string }> = [
  { key: "banks", label: "Banks" },
  { key: "household", label: "Household" },
  { key: "data", label: "Data" },
  { key: "automation", label: "Automation" },
  { key: "morning-text", label: "Morning text" },
  { key: "ai", label: "AI cost" },
  { key: "memory", label: "Memory" },
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
