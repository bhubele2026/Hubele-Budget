const rows = [
  { date: "May 24", desc: "Whole Foods Market", cat: "Groceries", amt: -142.18 },
  { date: "May 23", desc: "Payroll · Acme Corp", cat: "Income", amt: 6840.00 },
  { date: "May 22", desc: "Pacific Gas & Electric", cat: "Utilities", amt: -187.42 },
  { date: "May 21", desc: "Blue Bottle Coffee", cat: "Dining", amt: -7.25 },
  { date: "May 20", desc: "Vanguard transfer", cat: "Investing", amt: -1500.00 },
];

const fmt = (n: number) =>
  (n < 0 ? "−" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function WarmPrivateBanking() {
  return (
    <div
      className="min-h-screen w-full"
      style={{
        background: "#F6F1E8",
        color: "#1B2A22",
        fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif",
      }}
    >
      <div className="mx-auto max-w-[920px] px-12 py-16">
        {/* Header */}
        <header
          className="flex items-center justify-between pb-12 border-b"
          style={{ borderColor: "rgba(27,42,34,0.14)" }}
        >
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-full bg-[#1B2A22] flex items-center justify-center">
              <span
                className="text-[#F6F1E8] text-[15px] leading-none"
                style={{ fontFamily: "'Source Serif 4', serif" }}
              >
                H
              </span>
            </div>
            <span
              className="text-[20px] tracking-[-0.01em]"
              style={{ fontFamily: "'Source Serif 4', serif", fontWeight: 500 }}
            >
              Holloway & Reed
            </span>
          </div>
          <nav className="flex items-center gap-8 text-[13px] text-[#4F5A52]">
            <span className="text-[#1B2A22]">Portfolio</span>
            <span>Accounts</span>
            <span>Advisors</span>
            <span>Documents</span>
          </nav>
          <div className="flex items-center gap-3">
            <span className="text-[13px] text-[#4F5A52]">Erin Whitfield</span>
            <div className="h-8 w-8 rounded-full bg-[#1B2A22] text-[#F6F1E8] flex items-center justify-center text-[12px] font-medium">
              EW
            </div>
          </div>
        </header>

        {/* Title */}
        <section className="pt-14 pb-10">
          <p
            className="text-[12px] tracking-[0.18em] uppercase mb-4"
            style={{ color: "#7A5A2E" }}
          >
            Private wealth · Spring statement
          </p>
          <h1
            className="text-[52px] leading-[1.04] tracking-[-0.018em]"
            style={{ fontFamily: "'Source Serif 4', serif", fontWeight: 400 }}
          >
            A considered home for your family's capital.
          </h1>
          <p className="mt-6 text-[15px] leading-[1.7] text-[#4F5A52] max-w-[580px]">
            Quiet typography, generous margins, and one warm accent — designed for clients who measure decisions in
            decades rather than days.
          </p>
        </section>

        {/* Balance card */}
        <section
          className="rounded-lg bg-[#FBF8F1] p-9 mb-12 border"
          style={{ borderColor: "rgba(27,42,34,0.12)" }}
        >
          <div className="flex items-baseline justify-between">
            <div>
              <p className="text-[12px] tracking-[0.18em] uppercase text-[#7A5A2E]">Total assets</p>
              <p
                className="mt-3 text-[44px] tabular-nums tracking-[-0.018em]"
                style={{ fontFamily: "'Source Serif 4', serif", fontWeight: 500 }}
              >
                $1,842,309.04
              </p>
              <p className="mt-2 text-[13px] text-[#4F5A52]">
                <span className="text-[#2E5E3E]">+ $14,820.18</span> · trailing 30 days
              </p>
            </div>
            <div className="text-right">
              <p className="text-[12px] tracking-[0.18em] uppercase text-[#7A5A2E]">As of</p>
              <p className="mt-3 text-[14px] tabular-nums text-[#4F5A52]">May 27, 2026</p>
            </div>
          </div>
          <div className="mt-9 h-[3px] w-full bg-[#EDE3CF] rounded-full overflow-hidden">
            <div className="h-full bg-[#7A5A2E]" style={{ width: "62%" }} />
          </div>
          <div className="mt-3 flex justify-between text-[12px] text-[#4F5A52] tabular-nums">
            <span>62% of legacy target</span>
            <span>$2,975,000 goal</span>
          </div>
        </section>

        {/* Table */}
        <section className="mb-12">
          <div className="flex items-baseline justify-between mb-5">
            <h2
              className="text-[24px] tracking-[-0.014em]"
              style={{ fontFamily: "'Source Serif 4', serif", fontWeight: 500 }}
            >
              Recent activity
            </h2>
            <span className="text-[13px] text-[#4F5A52]">5 of 1,284</span>
          </div>
          <div
            className="rounded-lg bg-[#FBF8F1] overflow-hidden border"
            style={{ borderColor: "rgba(27,42,34,0.12)" }}
          >
            <table className="w-full text-[13.5px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-[0.16em] text-[#7A5A2E]">
                  <th className="px-6 py-4 font-medium">Date</th>
                  <th className="px-6 py-4 font-medium">Description</th>
                  <th className="px-6 py-4 font-medium">Category</th>
                  <th className="px-6 py-4 font-medium text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr
                    key={i}
                    style={i !== rows.length - 1 ? { borderBottom: "1px solid rgba(27,42,34,0.08)" } : undefined}
                  >
                    <td className="px-6 py-4 tabular-nums text-[#4F5A52]">{r.date}</td>
                    <td className="px-6 py-4">{r.desc}</td>
                    <td className="px-6 py-4 text-[#4F5A52]">{r.cat}</td>
                    <td className="px-6 py-4 tabular-nums text-right">
                      <span className={r.amt > 0 ? "text-[#2E5E3E]" : "text-[#1B2A22]"}>{fmt(r.amt)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Form */}
        <section className="mb-12">
          <h2
            className="text-[24px] tracking-[-0.014em] mb-5"
            style={{ fontFamily: "'Source Serif 4', serif", fontWeight: 500 }}
          >
            Schedule a transfer
          </h2>
          <div className="grid grid-cols-2 gap-6">
            <label className="block">
              <span className="block text-[12px] tracking-[0.08em] uppercase text-[#7A5A2E] mb-2">Recipient</span>
              <input
                defaultValue="Vanguard · brokerage"
                className="w-full h-11 px-4 text-[14px] bg-[#FBF8F1] rounded-md focus:outline-none"
                style={{ border: "1px solid rgba(27,42,34,0.18)" }}
              />
            </label>
            <label className="block">
              <span className="block text-[12px] tracking-[0.08em] uppercase text-[#7A5A2E] mb-2">Amount</span>
              <input
                defaultValue="$1,500.00"
                className="w-full h-11 px-4 text-[14px] tabular-nums bg-[#FBF8F1] rounded-md focus:outline-none"
                style={{ border: "1px solid rgba(27,42,34,0.18)" }}
              />
            </label>
          </div>
        </section>

        {/* Buttons */}
        <section className="mb-12">
          <h2
            className="text-[24px] tracking-[-0.014em] mb-5"
            style={{ fontFamily: "'Source Serif 4', serif", fontWeight: 500 }}
          >
            Actions
          </h2>
          <div className="flex items-center gap-3">
            <button className="h-11 px-6 text-[13px] font-medium text-[#F6F1E8] bg-[#1B2A22] rounded-md hover:bg-[#27382E]">
              Schedule transfer
            </button>
            <button
              className="h-11 px-6 text-[13px] font-medium text-[#1B2A22] bg-[#FBF8F1] rounded-md"
              style={{ border: "1px solid rgba(27,42,34,0.22)" }}
            >
              Save draft
            </button>
            <button className="h-11 px-3 text-[13px] font-medium text-[#7A5A2E] hover:text-[#1B2A22]">
              Cancel
            </button>
            <div className="flex-1" />
            <button
              className="h-11 px-6 text-[13px] font-medium text-[#8A2A22] bg-[#F6E5DE] rounded-md"
              style={{ border: "1px solid rgba(138,42,34,0.22)" }}
            >
              Close account
            </button>
          </div>
        </section>

        {/* Chips */}
        <section>
          <h2
            className="text-[24px] tracking-[-0.014em] mb-5"
            style={{ fontFamily: "'Source Serif 4', serif", fontWeight: 500 }}
          >
            Tags
          </h2>
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
                  ? "bg-[#1B2A22] text-[#F6F1E8]"
                  : b.tone === "danger"
                  ? "bg-[#F6E5DE] text-[#8A2A22]"
                  : b.tone === "muted"
                  ? "bg-[#EDE3CF] text-[#4F5A52]"
                  : "bg-[#FBF8F1] text-[#1B2A22] border";
              return (
                <span
                  key={b.label}
                  className={`inline-flex items-center h-7 px-3 text-[11.5px] tracking-[0.04em] uppercase rounded-full ${styles}`}
                  style={b.tone === "default" ? { borderColor: "rgba(27,42,34,0.18)" } : undefined}
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
