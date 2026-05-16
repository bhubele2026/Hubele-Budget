import React from "react";
import {
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  ArrowRight,
  Wallet,
  Inbox,
  LineChart,
  Landmark,
  Settings,
  LayoutDashboard,
} from "lucide-react";

export function GraphiteVault() {
  return (
    <div className="min-h-screen w-full bg-[#1a1814] text-[#f0eee9] font-sans selection:bg-[#b87333]/30">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;600&family=IBM+Plex+Mono:wght@400;500&family=Inter:wght@400;500;600&display=swap');
        .font-serif { font-family: 'Cormorant Garamond', serif; }
        .font-mono { font-family: 'IBM Plex Mono', monospace; }
        .font-sans { font-family: 'Inter', sans-serif; }
      `}</style>

      <div className="mx-auto max-w-[1280px] flex min-h-screen">
        {/* Sidebar */}
        <aside className="w-[240px] flex-shrink-0 border-r border-[#2a2721] flex flex-col justify-between py-8 px-4 bg-[#1a1814]">
          <div>
            <div className="px-4 mb-12">
              <h1 className="font-serif text-3xl font-semibold tracking-wide text-[#f0eee9]">
                H<span className="text-[#b87333]">2</span>
              </h1>
              <p className="text-[10px] uppercase tracking-widest text-[#8a857a] mt-1">Family Budget</p>
            </div>

            <nav className="space-y-1">
              {[
                { name: "Dashboard", icon: LayoutDashboard, active: true },
                { name: "Inbox", icon: Inbox },
                { name: "Forecast", icon: LineChart },
                { name: "Debts", icon: TrendingDown },
                { name: "Accounts", icon: Landmark },
                { name: "Settings", icon: Settings },
              ].map((item) => (
                <a
                  key={item.name}
                  href="#"
                  className={`flex items-center gap-3 px-4 py-2.5 text-sm transition-colors relative ${
                    item.active ? "text-[#f0eee9]" : "text-[#8a857a] hover:text-[#f0eee9]"
                  }`}
                >
                  {item.active && (
                    <div className="absolute left-0 top-0 bottom-0 w-[2px] bg-[#b87333]" />
                  )}
                  <item.icon className="w-4 h-4" />
                  <span>{item.name}</span>
                </a>
              ))}
            </nav>
          </div>

          <div className="px-4 flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-[#232017] border border-[#2a2721] flex items-center justify-center font-serif text-sm">
              H
            </div>
            <div>
              <div className="text-sm">Harrington</div>
              <div className="text-xs text-[#8a857a]">Household</div>
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 px-10 py-8 bg-[#1a1814] h-screen overflow-y-auto">
          {/* Header */}
          <header className="flex items-center justify-between mb-10">
            <div className="flex items-center gap-4">
              <button className="p-1 hover:text-[#b87333] transition-colors text-[#8a857a]">
                <ChevronLeft className="w-5 h-5" />
              </button>
              <h2 className="font-serif text-3xl font-semibold">May 2026</h2>
              <button className="p-1 hover:text-[#b87333] transition-colors text-[#8a857a]">
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>
            <div className="text-sm text-[#8a857a] border border-[#2a2721] px-4 py-1.5 rounded-full">
              Status: <span className="text-[#3b8769]">Healthy</span>
            </div>
          </header>

          <div className="grid grid-cols-12 gap-6">
            {/* Top Row */}
            {/* Kill Order */}
            <div className="col-span-8 bg-[#232017] border border-[#b87333]/30 p-6 rounded-sm flex flex-col justify-between">
              <div className="flex items-start justify-between mb-6">
                <div>
                  <h3 className="text-xs uppercase tracking-widest text-[#b87333] mb-1">Action Required</h3>
                  <div className="font-serif text-2xl">Kill Order Inbox</div>
                </div>
                <div className="flex items-center gap-2 bg-[#2a2321] text-[#d66b5c] px-3 py-1 rounded border border-[#d66b5c]/20">
                  <AlertTriangle className="w-4 h-4" />
                  <span className="text-sm font-medium">83 waiting in Review</span>
                </div>
              </div>

              <div className="space-y-3 mb-6">
                {[
                  { date: "May 12", merchant: "Amazon Web Services", amount: "$45.00" },
                  { date: "May 11", merchant: "Target", amount: "$112.40" },
                  { date: "May 10", merchant: "Chevron Station", amount: "$58.20" },
                ].map((t, i) => (
                  <div key={i} className="flex items-center justify-between text-sm py-2 border-b border-[#2a2721] last:border-0">
                    <div className="flex gap-4 text-[#8a857a]">
                      <span className="w-12">{t.date}</span>
                      <span className="text-[#f0eee9]">{t.merchant}</span>
                    </div>
                    <span className="font-mono text-[#8a857a]">{t.amount}</span>
                  </div>
                ))}
              </div>

              <button className="w-full flex items-center justify-center gap-2 border border-[#b87333] text-[#b87333] py-2.5 rounded-sm hover:bg-[#b87333]/10 transition-colors text-sm uppercase tracking-wide">
                Open Inbox <ArrowRight className="w-4 h-4" />
              </button>
            </div>

            {/* Bank Snapshot */}
            <div className="col-span-4 bg-[#232017] border border-[#2a2721] p-6 rounded-sm">
              <div className="flex items-center justify-between mb-6">
                <h3 className="font-serif text-xl">Balances</h3>
                <button className="text-[#8a857a] hover:text-[#f0eee9] transition-colors" title="Sync accounts">
                  <RefreshCw className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-5 mb-6">
                {[
                  { name: "Chase Checking", amount: "$4,217.83", type: "positive" },
                  { name: "Amex •••1009", amount: "$-2,184.55", type: "negative" },
                  { name: "Capital One Savings", amount: "$12,400.00", type: "positive" },
                ].map((a, i) => (
                  <div key={i} className="flex flex-col gap-1">
                    <span className="text-xs text-[#8a857a] uppercase tracking-wider">{a.name}</span>
                    <span className={`font-mono text-lg ${a.type === "positive" ? "text-[#3b8769]" : "text-[#c25c5c]"}`}>
                      {a.amount}
                    </span>
                  </div>
                ))}
              </div>

              <div className="text-[10px] text-[#8a857a] uppercase tracking-widest text-center mt-auto border-t border-[#2a2721] pt-4">
                Last synced 6m ago
              </div>
            </div>

            {/* Metrics Row */}
            <div className="col-span-12 grid grid-cols-4 gap-6">
              {[
                { label: "Month spend", value: "$3,847", sub: "May 2026" },
                { label: "Avg week", value: "$912", sub: "Last 4 weeks" },
                { label: "Net cashflow", value: "+$1,204", sub: "Income - Spend", positive: true },
                { label: "Days till payday", value: "9", sub: "May 21" },
              ].map((m, i) => (
                <div key={i} className="bg-[#232017] border border-[#2a2721] p-5 rounded-sm">
                  <div className="text-[10px] uppercase tracking-widest text-[#8a857a] mb-2">{m.label}</div>
                  <div className={`font-serif text-3xl mb-1 ${m.positive ? 'text-[#3b8769]' : 'text-[#f0eee9]'}`}>{m.value}</div>
                  <div className="text-[10px] text-[#5c5952] uppercase tracking-widest">{m.sub}</div>
                </div>
              ))}
            </div>

            {/* Cash Signal / Weekly */}
            <div className="col-span-6 bg-[#232017] border border-[#2a2721] p-6 rounded-sm">
              <div className="flex items-center justify-between mb-8">
                <div>
                  <h3 className="font-serif text-xl">Weekly Allowance</h3>
                  <div className="text-xs text-[#8a857a] mt-1">Wk of May 11</div>
                </div>
                <div className="font-mono text-xl text-[#f0eee9]">$464 <span className="text-sm text-[#8a857a]">/ $600</span></div>
              </div>

              <div className="space-y-6">
                {[
                  { name: "Groceries", spent: 312, total: 400 },
                  { name: "Gas", spent: 58, total: 120 },
                  { name: "Eating Out", spent: 94, total: 80, over: true },
                ].map((b, i) => (
                  <div key={i}>
                    <div className="flex justify-between text-sm mb-2">
                      <span>{b.name}</span>
                      <span className="font-mono text-[#8a857a]">
                        <span className={b.over ? "text-[#c25c5c]" : "text-[#f0eee9]"}>${b.spent}</span> / ${b.total}
                      </span>
                    </div>
                    <div className="h-1 bg-[#1a1814] rounded-full overflow-hidden">
                      <div 
                        className={`h-full ${b.over ? 'bg-[#c25c5c]' : 'bg-[#b87333]'}`} 
                        style={{ width: `${Math.min(100, (b.spent / b.total) * 100)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Avalanche / Debt */}
            <div className="col-span-6 bg-[#232017] border border-[#2a2721] p-6 rounded-sm">
              <div className="flex items-center justify-between mb-6">
                <h3 className="font-serif text-xl">Debt Avalanche</h3>
                <div className="text-xs border border-[#2a2721] px-2 py-1 rounded text-[#8a857a] uppercase tracking-widest">
                  Active
                </div>
              </div>

              <div className="space-y-5 mb-6">
                {[
                  { name: "Amex", amount: "$2,184.55", apr: "22.99%", progress: 15 },
                  { name: "Capital One Auto", amount: "$8,420.00", apr: "7.4%", progress: 45 },
                  { name: "Student Loan", amount: "$14,300.00", apr: "5.1%", progress: 12 },
                ].map((d, i) => (
                  <div key={i}>
                    <div className="flex justify-between items-baseline mb-2">
                      <div className="flex items-baseline gap-2">
                        <span className="text-sm">{d.name}</span>
                        <span className="text-[10px] text-[#c25c5c] px-1.5 py-0.5 bg-[#2a1c1c] rounded">{d.apr} APR</span>
                      </div>
                      <span className="font-mono text-[#8a857a] text-sm">{d.amount}</span>
                    </div>
                    <div className="h-0.5 bg-[#1a1814] w-full">
                      <div className="h-full bg-[#5c5952]" style={{ width: `${d.progress}%` }} />
                    </div>
                  </div>
                ))}
              </div>

              <div className="text-xs text-[#8a857a] flex items-center gap-2 border-t border-[#2a2721] pt-4">
                <span className="w-2 h-2 rounded-full bg-[#b87333] animate-pulse" />
                Targeting <strong>Amex</strong> for next snowball.
              </div>
            </div>

            {/* Forecast Strip */}
            <div className="col-span-12 bg-[#232017] border border-[#2a2721] p-6 rounded-sm flex items-center justify-between">
              <div>
                <div className="text-xs uppercase tracking-widest text-[#8a857a] mb-1">30-Day Forecast</div>
                <div className="flex items-baseline gap-3">
                  <span className="font-serif text-3xl">$5,102.00</span>
                  <span className="font-mono text-sm text-[#3b8769] flex items-center"><TrendingUp className="w-3 h-3 mr-1"/> +$884.17</span>
                </div>
              </div>
              
              <div className="flex-1 px-12 relative h-12 flex items-center">
                {/* Mock Sparkline */}
                <svg className="w-full h-full preserve-aspect-ratio-none" viewBox="0 0 400 40">
                  <path d="M0 30 Q 50 10, 100 25 T 200 15 T 300 20 T 400 5" fill="none" stroke="#b87333" strokeWidth="2" strokeLinecap="round" />
                  <path d="M0 30 Q 50 10, 100 25 T 200 15 T 300 20 T 400 5 L 400 40 L 0 40 Z" fill="url(#grad)" opacity="0.2" />
                  <defs>
                    <linearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#b87333" />
                      <stop offset="100%" stopColor="#b87333" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                </svg>
              </div>

              <div className="text-right">
                <div className="text-xs text-[#8a857a] uppercase tracking-widest mb-1">End of Month</div>
                <div className="font-mono text-[#f0eee9]">$4,850.00</div>
              </div>
            </div>

            {/* Transactions Table */}
            <div className="col-span-12 bg-[#232017] border border-[#2a2721] rounded-sm overflow-hidden">
              <div className="p-6 border-b border-[#2a2721] flex items-center justify-between">
                <h3 className="font-serif text-xl">Recent Transactions</h3>
                <button className="text-xs uppercase tracking-widest text-[#b87333] hover:underline">View All</button>
              </div>
              
              <div className="divide-y divide-[#2a2721]">
                {[
                  { date: "May 13", merchant: "Trader Joe's", cat: "Groceries", amount: "$-145.32", source: "amex" },
                  { date: "May 13", merchant: "Payroll Deposit", cat: "Income", amount: "$3,400.00", source: "chase" },
                  { date: "May 12", merchant: "Netflix", cat: "Subscriptions", amount: "$-15.49", source: "amex" },
                  { date: "May 11", merchant: "Shell Station", cat: "Gas", amount: "$-48.50", source: "chase" },
                  { date: "May 10", merchant: "PG&E", cat: "Utilities", amount: "$-182.00", source: "manual" },
                  { date: "May 09", merchant: "Whole Foods", cat: "Groceries", amount: "$-89.15", source: "amex" },
                  { date: "May 08", merchant: "Mortgage", cat: "Housing", amount: "$-2,450.00", source: "chase" },
                  { date: "May 08", merchant: "Spotify", cat: "Subscriptions", amount: "$-10.99", source: "amex" },
                ].map((t, i) => (
                  <div key={i} className="flex items-center p-4 hover:bg-[#1a1814] transition-colors group">
                    <div className="w-20 text-xs text-[#8a857a]">{t.date}</div>
                    <div className="flex-1 flex items-center gap-4">
                      <span className="text-sm font-medium">{t.merchant}</span>
                      <span className="text-[10px] bg-[#3d2952] text-[#c4b5fd] px-2 py-0.5 rounded-sm uppercase tracking-widest">
                        {t.cat}
                      </span>
                    </div>
                    <div className="flex items-center justify-end gap-6 w-64">
                      <span className="text-[9px] uppercase tracking-widest border border-[#2a2721] text-[#8a857a] px-1.5 py-0.5 rounded-sm">
                        {t.source}
                      </span>
                      <span className={`font-mono text-sm w-24 text-right ${t.amount.startsWith("$-") ? "text-[#c25c5c]" : "text-[#3b8769]"}`}>
                        {t.amount.replace("$-", "-$")}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

          </div>
          
          <div className="h-12" /> {/* Bottom padding */}
        </main>
      </div>
    </div>
  );
}
