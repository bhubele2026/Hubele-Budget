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
  MoreHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useReviewInboxCount } from "@/hooks/useReviewInboxCount";
import { useDebriefAwaitingCount } from "@/hooks/useDebriefAwaitingCount";
import { AdvisorChat } from "@/components/advisor-chat";
import { CancelFloater } from "@/components/cancel-floater";
import { CommandPalette } from "@/components/command-palette";
import { ThemeToggle } from "@/components/theme-toggle";

type NavItem = { name: string; href: string; icon: typeof Receipt };

// One primary row — the five command destinations. "Overview" is the Reports
// hub; the account pages and forecast sit beside it. Everything else is one
// click away in the More overflow.
const PRIMARY_NAV: NavItem[] = [
  { name: "Overview", href: "/reports", icon: BarChart3 },
  { name: "Chase", href: "/transactions", icon: Receipt },
  { name: "Amex", href: "/amex", icon: CreditCard },
  { name: "Allowance", href: "/allowances", icon: Wallet },
  { name: "Forecast", href: "/forecast", icon: TrendingUp },
];

// Secondary destinations, demoted into the More dropdown. Every route stays
// reachable — just one extra click.
const MORE_NAV: NavItem[] = [
  { name: "Budget", href: "/budget", icon: PieChart },
  { name: "Bills", href: "/bills", icon: CalendarDays },
  { name: "Debts", href: "/debts", icon: Landmark },
  { name: "Avalanche", href: "/avalanche", icon: Flame },
  { name: "Debrief", href: "/debrief", icon: CalendarCheck },
  { name: "Review", href: "/review", icon: Inbox },
  { name: "Settings", href: "/settings", icon: SettingsIcon },
];

const ALL_NAV = [...PRIMARY_NAV, ...MORE_NAV];

const BRAND = (
  <span className="flex items-center gap-2 select-none">
    <span className="flex h-6 w-6 items-center justify-center rounded-md bg-gradient-to-br from-[#1e2230] to-[#0e1116] text-[hsl(255_92%_76%)] font-bold text-[11px] tracking-tight border border-[#2d3345]">
      H2
    </span>
    <span className="font-semibold text-[13.5px] tracking-tight">Budget</span>
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
    { label: "Command", items: PRIMARY_NAV },
    { label: "More", items: MORE_NAV },
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

  // Is any secondary (More) destination the current page, and do any of them
  // carry a pending badge — so the collapsed More trigger can signal both.
  const moreActive = MORE_NAV.some((n) => location.startsWith(n.href));
  const moreBadgeTotal = MORE_NAV.reduce(
    (sum, n) => sum + (railBadge(n.href) ?? 0),
    0,
  );

  const currentTitle =
    ALL_NAV.find((n) => location.startsWith(n.href))?.name ?? "H2 Budget";

  return (
    <div className="h-screen overflow-hidden bg-background flex flex-col">
      {/* ── Top bar: brand · plan-&-analyze nav · settings gear ───────────── */}
      <header className="shrink-0 bg-[#0e1116] text-[#f3f4f6] border-b border-[#1e2230]">
        <div className="flex items-center h-11">
          {/* Brand — desktop: pinned to the rail width (w-52) with matching
              padding so "H2 Budget" sits directly above the left rail and the
              top-nav starts where the main content does. */}
          <Link href="/home">
            <span className="hidden md:flex items-center h-11 pl-4 pr-5 cursor-pointer">
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
                  className="text-[#f3f4f6] hover:bg-[#13161c]"
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
            <Link href="/home">
              <span className="cursor-pointer">{BRAND}</span>
            </Link>
          </div>

          <nav className="hidden md:flex items-center gap-0.5">
            {PRIMARY_NAV.map((item) => {
              const active = location.startsWith(item.href);
              return (
                <Link key={item.href} href={item.href}>
                  <span
                    className={cn(
                      "flex items-center gap-1.5 px-2.5 h-8 rounded-md text-[13px] cursor-pointer transition-colors",
                      active
                        ? "bg-[#13161c] text-[#f3f4f6] font-semibold ring-1 ring-[#7c3aed]/40"
                        : "text-[#8e95a3] hover:bg-[#13161c] hover:text-[#f3f4f6]",
                    )}
                    data-testid={`topnav-${item.href.slice(1)}`}
                  >
                    <item.icon className="w-4 h-4" />
                    {item.name}
                  </span>
                </Link>
              );
            })}

            {/* More overflow — secondary destinations, one click away. */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "relative flex items-center gap-1.5 px-2.5 h-8 rounded-md text-[13px] cursor-pointer transition-colors outline-none",
                    moreActive
                      ? "bg-[#13161c] text-[#f3f4f6] font-semibold ring-1 ring-[#7c3aed]/40"
                      : "text-[#8e95a3] hover:bg-[#13161c] hover:text-[#f3f4f6]",
                  )}
                  data-testid="topnav-more"
                  aria-label="More destinations"
                >
                  <MoreHorizontal className="w-4 h-4" />
                  More
                  {moreBadgeTotal > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-[#7c3aed]" />
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {MORE_NAV.map((item) => {
                  const badge = railBadge(item.href);
                  return (
                    <DropdownMenuItem key={item.href} asChild>
                      <Link
                        href={item.href}
                        className="flex items-center gap-2.5 cursor-pointer"
                        data-testid={`morenav-${item.href.slice(1)}`}
                      >
                        <item.icon className="w-4 h-4 text-muted-foreground" />
                        <span className="flex-1">{item.name}</span>
                        {badge !== null && (
                          <Badge
                            variant="outline"
                            className="bg-amber-100 text-amber-900 border-amber-300 text-[10px] px-1.5 py-0 h-5 tabular-nums"
                          >
                            {badge}
                          </Badge>
                        )}
                      </Link>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          </nav>

          <div className="ml-auto flex items-center gap-0.5 pr-3 md:pr-5">
            {/* Mobile shows the current page title between brand and actions. */}
            <span className="md:hidden mr-1 font-semibold truncate max-w-[40vw]">
              {currentTitle}
            </span>
            <ThemeToggle className="text-[#f3f4f6] hover:bg-[#13161c]" />
            <UserButton />
          </div>
        </div>
      </header>

      {/* ── Body: single full-width content column (rail collapsed into the
          top bar's primary row + More overflow) ──────────────────────────── */}
      <div className="flex-1 min-h-0 flex">
        <main className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
          <div className="p-4 md:p-8 max-w-[1240px] mx-auto animate-in fade-in slide-in-from-bottom-2 duration-500">
            {children}
          </div>
        </main>
      </div>
      <AdvisorChat />
      <CancelFloater />
      <CommandPalette />
    </div>
  );
}
