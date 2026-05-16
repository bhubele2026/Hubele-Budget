import React from "react";
import {
  ChevronLeft,
  ChevronRight,
  Inbox,
  Activity,
  CreditCard,
  Building,
  AlertCircle,
  RefreshCw,
  Wallet,
  TrendingUp,
  Settings,
  LayoutDashboard,
  Target,
  User,
  ArrowUpRight,
  ArrowDownRight
} from "lucide-react";

export function ObsidianGlass() {
  return (
    <div className="min-h-screen w-full bg-[#07080b] text-[#8e95a3] font-sans antialiased selection:bg-[#7c3aed]/30 selection:text-[#f3f4f6] flex justify-center">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
        
        .font-geist { font-family: 'Geist', sans-serif; }
        .font-mono { font-family: 'JetBrains Mono', monospace; }
        
        .glass-card {
          background: linear-gradient(180deg, #13161c 0%, #0e1116 100%);
          border: 1px solid #1e2230;
          box-shadow: 0 4px 24px -1px rgba(0,0,0,0.5);
        }
        
        .focus-glow {
          box-shadow: 0 0 0 1px rgba(124, 58, 237, 0.3), 0 0 20px rgba(124, 58, 237, 0.1);
          border-color: rgba(124, 58, 237, 0.4);
        }
        
        /* Custom scrollbar for dark mode */
        ::-webkit-scrollbar {
          width: 6px;
          height: 6px;
        }
        ::-webkit-scrollbar-track {
          background: transparent;
        }
        ::-webkit-scrollbar-thumb {
          background: #1e2230;
          border-radius: 3px;
        }
        ::-webkit-scrollbar-thumb:hover {
          background: #2d3345;
        }
      `}</style>

      <div className="w-full max-w-[1280px] flex h-full min-h-[1600px] relative font-geist">
        
        {/* Sidebar */}
        <aside className="w-[240px] shrink-0 border-r border-[#1e2230] p-6 flex flex-col sticky top-0 h-screen overflow-y-auto">
          <div className="mb-10 flex items-center gap-3">
            <div className="w-8 h-8 rounded bg-gradient-to-br from-[#1e2230] to-[#0e1116] border border-[#2d3345] flex items-center justify-center font-bold text-[#f3f4f6]">
              H2
            </div>
            <span className="font-semibold tracking-tight text-[#f3f4f6] text-lg">Family Budget</span>
          </div>

          <nav className="space-y-1 flex-1">
            <NavItem icon={<LayoutDashboard size={18} />} label="Dashboard" active />
            <NavItem icon={<Inbox size={18} />} label="Inbox" badge="83" />
            <NavItem icon={<TrendingUp size={18} />} label="Forecast" />
            <NavItem icon={<Target size={18} />} label="Debts" />
            <NavItem icon={<Building size={18} />} label="Accounts" />
            <NavItem icon={<Settings size={18} />} label="Settings" />
          </nav>

          <div className="mt-auto pt-6 border-t border-[#1e2230] flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-[#1e2230] flex items-center justify-center text-[#f3f4f6]">
              <User size={18} />
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-medium text-[#f3f4f6]">Harrington</span>
              <span className="text-xs text-[#5e6575]">h2@example.com</span>
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 p-8 lg:p-10 pl-12 flex flex-col gap-8 min-w-0">
          
          {/* Header */}
          <header className="flex items-center justify-between pb-4 border-b border-[#1e2230]/50">
            <div className="flex items-center gap-4">
              <h1 className="text-2xl font-medium text-[#f3f4f6] tracking-tight">May 2026</h1>
              <div className="flex items-center gap-1">
                <button className="p-1 hover:bg-[#1e2230] rounded text-[#5e6575] hover:text-[#f3f4f6] transition-colors">
                  <ChevronLeft size={20} />
                </button>
                <button className="p-1 hover:bg-[#1e2230] rounded text-[#5e6575] hover:text-[#f3f4f6] transition-colors">
                  <ChevronRight size={20} />
                </button>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="text-sm border border-[#1e2230] bg-[#0e1116] px-3 py-1.5 rounded text-[#8e95a3]">
                Net Cashflow <span className="text-[#059669] font-mono ml-2">+$1,204.00</span>
              </div>
            </div>
          </header>

          {/* Secondary Metrics Row */}
          <div className="grid grid-cols-4 gap-4">
            <StatCard label="Month spend" value="$3,847.00" trend="up" />
            <StatCard label="Avg week" value="$912.00" trend="down" />
            <StatCard label="Net cashflow" value="+$1,204.00" valueColor="text-[#059669]" />
            <StatCard label="Days till payday" value="9" isNumber />
          </div>

          <div className="grid grid-cols-12 gap-6 items-start">
            
            {/* Left Column (8 cols) */}
            <div className="col-span-12 xl:col-span-8 flex flex-col gap-6">
              
              {/* Forecast Strip */}
              <div className="glass-card rounded-xl p-6 flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Activity size={18} className="text-[#5e6575]" />
                    <h3 className="text-sm font-medium text-[#f3f4f6]">30-Day Forecast</h3>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-[#5e6575] uppercase tracking-wider mb-1">EOM Balance</div>
                    <div className="font-mono text-lg text-[#f3f4f6]">$8,402.50</div>
                  </div>
                </div>
                
                {/* Fake Sparkline */}
                <div className="h-24 w-full relative mt-2 rounded overflow-hidden">
                  {/* Grid lines */}
                  <div className="absolute inset-0 flex flex-col justify-between opacity-10">
                    <div className="border-t border-[#8e95a3] w-full"></div>
                    <div className="border-t border-[#8e95a3] w-full"></div>
                    <div className="border-t border-[#8e95a3] w-full"></div>
                  </div>
                  {/* Line */}
                  <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="w-full h-full overflow-visible">
                    <defs>
                      <linearGradient id="sparkGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                        <stop offset="0%" stopColor="rgba(124, 58, 237, 1)" />
                        <stop offset="100%" stopColor="rgba(249, 115, 22, 1)" />
                      </linearGradient>
                      <linearGradient id="sparkFill" x1="0%" y1="0%" x2="0%" y2="100%">
                        <stop offset="0%" stopColor="rgba(124, 58, 237, 0.1)" />
                        <stop offset="100%" stopColor="rgba(124, 58, 237, 0)" />
                      </linearGradient>
                    </defs>
                    <path d="M0,80 L10,75 L20,85 L30,60 L40,65 L50,40 L60,45 L70,30 L80,50 L90,20 L100,25 L100,100 L0,100 Z" fill="url(#sparkFill)" />
                    <path d="M0,80 L10,75 L20,85 L30,60 L40,65 L50,40 L60,45 L70,30 L80,50 L90,20 L100,25" fill="none" stroke="url(#sparkGradient)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    
                    {/* Data points */}
                    <circle cx="90" cy="20" r="3" fill="#f97316" className="animate-pulse" />
                    <circle cx="100" cy="25" r="3" fill="#f97316" />
                  </svg>
                </div>
              </div>

              {/* Weekly Bucket Card */}
              <div className="glass-card rounded-xl p-6">
                <div className="flex items-center justify-between mb-8">
                  <div>
                    <h3 className="text-lg font-medium text-[#f3f4f6]">Wk of May 11</h3>
                    <p className="text-xs text-[#5e6575] mt-1">Weekly Cashflow Settlement</p>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-xl text-[#f3f4f6]">$464 <span className="text-[#5e6575]">/ $600</span></div>
                    <div className="text-xs text-[#059669] mt-1">$136 remaining</div>
                  </div>
                </div>

                <div className="space-y-6">
                  <BucketRow label="Groceries" spent={312} budget={400} />
                  <BucketRow label="Gas" spent={58} budget={120} />
                  <BucketRow label="Eating Out" spent={94} budget={80} over />
                </div>
              </div>

              {/* Recent Transactions */}
              <div className="glass-card rounded-xl overflow-hidden">
                <div className="p-6 border-b border-[#1e2230] flex items-center justify-between bg-[#13161c]">
                  <h3 className="text-sm font-medium text-[#f3f4f6]">Recent Transactions</h3>
                  <button className="text-xs text-[#8e95a3] hover:text-[#f3f4f6] transition-colors">View All</button>
                </div>
                <div className="p-0">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[#1e2230] text-left text-xs uppercase tracking-wider text-[#5e6575] bg-[#0e1116]">
                        <th className="font-medium py-3 px-6 w-24">Date</th>
                        <th className="font-medium py-3 px-6">Merchant</th>
                        <th className="font-medium py-3 px-6">Category</th>
                        <th className="font-medium py-3 px-6 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1e2230]">
                      <TxnRow date="May 14" merchant="Trader Joe's" category="Groceries" amount="-142.80" source="chase" />
                      <TxnRow date="May 13" merchant="Shell" category="Gas" amount="-58.00" source="amex" />
                      <TxnRow date="May 12" merchant="Netflix" category="Subscriptions" amount="-15.49" source="amex" />
                      <TxnRow date="May 11" merchant="Costco" category="Groceries" amount="-169.20" source="chase" />
                      <TxnRow date="May 10" merchant="Payroll Deposit" category="Income" amount="3800.00" source="chase" isPositive />
                      <TxnRow date="May 09" merchant="Whole Foods" category="Eating Out" amount="-94.00" source="amex" />
                      <TxnRow date="May 08" merchant="PG&E" category="Utilities" amount="-184.30" source="chase" />
                      <TxnRow date="May 08" merchant="Verizon" category="Mobile" amount="-110.00" source="amex" />
                    </tbody>
                  </table>
                </div>
              </div>

            </div>

            {/* Right Column (4 cols) */}
            <div className="col-span-12 xl:col-span-4 flex flex-col gap-6">
              
              {/* Kill Order Inbox - FOCUS CARD */}
              <div className="glass-card rounded-xl p-6 focus-glow relative overflow-hidden">
                <div className="absolute inset-0 rounded-xl border border-[#7c3aed]/30 pointer-events-none"></div>
                
                <div className="flex items-start justify-between mb-6 relative z-10">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded bg-[#1e2230] border border-[#2d3345] flex items-center justify-center text-[#f3f4f6]">
                      <Inbox size={20} />
                    </div>
                    <div>
                      <h3 className="text-sm font-medium text-[#f3f4f6]">Review Inbox</h3>
                      <div className="text-xs text-[#a78bfa] mt-1 flex items-center gap-1">
                        <AlertCircle size={12} />
                        83 waiting
                      </div>
                    </div>
                  </div>
                </div>

                <div className="space-y-3 mb-6 relative z-10">
                  <InboxItem date="May 14" merchant="Amazon.com" amount="$42.10" />
                  <InboxItem date="May 12" merchant="Uber Trip" amount="$18.90" />
                  <InboxItem date="May 11" merchant="Starbucks" amount="$4.50" />
                </div>

                <button className="w-full py-2.5 bg-[#1e2230] hover:bg-[#2d3345] text-[#f3f4f6] text-sm rounded border border-[#2d3345] transition-colors relative z-10">
                  Open Inbox
                </button>
              </div>

              {/* Bank Snapshot */}
              <div className="glass-card rounded-xl p-6">
                <div className="flex items-center justify-between mb-6">
                  <h3 className="text-sm font-medium text-[#f3f4f6]">Bank Snapshot</h3>
                  <div className="flex items-center gap-2 text-xs text-[#5e6575]">
                    6m ago
                    <button className="p-1 hover:text-[#f3f4f6] transition-colors rounded">
                      <RefreshCw size={12} />
                    </button>
                  </div>
                </div>

                <div className="space-y-4">
                  <AccountRow name="Chase Checking" amount="$4,217.83" icon={<Building size={14} />} />
                  <AccountRow name="Amex •••1009" amount="-$2,184.55" icon={<CreditCard size={14} />} isNegative />
                  <AccountRow name="CapOne Savings" amount="$12,400.00" icon={<Wallet size={14} />} />
                </div>
              </div>

              {/* Avalanche Debt */}
              <div className="glass-card rounded-xl p-6">
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <h3 className="text-sm font-medium text-[#f3f4f6]">Debt Avalanche</h3>
                    <p className="text-xs text-[#5e6575] mt-1">Next target: Amex</p>
                  </div>
                </div>

                <div className="space-y-5">
                  <DebtRow name="Amex" amount="$2,184.55" apr="22.99%" progress={35} isTarget />
                  <DebtRow name="CapOne Auto" amount="$8,420.00" apr="7.4%" progress={12} />
                  <DebtRow name="Student Loan" amount="$14,300.00" apr="5.1%" progress={4} />
                </div>
              </div>

            </div>
          </div>
          
        </main>
      </div>
    </div>
  );
}

function NavItem({ icon, label, active = false, badge }: { icon: React.ReactNode, label: string, active?: boolean, badge?: string }) {
  return (
    <a href="#" className={`flex items-center justify-between px-3 py-2 rounded-md transition-colors relative ${active ? 'text-[#f3f4f6] bg-[#13161c]' : 'text-[#8e95a3] hover:text-[#f3f4f6] hover:bg-[#13161c]'}`}>
      <div className="flex items-center gap-3">
        {active && (
          <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 bg-[#7c3aed] rounded-r box-shadow-[0_0_8px_rgba(124,58,237,0.5)]"></div>
        )}
        <span className={`${active ? 'text-[#a78bfa]' : ''}`}>{icon}</span>
        <span className="text-sm font-medium">{label}</span>
      </div>
      {badge && (
        <span className="text-[10px] font-mono bg-[#1e2230] text-[#f3f4f6] px-1.5 py-0.5 rounded border border-[#2d3345]">
          {badge}
        </span>
      )}
    </a>
  );
}

function StatCard({ label, value, trend, valueColor = "text-[#f3f4f6]", isNumber = false }: { label: string, value: string, trend?: 'up'|'down', valueColor?: string, isNumber?: boolean }) {
  return (
    <div className="glass-card rounded-xl p-5 border-b-2 border-transparent hover:border-[#f97316]/30 transition-colors">
      <div className="text-xs text-[#5e6575] uppercase tracking-wider mb-2">{label}</div>
      <div className="flex items-end justify-between">
        <div className={`text-2xl ${isNumber ? 'font-sans' : 'font-mono'} ${valueColor}`}>{value}</div>
        {trend && (
          <div className={`flex items-center ${trend === 'up' ? 'text-[#b91c1c]' : 'text-[#059669]'}`}>
            {trend === 'up' ? <ArrowUpRight size={16} /> : <ArrowDownRight size={16} />}
          </div>
        )}
      </div>
    </div>
  );
}

function BucketRow({ label, spent, budget, over = false }: { label: string, spent: number, budget: number, over?: boolean }) {
  const pct = Math.min(100, (spent / budget) * 100);
  return (
    <div>
      <div className="flex justify-between items-end mb-2 text-sm">
        <span className="text-[#8e95a3]">{label}</span>
        <div className="font-mono text-xs">
          <span className={over ? 'text-[#b91c1c]' : 'text-[#f3f4f6]'}>${spent}</span>
          <span className="text-[#5e6575]"> / ${budget}</span>
        </div>
      </div>
      <div className="h-1.5 w-full bg-[#1e2230] rounded-full overflow-hidden">
        <div 
          className={`h-full rounded-full ${over ? 'bg-[#b91c1c]' : 'bg-[#5e6575]'}`} 
          style={{ width: `${pct}%` }}
        ></div>
      </div>
    </div>
  );
}

function TxnRow({ date, merchant, category, amount, source, isPositive = false }: { date: string, merchant: string, category: string, amount: string, source: string, isPositive?: boolean }) {
  return (
    <tr className="hover:bg-[#13161c] transition-colors group">
      <td className="py-3 px-6 text-[#5e6575] font-mono text-xs">{date}</td>
      <td className="py-3 px-6 font-medium text-[#f3f4f6]">{merchant}</td>
      <td className="py-3 px-6">
        <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] uppercase tracking-wider bg-[#1e2230] text-[#8e95a3] border border-[#2d3345]">
          {category}
        </span>
      </td>
      <td className={`py-3 px-6 text-right font-mono flex items-center justify-end gap-3`}>
        <span className="text-[9px] uppercase tracking-wider text-[#5e6575] bg-[#07080b] px-1 rounded border border-[#1e2230] opacity-0 group-hover:opacity-100 transition-opacity">{source}</span>
        <span className={isPositive ? "text-[#059669]" : "text-[#f3f4f6]"}>
          {isPositive ? "+" : ""}{amount}
        </span>
      </td>
    </tr>
  );
}

function InboxItem({ date, merchant, amount }: { date: string, merchant: string, amount: string }) {
  return (
    <div className="flex items-center justify-between p-3 rounded bg-[#07080b] border border-[#1e2230] hover:border-[#2d3345] transition-colors cursor-pointer">
      <div>
        <div className="font-medium text-[#f3f4f6] text-sm">{merchant}</div>
        <div className="text-xs text-[#5e6575] font-mono mt-0.5">{date}</div>
      </div>
      <div className="font-mono text-sm text-[#f3f4f6]">{amount}</div>
    </div>
  );
}

function AccountRow({ name, amount, icon, isNegative = false }: { name: string, amount: string, icon: React.ReactNode, isNegative?: boolean }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <div className="flex items-center gap-3">
        <div className="text-[#5e6575]">{icon}</div>
        <span className="text-[#8e95a3]">{name}</span>
      </div>
      <div className={`font-mono ${isNegative ? 'text-[#b91c1c]' : 'text-[#f3f4f6]'}`}>
        {amount}
      </div>
    </div>
  );
}

function DebtRow({ name, amount, apr, progress, isTarget = false }: { name: string, amount: string, apr: string, progress: number, isTarget?: boolean }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-sm text-[#f3f4f6]">{name}</span>
          {isTarget && (
            <span className="w-1.5 h-1.5 rounded-full bg-[#f97316] animate-pulse" title="Target"></span>
          )}
        </div>
        <div className="text-right">
          <div className="font-mono text-sm text-[#f3f4f6]">{amount}</div>
          <div className="text-xs text-[#5e6575]">{apr}</div>
        </div>
      </div>
      <div className="h-1 w-full bg-[#1e2230] rounded-full overflow-hidden">
        <div 
          className={`h-full rounded-full ${isTarget ? 'bg-[#3a3a3a] border border-[#f97316]/60' : 'bg-[#5e6575]'}`} 
          style={{ width: `${progress}%` }}
        ></div>
      </div>
    </div>
  );
}
