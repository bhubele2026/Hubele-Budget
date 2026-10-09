import { Link } from "wouter";
import { cn } from "@/lib/utils";
import { SETTINGS_TABS, TAB_PREFETCH, tabHref, type SettingsTab } from "./settingsTabs";

/**
 * The local tab bar under the Settings heading: plain links (each tab has its
 * own URL, so Back works and a tab can be linked to), the current one marked
 * with `aria-current` and a navy underline. On a phone the row scrolls
 * sideways instead of wrapping. Hover or focus warms a lazy tab's chunk.
 */
export function SettingsTabBar({ current }: { current: SettingsTab }) {
  return (
    <nav aria-label="Settings sections" data-testid="settings-tabs" className="-mx-1 overflow-x-auto">
      <ul className="flex min-w-max gap-1 border-b border-brand-line px-1">
        {SETTINGS_TABS.map((t) => {
          const active = t.key === current;
          const warm = TAB_PREFETCH[t.key];
          return (
            <li key={t.key}>
              <Link
                href={tabHref(t.key)}
                aria-current={active ? "page" : undefined}
                data-testid={`settings-tab-link-${t.key}`}
                onMouseEnter={warm ? () => void warm() : undefined}
                onFocus={warm ? () => void warm() : undefined}
                className={cn(
                  "press -mb-px block whitespace-nowrap border-b-2 px-3 py-2 text-label font-semibold",
                  active
                    ? "border-brand-navy text-brand-navy"
                    : "border-transparent text-neutral-500 hover:text-brand-navy",
                )}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
