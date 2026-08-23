import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

/**
 * ⚠️⚠️ tailwind-merge MUST BE TAUGHT THE DESIGN TOKENS, AND THE FAILURE IS SILENT.
 *
 * The kit adds font sizes (`text-micro`), radii (`rounded-card`) and elevations
 * (`shadow-rest`) as `@theme` tokens. tailwind-merge does not read the theme —
 * it pattern-matches, and `text-<unknown>` falls through its font-size check
 * into the TEXT-COLOUR group. So `cn("bg-brand-navy text-white", "text-micro")`
 * decided the two `text-*` classes conflicted and dropped `text-white`, which
 * shipped a navy button with ink-coloured text at 1.2:1 — caught on the small
 * Button variant, and it would have hit every call site mixing a size step with
 * a colour. `shadow-<unknown>` has the same trap via `shadow-color`.
 *
 * Declaring the scales here is the fix, and it must be extended whenever a new
 * step is added to `@theme` in index.css.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["display", "title", "body", "label", "micro"] }],
      rounded: [{ rounded: ["card", "control"] }],
      shadow: [{ shadow: ["rest", "lift", "over"] }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatCurrency(amount: string | number | undefined | null) {
  if (amount === undefined || amount === null) return "$0.00";
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  if (isNaN(num)) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(num);
}

// Returns the Tailwind class for positive / negative / zero money values,
// resolving against the --positive and --negative tokens in index.css.
export function moneyColorClass(
  amount: string | number | undefined | null,
  opts: { neutralAtZero?: boolean } = {},
): string {
  const num =
    typeof amount === "string"
      ? parseFloat(amount)
      : typeof amount === "number"
        ? amount
        : 0;
  if (!Number.isFinite(num) || (num === 0 && opts.neutralAtZero !== false)) {
    return "text-muted-foreground";
  }
  return num > 0
    ? "text-[hsl(var(--positive))]"
    : "text-[hsl(var(--negative))]";
}

// Render a short, human-friendly "X ago" string for a past timestamp.
// Used by the Forecast bank-snapshot card to show users that the hourly
// Plaid auto-refresh actually ran (Task #285). `now` is injectable so
// the unit test can pin the clock without touching real time.
export function formatRelativeTime(
  iso: string | undefined | null,
  now: Date = new Date(),
): string {
  if (!iso) return "";
  const then = new Date(iso);
  if (isNaN(then.getTime())) return "";
  const diffMs = now.getTime() - then.getTime();
  // Clamp future timestamps (clock skew) to "just now" so we never say
  // "in 3 minutes" — that would look broken on a "last updated" label.
  if (diffMs < 30 * 1000) return "just now";
  const sec = Math.floor(diffMs / 1000);
  const min = Math.floor(sec / 60);
  if (min < 1) return "just now";
  if (min < 60) return `${min} ${min === 1 ? "minute" : "minutes"} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} ${hr === 1 ? "hour" : "hours"} ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 7) return `${day} days ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk} ${wk === 1 ? "week" : "weeks"} ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo} ${mo === 1 ? "month" : "months"} ago`;
  const yr = Math.floor(day / 365);
  return `${yr} ${yr === 1 ? "year" : "years"} ago`;
}

export function formatDate(dateStr: string | undefined | null) {
  if (!dateStr) return "";
  try {
    // Date-only strings (YYYY-MM-DD) parse as UTC midnight but format in the
    // local zone, which shifts them a day early anywhere west of UTC — build
    // them as local dates instead.
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
    const date = m
      ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
      : new Date(dateStr);
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(date);
  } catch (e) {
    return dateStr;
  }
}
