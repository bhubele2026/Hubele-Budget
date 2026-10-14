import { SETTINGS_TABS, tabHref, tabOf, type SettingsTab } from "@/pages/settings/settingsTabList";
import type { NavItem } from "@/lib/navModel";

/**
 * (C12) Settings' sub-pages, listed beneath Settings in the drawer and in More.
 * They are the page's own tabs (`settingsTabs.ts`, the one list), minus Banks:
 * Banks is plain `/settings`, which the Settings row itself already opens.
 */
export const SETTINGS_PAGES: (NavItem & { tab: SettingsTab })[] = SETTINGS_TABS.filter((t) => t.key !== "banks").map(
  (t) => ({ name: t.label, href: tabHref(t.key), testId: `settings-${t.key}`, tab: t.key }),
);

/** The Settings sub-page open at this URL, or null (not Settings, or Banks). */
export function openSettingsSub(location: string, search: string): SettingsTab | null {
  if (location !== "/settings") return null;
  const tab = tabOf(search);
  return tab === "banks" ? null : tab;
}
