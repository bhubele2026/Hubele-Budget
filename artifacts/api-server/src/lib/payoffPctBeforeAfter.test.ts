// (WP4) % PAID ON A REAL /debts PAYLOAD, BEFORE AND AFTER THE POPULATION FIX.
//
// For the review note on the owner's data, read-only. Save GET /api/debts to a
// file, then:
//   DEBTS_JSON=/path/to/debts.json pnpm --filter ./artifacts/api-server exec vitest run src/lib/payoffPctBeforeAfter.test.ts --silent=false
// It prints each debt (status, anchor, balance, pending) and % paid on the old
// population (`status !== "paid_off"`) and the new one (active, anchored —
// `inPayoffPopulation`). No database, no network: it reads the file only.
// Without DEBTS_JSON it runs a built-in sample shaped like the fixture.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { effectiveDebtBalance, inPayoffPopulation, payoffPct } from "@workspace/avalanche-core";

type DebtLike = {
  name?: string;
  status?: string | null;
  balance: string | number;
  originalBalance?: string | number | null;
  pendingPaymentTotal?: string | number | null;
};

/** The pre-WP4 rule, kept here only to state the before figure. */
function payoffPctBeforeWp4(debts: readonly DebtLike[]): number | null {
  let sumOrig = 0;
  let sumBal = 0;
  for (const d of debts) {
    if (d.status === "paid_off") continue;
    const orig = Number(d.originalBalance ?? 0) || 0;
    if (orig <= 0) continue;
    sumOrig += orig;
    sumBal += Math.min(effectiveDebtBalance(d), orig);
  }
  if (sumOrig <= 0) return null;
  return Math.max(0, Math.min(1, (sumOrig - sumBal) / sumOrig)) * 100;
}

const SAMPLE: DebtLike[] = [
  { name: "HELOC", status: "active", balance: "18500.00", originalBalance: "25000.00" },
  { name: "Archived card", status: "archived", balance: "0.00", originalBalance: "4200.00" },
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
        inPayoffPopulation(d) ? "counted" : "out",
      ].join("  "),
    );
    const before = payoffPctBeforeWp4(debts);
    const after = payoffPct(debts);
    console.log(
      [
        `source: ${file ?? "built-in sample"}`,
        ...lines,
        `% paid before WP4 (status !== "paid_off"): ${pct(before)}`,
        `% paid after WP4 (active, anchored):        ${pct(after)}`,
      ].join("\n"),
    );
    if (!file) {
      expect(before).toBeCloseTo(36.64, 2);
      expect(after).toBeCloseTo(26, 2);
    }
  });
});
