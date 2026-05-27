const rows = [
  { date: "May 24", desc: "Whole Foods Market", cat: "Groceries", amt: -142.18 },
  { date: "May 23", desc: "Payroll · Acme Corp", cat: "Income", amt: 6840.00 },
  { date: "May 22", desc: "Pacific Gas & Electric", cat: "Utilities", amt: -187.42 },
  { date: "May 21", desc: "Blue Bottle Coffee", cat: "Dining", amt: -7.25 },
  { date: "May 20", desc: "Vanguard transfer", cat: "Investing", amt: -1500.00 },
];

const fmt = (n: number) =>
  (n < 0 ? "−" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const TEAL = "#10615C";
const TEAL_SOFT = "#E0EEEC";
const INK = "#1A2230";
const SLATE_BG = "#EEF0F3";
const SURFACE = "#FAFBFC";
const BORDER = "#D4D8DF";
const MUTED = "#5A6577";

export function SlateProfessional() {
  return (
    <div
      className="min-h-screen w-full"
      style={{
        background: SLATE_BG,
        color: INK,
        fontFamily: "'Geist', 'Inter', ui-sans-serif, system-ui, sans-serif",
      }}
    >
      <div className="mx-auto max-w-[940px] px-10 py-14">
        {/* Header */}
        <header
          className="flex items-center justify-between px-6 py-4 rounded-lg mb-10"
          style={{ background: SURFACE, border: `1px solid ${BORDER}` }}
        >
          <div className="flex items-center gap-3">
            <div
              className="h-8 w-8 rounded-md flex items-center justify-center"
              style={{ background: INK }}
            >
              <span className="text-[13px] font-semibold text-white">H₂</span>
            </div>
            <span className="text-[15px] font-semibold tracking-[-0.012em]">Harbor Ledger</span>
            <span
              className="ml-3 inline-flex items-center h-5 px-2 text-[10px] font-medium uppercase tracking-[0.1em] rounded"
              style={{ background: TEAL_SOFT, color: TEAL }}
            >
              Workspace
            </span>
          </div>
          <nav className="flex items-center gap-7 text-[13px]" style={{ color: MUTED }}>
            <span style={{ color: INK, fontWeight: 500 }}>Overview</span>
            <span>Ledger</span>
            <span>Forecast</span>
            <span>Reports</span>
          </nav>
          <div className="flex items-center gap-3">
            <button
              className="h-8 px-3 text-[12.5px] font-medium rounded-md"
              style={{ background: SURFACE, border: `1px solid ${BORDER}`, color: INK }}
            >
              Search ⌘K
            </button>
            <div
              className="h-8 w-8 rounded-full flex items-center justify-center text-[11px] font-semibold text-white"
              style={{ background: TEAL }}
            >
              EW
            </div>
          </div>
        </header>

        {/* Title */}
        <section className="mb-9">
          <p
            className="text-[11.5px] font-medium uppercase tracking-[0.14em] mb-3"
            style={{ color: TEAL }}
          >
            Design system · Slate
          </p>
          <h1 className="text-[40px] leading-[1.08] font-semibold tracking-[-0.024em]">
            Enterprise polish, without the enterprise chill.
          </h1>
          <p className="mt-4 text-[15px] leading-[1.6] max-w-[600px]" style={{ color: MUTED }}>
            A muted slate canvas, deep ink type, and one jewel-tone accent. Built to be read for hours, not minutes.
          </p>
        </section>

        {/* Balance card */}
        <section
          className="rounded-lg p-7 mb-10"
          style={{ background: SURFACE, border: `1px solid ${BORDER}` }}
        >
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[11.5px] font-medium uppercase tracking-[0.12em]" style={{ color: MUTED }}>
                Operating balance
              </p>
              <p className="mt-3 text-[40px] font-semibold tabular-nums tracking-[-0.022em]">
                $84,329.04
              </p>
              <div className="mt-2 flex items-center gap-2 text-[12.5px]">
                <span
                  className="inline-flex items-center h-5 px-1.5 rounded font-medium tabular-nums"
                  style={{ background: TEAL_SOFT, color: TEAL }}
                >
                  ↑ 4.8%
                </span>
                <span style={{ color: MUTED }}>vs. April</span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {["1M", "3M", "1Y", "All"].map((p, i) => (
                <button
                  key={p}
                  className="h-7 px-2.5 text-[12px] font-medium rounded"
                  style={
                    i === 1
                      ? { background: INK, color: "white" }
                      : { background: "transparent", color: MUTED }
                  }
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          {/* Mini bars */}
          <div className="mt-7 flex items-end gap-1.5 h-16">
            {[42, 58, 35, 70, 48, 80, 55, 92, 64, 76, 58, 88].map((h, i) => (
              <div
                key={i}
                className="flex-1 rounded-sm"
                style={{
                  height: `${h}%`,
                  background: i === 11 ? TEAL : "#C9D0DA",
                }}
              />
            ))}
          </div>
        </section>

        {/* Table */}
        <section className="mb-10">
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="text-[18px] font-semibold tracking-[-0.014em]">Recent activity</h2>
            <span className="text-[12.5px]" style={{ color: MUTED }}>
              Showing 5 of 1,284
            </span>
          </div>
          <div
            className="rounded-lg overflow-hidden"
            style={{ background: SURFACE, border: `1px solid ${BORDER}` }}
          >
            <table className="w-full text-[13px]">
              <thead>
                <tr
                  className="text-left text-[11px] font-medium uppercase tracking-[0.1em]"
                  style={{ color: MUTED, background: "#F4F6F8", borderBottom: `1px solid ${BORDER}` }}
                >
                  <th className="px-5 py-3">Date</th>
                  <th className="px-5 py-3">Description</th>
                  <th className="px-5 py-3">Category</th>
                  <th className="px-5 py-3 text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr
                    key={i}
                    style={i !== rows.length - 1 ? { borderBottom: `1px solid #E7EAEF` } : undefined}
                  >
                    <td className="px-5 py-3.5 tabular-nums" style={{ color: MUTED }}>
                      {r.date}
                    </td>
                    <td className="px-5 py-3.5">{r.desc}</td>
                    <td className="px-5 py-3.5">
                      <span
                        className="inline-flex items-center h-5 px-1.5 text-[11px] font-medium rounded"
                        style={{ background: "#EEF0F3", color: MUTED }}
                      >
                        {r.cat}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 tabular-nums text-right">
                      <span style={{ color: r.amt > 0 ? TEAL : INK, fontWeight: r.amt > 0 ? 500 : 400 }}>
                        {fmt(r.amt)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Form */}
        <section className="mb-10">
          <h2 className="text-[18px] font-semibold tracking-[-0.014em] mb-4">Schedule transfer</h2>
          <div
            className="grid grid-cols-2 gap-5 rounded-lg p-6"
            style={{ background: SURFACE, border: `1px solid ${BORDER}` }}
          >
            <label className="block">
              <span
                className="block text-[11.5px] font-medium uppercase tracking-[0.08em] mb-2"
                style={{ color: MUTED }}
              >
                Recipient account
              </span>
              <input
                defaultValue="Vanguard · brokerage"
                className="w-full h-10 px-3.5 text-[13.5px] rounded-md focus:outline-none"
                style={{ background: "white", border: `1px solid ${BORDER}` }}
              />
            </label>
            <label className="block">
              <span
                className="block text-[11.5px] font-medium uppercase tracking-[0.08em] mb-2"
                style={{ color: MUTED }}
              >
                Amount
              </span>
              <input
                defaultValue="$1,500.00"
                className="w-full h-10 px-3.5 text-[13.5px] tabular-nums rounded-md focus:outline-none"
                style={{ background: "white", border: `1px solid ${BORDER}` }}
              />
            </label>
          </div>
        </section>

        {/* Buttons */}
        <section className="mb-10">
          <h2 className="text-[18px] font-semibold tracking-[-0.014em] mb-4">Actions</h2>
          <div className="flex items-center gap-3">
            <button
              className="h-10 px-5 text-[13px] font-medium text-white rounded-md"
              style={{ background: TEAL }}
            >
              Schedule transfer
            </button>
            <button
              className="h-10 px-5 text-[13px] font-medium rounded-md"
              style={{ background: SURFACE, color: INK, border: `1px solid ${BORDER}` }}
            >
              Save draft
            </button>
            <button
              className="h-10 px-3 text-[13px] font-medium"
              style={{ color: MUTED }}
            >
              Cancel
            </button>
            <div className="flex-1" />
            <button
              className="h-10 px-5 text-[13px] font-medium rounded-md"
              style={{ background: SURFACE, color: "#9B2C2C", border: "1px solid #E5C6C6" }}
            >
              Delete ledger
            </button>
          </div>
        </section>

        {/* Chips */}
        <section>
          <h2 className="text-[18px] font-semibold tracking-[-0.014em] mb-4">Tags</h2>
          <div className="flex flex-wrap items-center gap-2">
            {[
              { label: "Reconciled", tone: "default" },
              { label: "Pending", tone: "muted" },
              { label: "Verified", tone: "accent" },
              { label: "Tax · 2025", tone: "default" },
              { label: "Flagged", tone: "danger" },
              { label: "Recurring", tone: "muted" },
            ].map((b) => {
              const style: React.CSSProperties =
                b.tone === "accent"
                  ? { background: TEAL_SOFT, color: TEAL }
                  : b.tone === "danger"
                  ? { background: "#FBEBEB", color: "#9B2C2C" }
                  : b.tone === "muted"
                  ? { background: "#E7EAEF", color: MUTED }
                  : { background: SURFACE, color: INK, border: `1px solid ${BORDER}` };
              return (
                <span
                  key={b.label}
                  className="inline-flex items-center h-6 px-2.5 text-[11.5px] font-medium rounded"
                  style={style}
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
