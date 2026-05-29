import { useState } from "react";
import { Link, useLocation } from "wouter";
import { UserButton } from "@clerk/react";
import {
  LayoutDashboard,
  Receipt,
  CreditCard,
  CalendarDays,
  PieChart,
  Settings,
  GitMerge,
  TrendingUp,
  BarChart3,
  Flame,
  Menu,
  Inbox,
  CalendarCheck,
  Wallet,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { H2Logo } from "@/components/h2-logo";
import { useReviewInboxCount } from "@/hooks/useReviewInboxCount";
import { useDebriefAwaitingCount } from "@/hooks/useDebriefAwaitingCount";
import { AdvisorChat } from "@/components/advisor-chat";
import { ThemeToggle } from "@/components/theme-toggle";

const SIDEBAR_COLLAPSED_KEY = "h2:sidebar-collapsed";

const navItems = [
  { name: "Reports", href: "/reports", icon: BarChart3 },
  { name: "Allowances", href: "/allowances", icon: Wallet },
  { name: "Forecast", href: "/forecast", icon: TrendingUp },
  { name: "Review", href: "/review", icon: Inbox },
  { name: "Debrief", href: "/debrief", icon: CalendarCheck },
  { name: "Chase", href: "/transactions", icon: Receipt },
  { name: "American Express", href: "/amex", icon: CreditCard },
  { name: "Avalanche", href: "/avalanche", icon: Flame },
  { name: "Bills", href: "/bills", icon: CalendarDays },
  { name: "Budget", href: "/budget", icon: PieChart },
  { name: "Debts", href: "/debts", icon: CreditCard },
  { name: "Mapping Rules", href: "/mapping-rules", icon: GitMerge },
  { name: "Settings", href: "/settings", icon: Settings },
];

function SidebarContents({
  location,
  onNavigate,
  collapsed = false,
  onToggleCollapse,
}: {
  location: string;
  onNavigate?: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const reviewCount = useReviewInboxCount();
  const debriefCount = useDebriefAwaitingCount();
  return (
    <>
      <div
        className={cn(
          "border-b border-sidebar-border flex items-center",
          collapsed
            ? "flex-col gap-2 px-2 py-4"
            : "px-5 py-4 gap-2.5",
        )}
      >
        <div
          className={cn(
            "flex items-center",
            collapsed ? "justify-center" : "gap-2.5",
          )}
        >
          <H2Logo className="w-8 h-8 rounded-md" />
          {!collapsed && (
            <div className="flex flex-col leading-tight">
              <span className="font-semibold text-[15px] tracking-tight text-sidebar-foreground">
                H2 Budget
              </span>
              <span className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                Family finance
              </span>
            </div>
          )}
        </div>
        {onToggleCollapse && !collapsed && (
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto text-sidebar-foreground shrink-0"
            aria-label="Collapse sidebar"
            data-testid="button-collapse-sidebar"
            onClick={onToggleCollapse}
          >
            <PanelLeftClose className="w-4 h-4" />
          </Button>
        )}
        {onToggleCollapse && collapsed && (
          <Button
            variant="ghost"
            size="icon"
            className="text-sidebar-foreground shrink-0"
            aria-label="Expand sidebar"
            data-testid="button-collapse-sidebar"
            onClick={onToggleCollapse}
          >
            <PanelLeftOpen className="w-4 h-4" />
          </Button>
        )}
      </div>
      <nav
        className={cn(
          "flex-1 space-y-1 overflow-y-auto",
          collapsed ? "p-2" : "p-4",
        )}
      >
        {navItems.map((item) => {
          const isActive = location.startsWith(item.href);
          const reviewBadge = item.href === "/review" && reviewCount > 0;
          const debriefBadge = item.href === "/debrief" && debriefCount > 0;
          const badgeCount = reviewBadge
            ? reviewCount
            : debriefBadge
              ? debriefCount
              : null;
          const badgeTestId = reviewBadge
            ? "badge-review-count"
            : debriefBadge
              ? "badge-debrief-count"
              : undefined;
          return (
            <Link key={item.href} href={item.href}>
              <span
                onClick={onNavigate}
                title={collapsed ? item.name : undefined}
                className={cn(
                  "flex items-center rounded-md transition-colors cursor-pointer text-sm",
                  collapsed
                    ? "justify-center px-2 py-2"
                    : "gap-3 px-3 py-2",
                  isActive
                    ? "bg-sidebar-primary/10 text-sidebar-primary font-semibold"
                    : "text-sidebar-foreground/80 font-medium hover:bg-sidebar-accent hover:text-sidebar-foreground",
                )}
              >
                <span className="relative flex items-center justify-center">
                  <item.icon
                    className={cn("w-4 h-4", isActive && "text-sidebar-primary")}
                  />
                  {collapsed && badgeCount !== null && (
                    <span
                      className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-amber-400 ring-2 ring-sidebar"
                      data-testid={badgeTestId}
                    />
                  )}
                </span>
                {!collapsed && (
                  <>
                    <span className="flex-1">{item.name}</span>
                    {badgeCount !== null && (
                      <Badge
                        variant="outline"
                        className="bg-amber-100 text-amber-900 border-amber-300 text-[10px] px-1.5 py-0 h-5 tabular-nums"
                        data-testid={badgeTestId}
                      >
                        {badgeCount}
                      </Badge>
                    )}
                  </>
                )}
              </span>
            </Link>
          );
        })}
      </nav>
      <div
        className={cn(
          "border-t border-sidebar-border flex",
          collapsed
            ? "flex-col items-center gap-2 p-2"
            : "items-center justify-between p-4",
        )}
      >
        {!collapsed && (
          <span className="text-sm font-medium text-sidebar-foreground">
            Account
          </span>
        )}
        <div
          className={cn(
            "flex items-center gap-1",
            collapsed && "flex-col",
          )}
        >
          <ThemeToggle />
          <UserButton />
        </div>
      </div>
    </>
  );
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        // ignore persistence errors
      }
      return next;
    });
  };

  const currentPageTitle =
    navItems.find((item) => location.startsWith(item.href))?.name ?? "H2 Budget";

  return (
    <div className="h-screen overflow-hidden bg-background flex flex-col md:flex-row">
      {/* Desktop sidebar */}
      <aside
        className={cn(
          "hidden md:flex bg-sidebar border-r border-sidebar-border flex-col transition-[width] duration-200 ease-in-out",
          collapsed ? "w-16" : "w-64",
        )}
      >
        <SidebarContents
          location={location}
          collapsed={collapsed}
          onToggleCollapse={toggleCollapsed}
        />
      </aside>

      {/* Mobile top bar */}
      <header className="md:hidden flex items-center justify-between gap-2 px-3 h-14 bg-sidebar border-b border-sidebar-border shrink-0">
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="text-sidebar-foreground shrink-0"
              aria-label="Open navigation menu"
              data-testid="button-mobile-menu"
            >
              <Menu className="w-5 h-5" />
            </Button>
          </SheetTrigger>
          <SheetContent
            side="left"
            className="p-0 w-72 bg-sidebar border-sidebar-border flex flex-col"
          >
            <SidebarContents
              location={location}
              onNavigate={() => setMobileOpen(false)}
            />
          </SheetContent>
        </Sheet>
        <div
          className="flex-1 min-w-0 text-center font-semibold text-base tracking-tight text-sidebar-foreground truncate"
          data-testid="text-mobile-page-title"
        >
          {currentPageTitle}
        </div>
        <div className="shrink-0 flex items-center gap-1">
          <ThemeToggle />
          <UserButton />
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        <div className="p-4 md:p-8 max-w-6xl mx-auto">{children}</div>
      </main>
      <AdvisorChat />
    </div>
  );
}
