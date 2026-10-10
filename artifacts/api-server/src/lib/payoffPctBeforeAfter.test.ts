// (WP4 / WP4b) % PAID ON A REAL /debts PAYLOAD, ON EACH RULE IT HAS HAD.
//
// For the review note on the owner's data, read-only. Save GET /api/debts to a
// file, then:
//   DEBTS_JSON=/path/to/debts.json pnpm --filter ./artifacts/api-server exec vitest run src/lib/payoffPctBeforeAfter.test.ts --silent=false
// It prints each debt (status, anchor, balance, pending, basis) and % paid on
// three rules: before WP4 (`status !== "paid_off"`, anchored), WP4 (active and
// anchored) and WP4b, the current one (every active debt, measured against
// max(anchor, owed) — `payoffPct`). No database, no network: it reads the file.
// Without DEBTS_JSON it runs a built-in sample shaped like the fixture.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { effectiveDebtBalance, inPayoffPopulation, payoffBasisOf, payoffPct } from "@workspace/avalanche-core";

type DebtLike = {
  name?: string;
  status?: string | null;
  balance: string | number;
  originalBalance?: string | number | null;
  pendingPaymentTotal?: string | number | null;
};

/** The earlier rules (anchored only), kept here only to state the before figures. */
function anchoredPct(debts: readonly DebtLike[], keep: (d: DebtLike) => boolean): number | null {
  let sumOrig = 0;
  let sumBal = 0;
  for (const d of debts) {
    if (!keep(d)) continue;
    const orig = Number(d.originalBalance ?? 0) || 0;
    if (orig <= 0) continue;
    sumOrig += orig;
    sumBal += Math.min(effectiveDebtBalance(d), orig);
  }
  if (sumOrig <= 0) return null;
  return Math.max(0, Math.min(1, (sumOrig - sumBal) / sumOrig)) * 100;
}
const payoffPctBeforeWp4 = (debts: readonly DebtLike[]) => anchoredPct(debts, (d) => d.status !== "paid_off");
const payoffPctWp4 = (debts: readonly DebtLike[]) => anchoredPct(debts, (d) => (d.status ?? "active") === "active");

const SAMPLE: DebtLike[] = [
  { name: "HELOC", status: "active", balance: "18500.00", originalBalance: "25000.00" },
  { name: "Archived card", status: "archived", balance: "0.00", originalBalance: "4200.00" },
  { name: "Card anchored at $0.00", status: "active", balance: "684.12", originalBalance: "0.00" },
];

const pct = (v: number | null) => (v == null ? "—" : `${v.toFixed(2)}%`);

describe("% paid before and after the WP4 population fix", () => {
  it("prints both for the payload", () => {
    const file = process.env.DEBTS_JSON;
    const debts: DebtLike[] = file ? JSON.parse(readFileSync(file, "utf8")) : SAMPLE;
    const lines = debts.map((d) =>
      [
        (d.name ?? "").padEnd(34).slice(0, 34),
        String(d.status ?? "").padEnd(9),
        `orig ${String(d.originalBalance ?? "—").padStart(10)}`,
        `bal ${String(d.balance).padStart(10)}`,
        `pending ${String(d.pendingPaymentTotal ?? "—").padStart(9)}`,
        inPayoffPopulation(d) ? `counted · basis ${payoffBasisOf(d).toFixed(2)}` : "out",
      ].join("  "),
    );
    const before = payoffPctBeforeWp4(debts);
    const mid = payoffPctWp4(debts);
    const after = payoffPct(debts);
    console.log(
      [
        `source: ${file ?? "built-in sample"}`,
        ...lines,
        `% paid before WP4 (status !== "paid_off", anchored): ${pct(before)}`,
        `% paid on WP4 (active and anchored):                 ${pct(mid)}`,
        `% paid on WP4b (every active debt, max(anchor, owed)): ${pct(after)}`,
      ].join("\n"),
    );
    if (!file) {
      expect(before).toBeCloseTo(36.64, 2);
      expect(mid).toBeCloseTo(26, 2);
      expect(after).toBeCloseTo(25.31, 2);
    }
  });
});
