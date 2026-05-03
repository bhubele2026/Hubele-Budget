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
} from "lucide-react";
import { cn } from "@/lib/utils";

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

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="h-screen overflow-hidden bg-background flex flex-col md:flex-row">
      <aside className="w-full md:w-64 bg-sidebar border-r border-sidebar-border flex flex-col">
        <div className="p-4 border-b border-sidebar-border flex items-center gap-3">
          <img src={`${import.meta.env.BASE_URL}logo.png`} alt="H2 Budget" className="w-8 h-8 rounded" />
          <span className="font-serif font-bold text-lg tracking-tight text-sidebar-foreground">H2 Budget</span>
        </div>
        <nav className="flex-1 p-4 space-y-1 overflow-y-auto max-h-[35vh] md:max-h-none">
          {navItems.map((item) => {
            const isActive = location.startsWith(item.href);
            return (
              <Link key={item.href} href={item.href}>
                <span className={cn(
                  "flex items-center gap-3 px-3 py-2 rounded-md transition-colors cursor-pointer text-sm font-medium",
                  isActive 
                    ? "bg-sidebar-primary text-sidebar-primary-foreground" 
                    : "text-sidebar-foreground hover:bg-sidebar-accent"
                )}>
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
      </aside>
      <main className="flex-1 min-h-0 overflow-y-auto">
        <div className="p-4 md:p-8 max-w-6xl mx-auto">
          {children}
        </div>
      </main>
    </div>
  );
}
