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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { H2Logo } from "@/components/h2-logo";
import { useReviewInboxCount } from "@/hooks/useReviewInboxCount";

const navItems = [
  { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { name: "Forecast", href: "/forecast", icon: TrendingUp },
  { name: "Review", href: "/review", icon: Inbox },
  { name: "Chase", href: "/transactions", icon: Receipt },
  { name: "American Express", href: "/amex", icon: CreditCard },
  { name: "Debts", href: "/debts", icon: CreditCard },
  { name: "Avalanche", href: "/avalanche", icon: Flame },
  { name: "Bills", href: "/bills", icon: CalendarDays },
  { name: "Budget", href: "/budget", icon: PieChart },
  { name: "Reports", href: "/reports", icon: BarChart3 },
  { name: "Mapping Rules", href: "/mapping-rules", icon: GitMerge },
  { name: "Settings", href: "/settings", icon: Settings },
];

function SidebarContents({
  location,
  onNavigate,
}: {
  location: string;
  onNavigate?: () => void;
}) {
  const reviewCount = useReviewInboxCount();
  return (
    <>
      <div className="px-5 py-4 border-b border-sidebar-border flex items-center gap-2.5">
        <H2Logo className="w-8 h-8 rounded-md" />
        <div className="flex flex-col leading-tight">
          <span className="font-semibold text-[15px] tracking-tight text-sidebar-foreground">
            H2 Budget
          </span>
          <span className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            Family finance
          </span>
        </div>
      </div>
      <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = location.startsWith(item.href);
          const showBadge = item.href === "/review" && reviewCount > 0;
          return (
            <Link key={item.href} href={item.href}>
              <span
                onClick={onNavigate}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-md transition-colors cursor-pointer text-sm",
                  isActive
                    ? "bg-sidebar-primary/10 text-sidebar-primary font-semibold"
                    : "text-sidebar-foreground/80 font-medium hover:bg-sidebar-accent hover:text-sidebar-foreground",
                )}
              >
                <item.icon className={cn("w-4 h-4", isActive && "text-sidebar-primary")} />
                <span className="flex-1">{item.name}</span>
                {showBadge && (
                  <Badge
                    variant="outline"
                    className="bg-amber-100 text-amber-900 border-amber-300 text-[10px] px-1.5 py-0 h-5 tabular-nums"
                    data-testid="badge-review-count"
                  >
                    {reviewCount}
                  </Badge>
                )}
              </span>
            </Link>
          );
        })}
      </nav>
      <div className="p-4 border-t border-sidebar-border flex items-center justify-between">
        <span className="text-sm font-medium text-sidebar-foreground">Account</span>
        <UserButton />
      </div>
    </>
  );
}

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  const currentPageTitle =
    navItems.find((item) => location.startsWith(item.href))?.name ?? "H2 Budget";

  return (
    <div className="h-screen overflow-hidden bg-background flex flex-col md:flex-row">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-64 bg-sidebar border-r border-sidebar-border flex-col">
        <SidebarContents location={location} />
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
        <div className="shrink-0">
          <UserButton />
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        <div className="p-4 md:p-8 max-w-6xl mx-auto">{children}</div>
      </main>
    </div>
  );
}
