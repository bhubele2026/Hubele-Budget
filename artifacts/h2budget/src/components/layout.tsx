import { Link, useLocation } from "wouter";
import { UserButton } from "@clerk/react";
import { 
  LayoutDashboard, 
  Receipt, 
  CreditCard, 
  CalendarDays, 
  PieChart, 
  Settings, 
  GitMerge
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { name: "Transactions", href: "/transactions", icon: Receipt },
  { name: "Debts", href: "/debts", icon: CreditCard },
  { name: "Recurring", href: "/recurring", icon: CalendarDays },
  { name: "Budget", href: "/budget", icon: PieChart },
  { name: "Mapping Rules", href: "/mapping-rules", icon: GitMerge },
  { name: "Settings", href: "/settings", icon: Settings },
];

export function AppLayout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="min-h-screen bg-background flex flex-col md:flex-row">
      <aside className="w-full md:w-64 bg-sidebar border-r border-sidebar-border flex flex-col">
        <div className="p-4 border-b border-sidebar-border flex items-center gap-3">
          <img src={`${import.meta.env.BASE_URL}logo.png`} alt="H2 Budget" className="w-8 h-8 rounded" />
          <span className="font-serif font-bold text-lg tracking-tight text-sidebar-foreground">H2 Budget</span>
        </div>
        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
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
                  {item.name}
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
      <main className="flex-1 overflow-y-auto">
        <div className="p-4 md:p-8 max-w-6xl mx-auto">
          {children}
        </div>
      </main>
    </div>
  );
}
