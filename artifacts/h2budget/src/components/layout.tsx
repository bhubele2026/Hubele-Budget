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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { H2Logo } from "@/components/h2-logo";

const navItems = [
  { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { name: "Forecast", href: "/forecast", icon: TrendingUp },
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
  return (
    <>
      <div className="p-4 border-b border-sidebar-border flex items-center gap-3">
        <H2Logo className="w-8 h-8 rounded" />
        <span className="font-serif font-bold text-lg tracking-tight text-sidebar-foreground">
          H2 Budget
        </span>
      </div>
      <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
        {navItems.map((item) => {
          const isActive = location.startsWith(item.href);
          return (
            <Link key={item.href} href={item.href}>
              <span
                onClick={onNavigate}
                className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-md transition-colors cursor-pointer text-sm font-medium",
                  isActive
                    ? "bg-sidebar-primary text-sidebar-primary-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent",
                )}
              >
                <item.icon className="w-4 h-4" />
                <span className="flex-1">{item.name}</span>
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
          className="flex-1 min-w-0 text-center font-serif font-bold text-base tracking-tight text-sidebar-foreground truncate"
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
