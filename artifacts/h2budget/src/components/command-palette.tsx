import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  LayoutDashboard,
  Receipt,
  CreditCard,
  Wallet,
  TrendingUp,
  BarChart3,
  PieChart,
  CalendarDays,
  Landmark,
  Flame,
  CalendarCheck,
  Inbox,
  Settings as SettingsIcon,
} from "lucide-react";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";

type Dest = { name: string; href: string; icon: typeof Receipt; keywords?: string };

const PRIMARY: Dest[] = [
  { name: "Dashboard", href: "/home", icon: LayoutDashboard, keywords: "home command center" },
  { name: "Overview / Reports", href: "/reports", icon: BarChart3, keywords: "reports analytics" },
  { name: "Chase", href: "/transactions", icon: Receipt, keywords: "bank checking transactions" },
  { name: "Amex", href: "/amex", icon: CreditCard, keywords: "american express card kill stack" },
  { name: "Allowance", href: "/allowances", icon: Wallet, keywords: "weekly spending" },
  { name: "Forecast", href: "/forecast", icon: TrendingUp, keywords: "cash runway plan" },
];
const MORE: Dest[] = [
  { name: "Budget", href: "/budget", icon: PieChart },
  { name: "Bills", href: "/bills", icon: CalendarDays, keywords: "income recurring" },
  { name: "Debts", href: "/debts", icon: Landmark, keywords: "apr balance" },
  { name: "Avalanche", href: "/avalanche", icon: Flame, keywords: "payoff plan" },
  { name: "Debrief", href: "/debrief", icon: CalendarCheck, keywords: "weekly review" },
  { name: "Review", href: "/review", icon: Inbox, keywords: "inbox match" },
  { name: "Settings", href: "/settings", icon: SettingsIcon, keywords: "preferences coach" },
];

/**
 * Global ⌘K / Ctrl-K quick-nav palette (KFI / BH Studio command-center
 * staple). Pure navigation over the existing routes — no data or logic.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [, setLocation] = useLocation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = (href: string) => {
    setOpen(false);
    setLocation(href);
  };

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Jump to… (try 'amex', 'forecast', 'avalanche')" />
      <CommandList>
        <CommandEmpty>Nothing here. Try another word.</CommandEmpty>
        <CommandGroup heading="Command">
          {PRIMARY.map((d) => (
            <CommandItem
              key={d.href}
              value={`${d.name} ${d.keywords ?? ""}`}
              onSelect={() => go(d.href)}
            >
              <d.icon className="mr-2 h-4 w-4 text-muted-foreground" />
              {d.name}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="More">
          {MORE.map((d) => (
            <CommandItem
              key={d.href}
              value={`${d.name} ${d.keywords ?? ""}`}
              onSelect={() => go(d.href)}
            >
              <d.icon className="mr-2 h-4 w-4 text-muted-foreground" />
              {d.name}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
