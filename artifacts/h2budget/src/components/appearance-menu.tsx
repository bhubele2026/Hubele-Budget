import { useEffect } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { isAppearance, saveAppearance, useAppearance, type Appearance } from "@/lib/theme";
import { toast } from "@/hooks/use-toast";

/**
 * ⭐ APPEARANCE: each person's Auto · Light · Dark · Time of day.
 *
 * Three places, one pick (`lib/theme.ts`): the small button in the top bar
 * (`AppearanceButton`), the row at the foot of the phone drawer and the row in
 * Settings → Household (`AppearanceRow`). A pick flips the screen at once and is
 * saved for the person, so it follows them to every device; a save that fails
 * puts the old pick back and says so.
 *
 * The top bar never re-mounts when the theme changes (only the page under it
 * does, `App.tsx` ThemeRepaint), so the menu stays open and usable across a
 * pick. The Settings row is inside the page and does re-mount: it takes the
 * focus back (`refocus`) so a keyboard user is not dropped.
 */
export const APPEARANCE_CHOICES: ReadonlyArray<readonly [Appearance, string]> = [
  ["auto", "Auto"],
  ["light", "Light"],
  ["dark", "Dark"],
  ["time", "Time of day"],
];
export const APPEARANCE_HINT = "Auto follows this device. Time of day: dark 7 PM–7 AM.";

/** Run a pick; say so if the save was refused (the screen has already gone back). */
function pick(next: Appearance): void {
  void saveAppearance(next).then((ok) => {
    if (!ok) toast({ title: "Appearance was not saved. Try again." });
  });
}

/** A half-filled circle: light and dark. */
function AppearanceIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="h-4 w-4">
      <circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 4.5a7.5 7.5 0 0 1 0 15z" fill="currentColor" />
    </svg>
  );
}

/** The top bar's button and its small menu. */
export function AppearanceButton({ className }: { className?: string }) {
  const value = useAppearance();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Appearance"
          title="Appearance"
          data-testid="header-appearance"
          className={cn(
            "press grid h-7 w-7 place-items-center rounded-control text-chrome-ink-2 hover:bg-chrome-press hover:text-chrome-ink data-[state=open]:bg-chrome-press data-[state=open]:text-chrome-ink",
            className,
          )}
        >
          <AppearanceIcon />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60" data-testid="appearance-menu" aria-label="Appearance">
        <DropdownMenuLabel className="text-micro font-semibold uppercase tracking-wide text-neutral-500">
          Appearance
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => isAppearance(v) && pick(v)}>
          {APPEARANCE_CHOICES.map(([key, name]) => (
            <DropdownMenuRadioItem
              key={key}
              value={key}
              data-testid={`appearance-${key}`}
              // Stay open: the other choices are one click away after a pick.
              onSelect={(e) => e.preventDefault()}
            >
              {name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <p className="px-2 pb-1 pt-1.5 text-micro leading-snug text-neutral-500" data-testid="appearance-hint">
          {APPEARANCE_HINT}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The Settings row re-mounts with its page when a pick changes the theme; the
// choice just pressed takes the focus back once it is there again.
let refocus: Appearance | null = null;

/**
 * The same four choices as a row. `tone="chrome"` is for the drawer
 * (chrome tokens only); `tone="page"` for a card.
 */
export function AppearanceRow({ tone, className }: { tone: "chrome" | "page"; className?: string }) {
  const value = useAppearance();
  useEffect(() => {
    if (tone !== "page" || refocus == null) return;
    const key = refocus;
    refocus = null;
    document.querySelector<HTMLElement>(`[data-appearance-row="page"] [data-appearance="${key}"]`)?.focus();
  }, [tone]);
  const chrome = tone === "chrome";
  return (
    <div className={className} data-appearance-row={tone} data-testid={`appearance-row-${tone}`}>
      <div
        role="radiogroup"
        aria-label="Appearance"
        className={cn("flex flex-wrap gap-1.5", chrome && "gap-1")}
      >
        {APPEARANCE_CHOICES.map(([key, name]) => {
          const on = value === key;
          return (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={on}
              data-appearance={key}
              onClick={() => {
                if (!chrome) refocus = key;
                pick(key);
              }}
              className={cn(
                "press rounded-control font-semibold",
                chrome
                  ? cn(
                      "px-2 py-1 text-micro",
                      on ? "bg-chrome-press text-chrome-ink" : "text-chrome-ink-3 hover:bg-chrome-hover hover:text-chrome-ink",
                    )
                  : cn(
                      "px-2.5 py-1 text-label ring-1",
                      on
                        ? "bg-acct-checking-bg text-brand-navy ring-2 ring-brand-navy"
                        : "bg-white text-neutral-700 ring-brand-line hover:bg-neutral-50",
                    ),
              )}
            >
              {name}
            </button>
          );
        })}
      </div>
      <p className={cn("mt-1.5 text-micro leading-snug", chrome ? "text-chrome-ink-3" : "text-neutral-500")}>
        {APPEARANCE_HINT}
      </p>
    </div>
  );
}
