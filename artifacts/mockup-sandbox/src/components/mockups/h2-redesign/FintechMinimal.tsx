const rows = [
  { date: "May 24", desc: "Whole Foods Market", cat: "Groceries", amt: -142.18 },
  { date: "May 23", desc: "Payroll · Acme Corp", cat: "Income", amt: 6840.00 },
  { date: "May 22", desc: "Pacific Gas & Electric", cat: "Utilities", amt: -187.42 },
  { date: "May 21", desc: "Blue Bottle Coffee", cat: "Dining", amt: -7.25 },
  { date: "May 20", desc: "Vanguard transfer", cat: "Investing", amt: -1500.00 },
];

const fmt = (n: number) =>
  (n < 0 ? "−" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function FintechMinimal() {
  return (
    <div
      className="min-h-screen w-full"
      style={{
        background: "#FAFAFA",
        color: "#0A0E1A",
        fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif",
        fontFeatureSettings: '"cv11","ss01","ss03"',
      }}
    >
      <div className="mx-auto max-w-[920px] px-12 py-16">
        {/* Header */}
        <header className="flex items-center justify-between pb-14 border-b border-[#E6E8EC]">
          <div className="flex items-center gap-3">
            <div className="h-7 w-7 rounded-sm bg-[#0A0E1A]" />
            <span className="text-[15px] font-semibold tracking-tight">Halberd</span>
          </div>
          <nav className="flex items-center gap-8 text-[13px] text-[#5A6172]">
            <span className="text-[#0A0E1A]">Overview</span>
            <span>Accounts</span>
            <span>Transactions</span>
            <span>Reports</span>
          </nav>
          <div className="flex items-center gap-3">
            <span className="text-[13px] text-[#5A6172]">erin@halberd.co</span>
            <div className="h-7 w-7 rounded-full bg-[#E6E8EC]" />
          </div>
        </header>

        {/* Title block */}
        <section className="pt-14 pb-10">
          <p className="text-[12px] uppercase tracking-[0.14em] text-[#5A6172] mb-3">Design system · v0.1</p>
          <h1 className="text-[44px] leading-[1.05] font-semibold tracking-[-0.028em]">
            A restrained system for serious money.
          </h1>
          <p className="mt-5 text-[15px] leading-[1.65] text-[#5A6172] max-w-[560px]">
            Typography is the hierarchy. Whitespace carries the weight. One accent does the work.
          </p>
        </section>

        {/* Balance card */}
        <section className="rounded-md border border-[#E6E8EC] bg-white p-8 mb-12">
          <div className="flex items-baseline justify-between">
            <div>
              <p className="text-[12px] uppercase tracking-[0.14em] text-[#5A6172]">Net worth</p>
              <p className="mt-3 text-[42px] font-semibold tabular-nums tracking-[-0.022em]">$184,329.04</p>
              <p className="mt-2 text-[13px] text-[#5A6172]">
                <span className="text-[#0F7B4A]">+ $2,184.20</span> this month
              </p>
            </div>
            <div className="text-right">
              <p className="text-[12px] uppercase tracking-[0.14em] text-[#5A6172]">As of</p>
              <p className="mt-3 text-[14px] tabular-nums">May 27, 2026</p>
            </div>
          </div>
          <div className="mt-8 h-[2px] w-full bg-[#F1F2F5]">
            <div className="h-full bg-[#0A0E1A]" style={{ width: "62%" }} />
          </div>
          <div className="mt-3 flex justify-between text-[12px] text-[#5A6172] tabular-nums">
            <span>62% of FY target</span>
            <span>$298,000 goal</span>
          </div>
        </section>

        {/* Table */}
        <section className="mb-12">
          <div className="flex items-baseline justify-between mb-5">
            <h2 className="text-[20px] font-semibold tracking-[-0.018em]">Recent activity</h2>
            <span className="text-[13px] text-[#5A6172]">5 of 1,284</span>
          </div>
          <div className="rounded-md border border-[#E6E8EC] bg-white overflow-hidden">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-[#5A6172] bg-[#F8F9FA]">
                  <th className="px-5 py-3 font-medium">Date</th>
                  <th className="px-5 py-3 font-medium">Description</th>
                  <th className="px-5 py-3 font-medium">Category</th>
                  <th className="px-5 py-3 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className={i !== rows.length - 1 ? "border-b border-[#F1F2F5]" : ""}>
                    <td className="px-5 py-3.5 tabular-nums text-[#5A6172]">{r.date}</td>
                    <td className="px-5 py-3.5">{r.desc}</td>
                    <td className="px-5 py-3.5 text-[#5A6172]">{r.cat}</td>
                    <td className="px-5 py-3.5 tabular-nums text-right">
                      <span className={r.amt > 0 ? "text-[#0F7B4A]" : "text-[#0A0E1A]"}>{fmt(r.amt)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Form */}
        <section className="mb-12">
          <h2 className="text-[20px] font-semibold tracking-[-0.018em] mb-5">Add transfer</h2>
          <div className="grid grid-cols-2 gap-5">
            <label className="block">
              <span className="block text-[12px] font-medium text-[#3A4153] mb-2">Recipient</span>
              <input
                defaultValue="Vanguard · brokerage"
                className="w-full h-10 px-3.5 text-[14px] bg-white border border-[#D7DBE2] rounded-md focus:outline-none focus:border-[#0A0E1A] focus:ring-2 focus:ring-[#0A0E1A]/10"
              />
            </label>
            <label className="block">
              <span className="block text-[12px] font-medium text-[#3A4153] mb-2">Amount</span>
              <input
                defaultValue="$1,500.00"
                className="w-full h-10 px-3.5 text-[14px] tabular-nums bg-white border border-[#D7DBE2] rounded-md focus:outline-none focus:border-[#0A0E1A] focus:ring-2 focus:ring-[#0A0E1A]/10"
              />
            </label>
          </div>
        </section>

        {/* Buttons */}
        <section className="mb-12">
          <h2 className="text-[20px] font-semibold tracking-[-0.018em] mb-5">Actions</h2>
          <div className="flex items-center gap-3">
            <button className="h-10 px-5 text-[13px] font-medium text-white bg-[#0A0E1A] rounded-md hover:bg-[#1A1F2E]">
              Schedule transfer
            </button>
            <button className="h-10 px-5 text-[13px] font-medium text-[#0A0E1A] bg-white border border-[#D7DBE2] rounded-md hover:bg-[#F8F9FA]">
              Save draft
            </button>
            <button className="h-10 px-3 text-[13px] font-medium text-[#3A4153] hover:text-[#0A0E1A]">
              Cancel
            </button>
            <div className="flex-1" />
            <button className="h-10 px-5 text-[13px] font-medium text-[#B0231C] bg-white border border-[#E8C9C6] rounded-md hover:bg-[#FBF3F2]">
              Delete account
            </button>
          </div>
        </section>

        {/* Chips / badges */}
        <section>
          <h2 className="text-[20px] font-semibold tracking-[-0.018em] mb-5">Tags</h2>
          <div className="flex flex-wrap items-center gap-2">
            {[
              { label: "Reconciled", tone: "default" },
              { label: "Pending", tone: "muted" },
              { label: "Verified", tone: "accent" },
              { label: "Tax · 2025", tone: "default" },
              { label: "Flagged", tone: "danger" },
              { label: "Recurring", tone: "muted" },
            ].map((b) => {
              const styles =
                b.tone === "accent"
                  ? "bg-[#0A0E1A] text-white border-[#0A0E1A]"
                  : b.tone === "danger"
                  ? "bg-[#FBF3F2] text-[#B0231C] border-[#E8C9C6]"
                  : b.tone === "muted"
                  ? "bg-[#F1F2F5] text-[#5A6172] border-[#F1F2F5]"
                  : "bg-white text-[#0A0E1A] border-[#D7DBE2]";
              return (
                <span
                  key={b.label}
                  className={`inline-flex items-center h-6 px-2.5 text-[11px] font-medium rounded-sm border ${styles}`}
                >
                  {b.label}
                </span>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
