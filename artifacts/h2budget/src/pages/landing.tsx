import { Link } from "wouter";
import { useUser, UserButton } from "@clerk/react";
import { Landmark, Receipt, LineChart, Flame, ArrowRight, Bell } from "lucide-react";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";
import { useReviewInboxCount } from "@/hooks/useReviewInboxCount";

/**
 * Front door. A soft header banner, the account controls (bell + avatar) top
 * right, and four big tiles that route into the app's four areas. The global nav
 * ribbon is hidden here (see layout.tsx) — the tiles ARE the navigation.
 */

type SubLink = { label: string; href: string };

interface Tile {
  key: string;
  title: string;
  blurb: string;
  icon: React.ReactNode;
  href: string;
  links?: SubLink[];
}

const TILES: Tile[] = [
  {
    key: "banking",
    title: "Banking",
    blurb: "How you're spending — this week & month, what to cancel, what to stop buying.",
    icon: <Landmark className="h-5 w-5" />,
    href: "/banking",
    links: [
      { label: "Chase", href: "/transactions" },
      { label: "Amex", href: "/amex" },
      { label: "Allowance", href: "/allowances" },
    ],
  },
  {
    key: "bills",
    title: "Bills",
    blurb:
      "Your recurring bills & subscriptions — with an AI review of what to cut and what's missing.",
    icon: <Receipt className="h-5 w-5" />,
    href: "/bills",
  },
  {
    key: "forecast",
    title: "Forecast",
    blurb: "See what's coming, then review and lock it in.",
    icon: <LineChart className="h-5 w-5" />,
    href: "/forecast",
    links: [
      { label: "Forecast", href: "/forecast" },
      { label: "Review", href: "/review" },
      { label: "Budget", href: "/budget" },
    ],
  },
  {
    key: "avalanche",
    title: "Avalanche",
    blurb: "Attack the debt — manage the payoff plan and free-by date.",
    icon: <Flame className="h-5 w-5" />,
    href: "/avalanche",
    links: [{ label: "Debts", href: "/debts" }],
  },
];

/** Subtle flowing-lines banner — quiet, premium, one-accent. */
function HeaderBanner() {
  return (
    <div className="relative -mx-3 -mt-3 mb-2 h-28 overflow-hidden bg-gradient-to-b from-primary/10 via-primary/5 to-transparent sm:h-36 md:-mx-5 md:-mt-5">
      <svg
        viewBox="0 0 1200 200"
        preserveAspectRatio="none"
        aria-hidden="true"
        className="absolute inset-0 h-full w-full text-primary"
      >
        <path
          d="M0,120 C200,60 400,180 600,120 C800,60 1000,180 1200,120"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          opacity="0.45"
        />
        <path
          d="M0,140 C250,90 450,190 700,130 C900,80 1050,170 1200,140"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          opacity="0.3"
        />
        <path
          d="M0,100 C300,150 500,40 800,100 C1000,140 1100,70 1200,100"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          opacity="0.22"
        />
        {[
          [140, 78],
          [420, 132],
          [700, 96],
          [980, 150],
          [1120, 84],
        ].map(([cx, cy], i) => (
          <circle key={i} cx={cx} cy={cy} r="2.5" fill="currentColor" opacity="0.4" />
        ))}
      </svg>
    </div>
  );
}

export default function LandingPage() {
  const { user } = useUser();
  const who = user?.firstName?.trim() || "Hubeles";
  const reviewCount = useReviewInboxCount();

  return (
    <div className="w-full">
      <HeaderBanner />

      <div className="mx-auto w-full max-w-5xl px-2 pb-12 sm:px-4">
        {/* Greeting + account controls */}
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Hey, {who}.</h1>
            <p className="mt-1 text-base text-muted-foreground">
              Where do you want to go?
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/review"
              aria-label={
                reviewCount > 0 ? `${reviewCount} items to review` : "Review inbox"
              }
              data-testid="landing-bell"
              className="relative inline-flex h-9 w-9 items-center justify-center rounded-full border border-card-border bg-card text-muted-foreground transition-colors hover:text-primary"
            >
              <Bell className="h-4 w-4" />
              {reviewCount > 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold leading-none text-destructive-foreground">
                  {reviewCount}
                </span>
              )}
            </Link>
            <ThemeToggle />
            <UserButton />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
          {TILES.map((t) => (
            <div
              key={t.key}
              className="group relative flex min-h-[220px] flex-col rounded-xl border border-card-border bg-card p-7 transition-colors hover:border-primary/50"
              data-testid={`landing-tile-${t.key}`}
            >
              <Link
                href={t.href}
                className="absolute inset-0 rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/40"
                aria-label={t.title}
              />
              <div className="flex items-start justify-between gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  {t.icon}
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
              </div>
              <div className="mt-4 text-xl font-semibold">{t.title}</div>
              <p className="mt-1.5 text-sm text-muted-foreground">{t.blurb}</p>
              {t.links && (
                <div className="relative z-10 mt-auto flex flex-wrap gap-2 pt-5">
                  {t.links.map((l) => (
                    <Link
                      key={l.href}
                      href={l.href}
                      className={cn(
                        "rounded-md border border-card-border px-2.5 py-1 text-xs font-medium",
                        "text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary",
                      )}
                      data-testid={`landing-link-${t.key}-${l.label.toLowerCase()}`}
                    >
                      {l.label}
                    </Link>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
