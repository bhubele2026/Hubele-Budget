import { useState } from "react";
import { Link, useLocation } from "wouter";
import { UserButton } from "@clerk/react";
import {
  Receipt,
  CreditCard,
  Inbox,
  TrendingUp,
  CalendarCheck,
  BarChart3,
  PieChart,
  CalendarDays,
  Wallet,
  Landmark,
  Flame,
  Settings as SettingsIcon,
  Menu,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useReviewInboxCount } from "@/hooks/useReviewInboxCount";
import { useDebriefAwaitingCount } from "@/hooks/useDebriefAwaitingCount";
import { AdvisorChat } from "@/components/advisor-chat";
import { ThemeToggle } from "@/components/theme-toggle";

type NavItem = { name: string; href: string; icon: typeof Receipt };

// Top bar — plan & analyze sections.
const TOP_NAV: NavItem[] = [
  { name: "Reports", href: "/reports", icon: BarChart3 },
  { name: "Budget", href: "/budget", icon: PieChart },
  { name: "Bills", href: "/bills", icon: CalendarDays },
  { name: "Allowances", href: "/allowances", icon: Wallet },
  { name: "Debts", href: "/debts", icon: Landmark },
  { name: "Avalanche", href: "/avalanche", icon: Flame },
];

// Left rail — accounts, reconciliation & periods.
const RAIL_NAV: NavItem[] = [
  { name: "Chase", href: "/transactions", icon: Receipt },
  { name: "American Express", href: "/amex", icon: CreditCard },
  { name: "Review", href: "/review", icon: Inbox },
  { name: "Forecast", href: "/forecast", icon: TrendingUp },
  { name: "Debrief", href: "/debrief", icon: CalendarCheck },
];

const SETTINGS_ITEM: NavItem = {
  name: "Settings",
  href: "/settings",
  icon: SettingsIcon,
};
const ALL_NAV = [...TOP_NAV, ...RAIL_NAV, SETTINGS_ITEM];

const BRAND = (
  <span className="flex items-center gap-2 select-none">
    <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white text-primary font-bold text-[13px] tracking-tight shadow-sm">
      H2
    </span>
    <span className="font-semibold text-[15px] tracking-tight">Budget</span>
  </span>
);

function MobileNav({
  location,
  onNavigate,
  railBadge,
}: {
  location: string;
  onNavigate: () => void;
  railBadge: (href: string) => number | null;
}) {
  const groups: { label: string; items: NavItem[] }[] = [
    { label: "Accounts & periods", items: RAIL_NAV },
    { label: "Plan & analyze", items: TOP_NAV },
    { label: "", items: [SETTINGS_ITEM] },
  ];
  return (
    <div className="flex flex-col h-full bg-sidebar">
      <div className="px-5 py-4 border-b border-sidebar-border text-sidebar-foreground">
        {BRAND}
      </div>
      <nav className="flex-1 overflow-y-auto p-3 space-y-4">
        {groups.map((g, i) => (
          <div key={g.label || `g-${i}`}>
            {g.label && (
              <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {g.label}
              </div>
            )}
            <div className="space-y-0.5">
              {g.items.map((item) => {
                const active = location.startsWith(item.href);
                const badge = railBadge(item.href);
                return (
                  <Link key={item.href} href={item.href}>
                    <span
                      onClick={onNavigate}
                      className={cn(
                        "flex items-center gap-3 px-3 py-2 rounded-md text-sm cursor-pointer",
                        active
                          ? "bg-primary/10 text-primary font-semibold"
                          : "text-sidebar-foreground/80 hover:bg-sidebar-accent",
                      )}
                    >
                      <item.icon className="w-4 h-4" />
                      <span className="flex-1">{item.name}</span>
                      {badge !== null && (
                        <Badge
                          variant="outline"
                          className="bg-amber-100 text-amber-900 border-amber-300 text-[10px] px-1.5 py-0 h-5 tabular-nums"
                        >
                          {badge}
                        </Badge>
                      )}
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
      <div className="border-t border-sidebar-border p-4 flex items-center justify-between">
        <span className="text-sm font-medium text-sidebar-foreground">
          Account
        </span>
        <div className="flex items-center gap-1">
          <ThemeToggle />
          <UserButton />
        </div>
      </div>
    </div>
  );
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const reviewCount = useReviewInboxCount();
  const debriefCount = useDebriefAwaitingCount();

  const railBadge = (href: string): number | null => {
    if (href === "/review" && reviewCount > 0) return reviewCount;
    if (href === "/debrief" && debriefCount > 0) return debriefCount;
    return null;
  };

  const currentTitle =
    ALL_NAV.find((n) => location.startsWith(n.href))?.name ?? "H2 Budget";

  return (
    <div className="h-screen overflow-hidden bg-background flex flex-col">
      {/* ── Top bar: brand · plan-&-analyze nav · settings gear ───────────── */}
      <header className="shrink-0 bg-primary text-primary-foreground border-b border-black/20 shadow-[inset_0_1px_0_0_hsl(0_0%_100%/0.08)]">
        <div className="flex items-center h-14">
          {/* Brand — desktop: pinned to the rail width (w-52) with matching
              padding so "H2 Budget" sits directly above the left rail and the
              top-nav starts where the main content does. */}
          <Link href="/reports">
            <span className="hidden md:flex items-center h-14 w-52 px-4 cursor-pointer">
              {BRAND}
            </span>
          </Link>

          {/* Mobile: hamburger + brand */}
          <div className="md:hidden flex items-center gap-1 pl-1">
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-primary-foreground hover:bg-white/10"
                  aria-label="Open navigation menu"
                  data-testid="button-mobile-menu"
                >
                  <Menu className="w-5 h-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="p-0 w-72 flex flex-col">
                <MobileNav
                  location={location}
                  onNavigate={() => setMobileOpen(false)}
                  railBadge={railBadge}
                />
              </SheetContent>
            </Sheet>
            <Link href="/reports">
              <span className="cursor-pointer">{BRAND}</span>
            </Link>
          </div>

          <nav className="hidden md:flex items-center gap-0.5">
            {TOP_NAV.map((item) => {
              const active = location.startsWith(item.href);
              return (
                <Link key={item.href} href={item.href}>
                  <span
                    className={cn(
                      "flex items-center gap-2 px-3 h-9 rounded-md text-sm cursor-pointer transition-colors",
                      active
                        ? "bg-white/15 text-white font-semibold"
                        : "text-primary-foreground/75 hover:bg-white/10 hover:text-white",
                    )}
                    data-testid={`topnav-${item.href.slice(1)}`}
                  >
                    <item.icon className="w-4 h-4" />
                    {item.name}
                  </span>
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto flex items-center gap-0.5 pr-3 md:pr-5">
            {/* Mobile shows the current page title between brand and actions. */}
            <span className="md:hidden mr-1 font-semibold truncate max-w-[40vw]">
              {currentTitle}
            </span>
            <ThemeToggle className="text-primary-foreground hover:bg-white/10" />
            <Link href="/settings">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Settings"
                title="Settings"
                data-testid="link-settings"
                className={cn(
                  "text-primary-foreground hover:bg-white/10",
                  location.startsWith("/settings") && "bg-white/15",
                )}
              >
                <SettingsIcon className="w-5 h-5" />
              </Button>
            </Link>
            <UserButton />
          </div>
        </div>
      </header>

      {/* ── Body: left rail (accounts/periods) + main ─────────────────────── */}
      <div className="flex-1 min-h-0 flex">
        <aside className="hidden md:flex flex-col w-52 shrink-0 border-r border-sidebar-border bg-sidebar py-4">
          <div className="px-4 pb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Accounts &amp; periods
          </div>
          <nav className="px-2 space-y-0.5">
            {RAIL_NAV.map((item) => {
              const active = location.startsWith(item.href);
              const badge = railBadge(item.href);
              return (
                <Link key={item.href} href={item.href}>
                  <span
                    className={cn(
                      "relative flex items-center gap-3 px-3 py-2 rounded-md text-sm cursor-pointer transition-colors",
                      active
                        ? "bg-primary/10 text-primary font-semibold"
                        : "text-sidebar-foreground/80 font-medium hover:bg-sidebar-accent hover:text-sidebar-foreground",
                    )}
                    data-testid={`railnav-${item.href.slice(1)}`}
                  >
                    {active && (
                      <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-primary" />
                    )}
                    <item.icon
                      className={cn("w-4 h-4", active && "text-primary")}
                    />
                    <span className="flex-1">{item.name}</span>
                    {badge !== null && (
                      <Badge
                        variant="outline"
                        className="bg-amber-100 text-amber-900 border-amber-300 text-[10px] px-1.5 py-0 h-5 tabular-nums"
                        data-testid={
                          item.href === "/review"
                            ? "badge-review-count"
                            : "badge-debrief-count"
                        }
                      >
                        {badge}
                      </Badge>
                    )}
                  </span>
                </Link>
              );
            })}
          </nav>
        </aside>

        <main className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
          <div className="p-4 md:p-8 max-w-[1800px] mx-auto">{children}</div>
        </main>
      </div>
      <AdvisorChat />
    </div>
  );
}
