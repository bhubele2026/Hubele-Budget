import React from 'react';
import { ChevronLeft, ChevronRight, Inbox, TrendingUp, Wallet, ShieldAlert, CreditCard, Landmark, LineChart, Settings, Home, AlertCircle, ArrowRight, Activity, ArrowUpRight } from 'lucide-react';

export function SteelAtelier() {
  return (
    <div className="min-h-screen w-full flex font-sans text-[#1f2937] bg-[#f4f5f7]">
      <style dangerouslySetInnerHTML={{__html: `
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Inter+Tight:wght@500;600;700&family=Inter:wght@400;500;600&display=swap');
        
        .font-sans { font-family: 'Inter', sans-serif; }
        .font-heading { font-family: 'Inter Tight', sans-serif; }
        .font-mono { font-family: 'IBM Plex Mono', monospace; font-variant-numeric: tabular-nums; }
        
        .brushed-metal {
          background: linear-gradient(180deg, #ffffff 0%, #f9fafb 100%);
        }
      `}} />

      {/* Sidebar */}
      <aside className="w-[240px] bg-[#1f2937] text-white flex flex-col shrink-0 min-h-screen fixed left-0 top-0 bottom-0 overflow-y-auto border-r border-[#1f2937]">
        <div className="p-6">
          <div className="text-xl font-heading font-bold tracking-tight text-white mb-10 flex items-center gap-2">
            <div className="w-6 h-6 rounded-sm border border-white/20 flex items-center justify-center bg-white/5">
              <span className="text-xs font-mono font-bold">H2</span>
            </div>
            Atelier
          </div>
          
          <nav className="space-y-1">
            <NavItem icon={<Home size={18} />} label="Dashboard" active />
            <NavItem icon={<Inbox size={18} />} label="Inbox" badge="83" />
            <NavItem icon={<LineChart size={18} />} label="Forecast" />
            <NavItem icon={<TrendingUp size={18} />} label="Debts" />
            <NavItem icon={<Landmark size={18} />} label="Accounts" />
            <NavItem icon={<Settings size={18} />} label="Settings" />
          </nav>
        </div>
        
        <div className="mt-auto p-6">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-[#374151] flex items-center justify-center border border-[#4b5563]">
              <span className="text-xs font-heading font-medium text-[#d1d5db]">BH</span>
            </div>
            <div className="flex flex-col">
              <span className="text-sm font-medium text-white">Brad Harrington</span>
              <span className="text-xs text-[#9ca3af]">Family Budget</span>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 ml-[240px] max-w-[1040px] mx-auto p-8 lg:p-12">
        {/* Top Header Strip */}
        <header className="flex items-center justify-between pb-8 mb-8 border-b border-[#d8dce4]">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1">
              <button className="w-8 h-8 flex items-center justify-center rounded border border-[#d8dce4] bg-white text-[#6b7280] hover:text-[#1f2937] hover:border-[#9ca3af] transition-colors">
                <ChevronLeft size={16} strokeWidth={1.5} />
              </button>
              <h1 className="text-3xl font-heading font-semibold tracking-tight px-3">May 2026</h1>
              <button className="w-8 h-8 flex items-center justify-center rounded border border-[#d8dce4] bg-white text-[#6b7280] hover:text-[#1f2937] hover:border-[#9ca3af] transition-colors">
                <ChevronRight size={16} strokeWidth={1.5} />
              </button>
            </div>
          </div>
          <div className="flex items-center gap-3">
             <div className="text-xs font-heading font-semibold uppercase tracking-widest text-[#6b7280]">
               Harrington Household
             </div>
          </div>
        </header>

        {/* Secondary Metrics Row */}
        <div className="grid grid-cols-4 gap-6 mb-8">
          <StatTile label="Month spend" value="$3,847.00" />
          <StatTile label="Avg week" value="$912.45" />
          <StatTile label="Net cashflow" value="+$1,204.80" positive />
          <StatTile label="Days till payday" value="9" />
        </div>

        {/* Main Grid */}
        <div className="grid grid-cols-12 gap-6">
          
          {/* Left Column (8 cols) */}
          <div className="col-span-8 flex flex-col gap-6">
            
            {/* Forecast Strip */}
            <div className="brushed-metal border border-[#d8dce4] rounded-md p-6 flex flex-col justify-between relative overflow-hidden">
              <div className="flex justify-between items-start mb-6">
                <div>
                  <h2 className="text-[11px] font-heading font-bold uppercase tracking-[0.1em] text-[#6b7280] mb-1">30-Day Forecast</h2>
                  <div className="text-2xl font-mono font-medium tracking-tight">$14,208.55</div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] font-heading font-bold uppercase tracking-[0.1em] text-[#059669] mb-1">EOM Delta</div>
                  <div className="text-sm font-mono text-[#059669] font-medium">+$2,850.00</div>
                </div>
              </div>
              <div className="h-16 flex items-end w-full relative">
                 {/* Mock Sparkline */}
                 <svg className="w-full h-full" preserveAspectRatio="none" viewBox="0 0 100 20">
                   <path d="M0,15 L10,12 L20,14 L30,8 L40,10 L50,5 L60,7 L70,3 L80,5 L90,2 L100,5" 
                         fill="none" stroke="#1f2937" strokeWidth="0.5" vectorEffect="non-scaling-stroke" />
                   <circle cx="100" cy="5" r="1.5" fill="#6b21a8" />
                 </svg>
              </div>
            </div>

            {/* Kill Order Inbox */}
            <div className="bg-white border border-[#d8dce4] rounded-md overflow-hidden">
              <div className="p-5 border-b border-[#d8dce4] flex justify-between items-center bg-[#f9fafb]">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full border border-[#c2410c] flex items-center justify-center bg-[#fff7ed] text-[#c2410c]">
                    <ShieldAlert size={16} strokeWidth={2} />
                  </div>
                  <div>
                    <h2 className="text-xs font-heading font-bold uppercase tracking-[0.1em] text-[#1f2937]">Kill Order Review</h2>
                    <div className="text-sm text-[#4b5563] mt-0.5"><span className="font-mono font-medium text-[#c2410c]">83</span> waiting in Inbox</div>
                  </div>
                </div>
                <button className="text-xs font-heading font-bold uppercase tracking-wider px-4 py-2 rounded border border-[#c2410c] text-[#c2410c] hover:bg-[#fff7ed] transition-colors flex items-center gap-2">
                  Open Inbox <ArrowRight size={14} />
                </button>
              </div>
              <div className="p-0">
                <table className="w-full text-sm">
                  <tbody>
                    <InboxRow date="May 02" merchant="Trader Joe's" amount="-$142.50" />
                    <InboxRow date="May 01" merchant="Shell Gas Station" amount="-$58.20" />
                    <InboxRow date="Apr 30" merchant="Netflix" amount="-$15.49" />
                  </tbody>
                </table>
              </div>
            </div>

            {/* Recent Transactions */}
            <div className="bg-white border border-[#d8dce4] rounded-md">
              <div className="p-5 border-b border-[#d8dce4]">
                <h2 className="text-[11px] font-heading font-bold uppercase tracking-[0.1em] text-[#6b7280]">Recent Transactions</h2>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[#d8dce4] text-xs font-heading text-[#6b7280] uppercase tracking-wider text-left bg-[#f9fafb]">
                    <th className="px-5 py-3 font-medium">Date</th>
                    <th className="px-5 py-3 font-medium">Merchant</th>
                    <th className="px-5 py-3 font-medium">Category</th>
                    <th className="px-5 py-3 font-medium">Source</th>
                    <th className="px-5 py-3 font-medium text-right">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#f3f4f6]">
                  <TxRow date="May 03" merchant="Whole Foods Market" cat="Groceries" src="amex" amount="-$84.12" />
                  <TxRow date="May 03" merchant="Costco Wholesale" cat="Bulk" src="chase" amount="-$312.00" />
                  <TxRow date="May 02" merchant="Payroll Deposit" cat="Income" src="chase" amount="+$4,150.00" pos />
                  <TxRow date="May 02" merchant="PG&E Utility" cat="Utilities" src="chase" amount="-$145.20" />
                  <TxRow date="May 01" merchant="Spotify" cat="Subscriptions" src="amex" amount="-$10.99" />
                  <TxRow date="May 01" merchant="Verizon Wireless" cat="Utilities" src="amex" amount="-$112.50" />
                </tbody>
              </table>
              <div className="p-4 border-t border-[#d8dce4] text-center">
                <button className="text-xs font-medium text-[#6b7280] hover:text-[#1f2937] flex items-center justify-center gap-1 mx-auto">
                  View All Transactions <ArrowRight size={14} />
                </button>
              </div>
            </div>

          </div>

          {/* Right Column (4 cols) */}
          <div className="col-span-4 flex flex-col gap-6">
            
            {/* Cash Signal / Weekly */}
            <div className="bg-white border border-[#d8dce4] rounded-md p-6">
              <div className="flex justify-between items-start mb-6">
                <div>
                  <h2 className="text-[11px] font-heading font-bold uppercase tracking-[0.1em] text-[#6b7280] mb-1">Weekly Cashflow</h2>
                  <div className="text-sm font-medium">Wk of May 11</div>
                </div>
                <div className="w-8 h-8 rounded border border-[#d8dce4] flex items-center justify-center text-[#6b7280]">
                  <Activity size={16} strokeWidth={1.5} />
                </div>
              </div>
              
              <div className="space-y-5">
                <BucketRow label="Groceries" spent={312} budget={400} />
                <BucketRow label="Gas" spent={58} budget={120} />
                <BucketRow label="Eating Out" spent={94} budget={80} over />
              </div>
            </div>

            {/* Avalanche Debt */}
            <div className="bg-white border border-[#d8dce4] rounded-md p-6">
              <div className="flex justify-between items-start mb-6">
                <div>
                  <h2 className="text-[11px] font-heading font-bold uppercase tracking-[0.1em] text-[#6b7280] mb-1">Debt Avalanche</h2>
                  <div className="text-sm font-medium">Payoff Progress</div>
                </div>
                <div className="w-8 h-8 rounded border border-[#d8dce4] flex items-center justify-center text-[#6b7280]">
                  <TrendingUp size={16} strokeWidth={1.5} />
                </div>
              </div>
              
              <div className="space-y-4">
                <DebtRow name="Amex Platinum" balance="-$2,184.55" rate="22.99%" target />
                <DebtRow name="Capital One Auto" balance="-$8,420.00" rate="7.40%" />
                <DebtRow name="Student Loan" balance="-$14,300.00" rate="5.10%" />
              </div>
            </div>

            {/* Bank Snapshot */}
            <div className="bg-white border border-[#d8dce4] rounded-md p-6">
               <div className="flex justify-between items-start mb-6">
                <div>
                  <h2 className="text-[11px] font-heading font-bold uppercase tracking-[0.1em] text-[#6b7280] mb-1">Bank Snapshot</h2>
                  <div className="text-xs text-[#9ca3af]">Last synced 6m ago</div>
                </div>
                <button className="text-xs font-heading font-bold uppercase tracking-wider px-3 py-1.5 rounded border border-[#d8dce4] text-[#1f2937] hover:bg-[#f9fafb] transition-colors flex items-center gap-1.5">
                   Sync
                </button>
              </div>
              <div className="space-y-4">
                <div className="flex justify-between items-center text-sm">
                  <div className="flex items-center gap-2">
                     <div className="w-1.5 h-1.5 rounded-full bg-[#059669]"></div>
                     <span className="text-[#4b5563]">Chase Checking</span>
                  </div>
                  <span className="font-mono font-medium">$4,217.83</span>
                </div>
                <div className="flex justify-between items-center text-sm">
                  <div className="flex items-center gap-2">
                     <div className="w-1.5 h-1.5 rounded-full bg-[#059669]"></div>
                     <span className="text-[#4b5563]">Amex •••1009</span>
                  </div>
                  <span className="font-mono font-medium text-[#b91c1c]">-$2,184.55</span>
                </div>
                <div className="flex justify-between items-center text-sm">
                  <div className="flex items-center gap-2">
                     <div className="w-1.5 h-1.5 rounded-full bg-[#059669]"></div>
                     <span className="text-[#4b5563]">Cap One Savings</span>
                  </div>
                  <span className="font-mono font-medium">$12,400.00</span>
                </div>
              </div>
            </div>

          </div>
        </div>
      </main>
    </div>
  );
}

// Components
function NavItem({ icon, label, active, badge }: any) {
  return (
    <a href="#" className={`flex items-center justify-between px-3 py-2 rounded-md text-sm font-medium transition-colors ${active ? 'bg-[#111827] text-white relative' : 'text-[#9ca3af] hover:text-white hover:bg-[#374151]/50'}`}>
      {active && <div className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-[#c2410c] rounded-r-sm"></div>}
      <div className="flex items-center gap-3">
        <span className={active ? 'text-white' : 'text-[#6b7280]'}>{icon}</span>
        {label}
      </div>
      {badge && (
        <span className="text-[10px] font-mono font-medium px-1.5 py-0.5 rounded border border-[#6b21a8] text-[#d8b4fe] bg-[#6b21a8]/10">
          {badge}
        </span>
      )}
    </a>
  );
}

function StatTile({ label, value, positive }: any) {
  return (
    <div className="brushed-metal border border-[#d8dce4] rounded-md p-5 relative">
       <div className="text-[10px] font-heading font-bold uppercase tracking-[0.1em] text-[#6b7280] mb-2">{label}</div>
       <div className={`text-xl font-mono font-medium ${positive ? 'text-[#059669]' : 'text-[#1f2937]'}`}>{value}</div>
    </div>
  );
}

function InboxRow({ date, merchant, amount }: any) {
  return (
    <tr className="border-b border-[#f3f4f6] last:border-0 hover:bg-[#f9fafb] transition-colors">
      <td className="px-5 py-3 whitespace-nowrap text-[#6b7280]">{date}</td>
      <td className="px-5 py-3 font-medium text-[#1f2937]">{merchant}</td>
      <td className="px-5 py-3 whitespace-nowrap text-right font-mono font-medium text-[#b91c1c]">{amount}</td>
    </tr>
  );
}

function TxRow({ date, merchant, cat, src, amount, pos }: any) {
  return (
    <tr className="hover:bg-[#f9fafb] transition-colors">
      <td className="px-5 py-3 whitespace-nowrap text-[#6b7280]">{date}</td>
      <td className="px-5 py-3 font-medium text-[#1f2937]">{merchant}</td>
      <td className="px-5 py-3">
        <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-[#f3f4f6] text-[#4b5563] border border-[#e5e7eb] font-medium">
          {cat}
        </span>
      </td>
      <td className="px-5 py-3 text-[#6b7280] font-mono text-xs uppercase">{src}</td>
      <td className={`px-5 py-3 whitespace-nowrap text-right font-mono font-medium ${pos ? 'text-[#059669]' : 'text-[#b91c1c]'}`}>{amount}</td>
    </tr>
  );
}

function BucketRow({ label, spent, budget, over }: any) {
  const pct = Math.min((spent / budget) * 100, 100);
  return (
    <div>
      <div className="flex justify-between items-baseline mb-1">
        <span className="text-sm font-medium text-[#1f2937]">{label}</span>
        <div className="font-mono text-xs">
          <span className={over ? 'text-[#b91c1c] font-semibold' : 'text-[#1f2937]'}>${spent}</span>
          <span className="text-[#9ca3af]"> / ${budget}</span>
        </div>
      </div>
      <div className="h-1.5 w-full bg-[#f3f4f6] rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${over ? 'bg-[#b91c1c]' : 'bg-[#1f2937]'}`} style={{ width: `${pct}%` }}></div>
      </div>
    </div>
  );
}

function DebtRow({ name, balance, rate, target }: any) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-sm font-medium text-[#1f2937]">{name}</span>
          {target && <span className="text-[9px] uppercase tracking-widest px-1.5 py-0.5 rounded border border-[#6b21a8] text-[#6b21a8] font-bold">Target</span>}
        </div>
        <div className="text-xs text-[#6b7280]">APR: <span className="font-mono">{rate}</span></div>
      </div>
      <div className="text-sm font-mono font-medium text-[#1f2937]">{balance}</div>
    </div>
  );
}
