import { Link } from "wouter";
import { useUser } from "@clerk/react";
import { Landmark, Receipt, LineChart, Flame, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Front door. Four big tiles route into the app's four areas; the spending
 * overview (dashboard) sits one step in, reachable from the link below the
 * tiles. Intentionally quiet — pick where you're going, then dive in.
 */

type SubLink = { label: string; href: string };

interface Tile {
  key: string;
  title: string;
  blurb: string;
  icon: React.ReactNode;
  href: string; // primary destination (whole tile is a link)
  links?: SubLink[]; // optional secondary jump points
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

export default function LandingPage() {
  const { user } = useUser();
  const who = user?.firstName?.trim() || "Hubeles";

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Hey, {who}.</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Where do you want to go?
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {TILES.map((t) => (
          <div
            key={t.key}
            className="group relative rounded-xl border border-card-border bg-card p-5 transition-colors hover:border-primary/50"
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
            <div className="mt-3 text-lg font-semibold">{t.title}</div>
            <p className="mt-1 text-sm text-muted-foreground">{t.blurb}</p>
            {t.links && (
              <div className="relative z-10 mt-3 flex flex-wrap gap-2">
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
  );
}
