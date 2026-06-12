/**
 * Find likely SUBSCRIPTIONS by scanning real transactions for the
 * tell-tale pattern: the same merchant charging about the same amount on a
 * regular cadence (weekly / monthly / yearly). Read-only — prints a list,
 * writes nothing.
 *
 * This catches subscriptions you never set up as recurring items, which the
 * Subscriptions card can't see on its own.
 *
 * Run from the repo root:
 *   pnpm --filter @workspace/scripts exec tsx ./src/detectSubscriptions.ts
 *   pnpm --filter @workspace/scripts exec tsx ./src/detectSubscriptions.ts --months=8
 */
import { and, eq, gte } from "drizzle-orm";
import { db, pool, householdsTable, transactionsTable } from "@workspace/db";
import { cleanMerchant } from "../../artifacts/api-server/src/lib/merchantNameExtract";

function argValue(flag: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`${flag}=`));
  return hit ? hit.slice(flag.length + 1) : null;
}

const DAY = 86_400_000;
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

type Cadence = { label: string; perYear: number } | null;
function classifyCadence(medianGapDays: number): Cadence {
  if (medianGapDays >= 5 && medianGapDays <= 9) return { label: "weekly", perYear: 52 };
  if (medianGapDays >= 12 && medianGapDays <= 17) return { label: "biweekly", perYear: 26 };
  if (medianGapDays >= 26 && medianGapDays <= 35) return { label: "monthly", perYear: 12 };
  if (medianGapDays >= 58 && medianGapDays <= 64) return { label: "bi-monthly", perYear: 6 };
  if (medianGapDays >= 85 && medianGapDays <= 95) return { label: "quarterly", perYear: 4 };
  if (medianGapDays >= 350 && medianGapDays <= 380) return { label: "yearly", perYear: 1 };
  return null;
}

async function main(): Promise<void> {
  const months = Number(argValue("--months") ?? "6");
  const cutoff = new Date();
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const cutoffISO = cutoff.toISOString().slice(0, 10);

  const households = await db.select().from(householdsTable);
  for (const h of households) {
    const rows = await db
      .select({
        occurredOn: transactionsTable.occurredOn,
        amount: transactionsTable.amount,
        description: transactionsTable.description,
        isTransfer: transactionsTable.isTransfer,
      })
      .from(transactionsTable)
      .where(
        and(
          eq(transactionsTable.householdId, h.id),
          gte(transactionsTable.occurredOn, cutoffISO),
        ),
      );

    // Group expenses (amount < 0, non-transfer) by cleaned merchant.
    const byMerchant = new Map<
      string,
      { dates: string[]; amounts: number[] }
    >();
    for (const r of rows) {
      const amt = Number(r.amount) || 0;
      if (amt >= 0 || r.isTransfer) continue; // expenses only, skip transfers
      const name = cleanMerchant(r.description) || "Unknown";
      const g = byMerchant.get(name) ?? { dates: [], amounts: [] };
      g.dates.push(r.occurredOn.slice(0, 10));
      g.amounts.push(Math.abs(amt));
      byMerchant.set(name, g);
    }

    type Hit = {
      merchant: string;
      cadence: string;
      typical: number;
      count: number;
      last: string;
      annual: number;
      confidence: string;
      stable: boolean;
    };
    const hits: Hit[] = [];

    for (const [merchant, g] of byMerchant) {
      if (g.dates.length < 2) continue;
      const dates = [...g.dates].sort();
      const gaps: number[] = [];
      for (let i = 1; i < dates.length; i++) {
        gaps.push(
          (new Date(`${dates[i]}T00:00:00Z`).getTime() -
            new Date(`${dates[i - 1]}T00:00:00Z`).getTime()) /
            DAY,
        );
      }
      const medGap = median(gaps);
      const cadence = classifyCadence(medGap);
      if (!cadence) continue;

      const typical = median(g.amounts);
      const lo = Math.min(...g.amounts);
      const hi = Math.max(...g.amounts);
      // Subscriptions bill a near-constant amount. Allow some drift for price
      // changes, but variable spend (groceries, dining) blows past this.
      const spread = typical > 0 ? (hi - lo) / typical : 1;
      const stable = spread <= 0.25;
      if (spread > 0.6) continue; // clearly variable — not a subscription

      hits.push({
        merchant,
        cadence: cadence.label,
        typical: Math.round(typical * 100) / 100,
        count: g.dates.length,
        last: dates[dates.length - 1],
        annual: Math.round(typical * cadence.perYear * 100) / 100,
        confidence:
          g.dates.length >= 3 && stable
            ? "high"
            : g.dates.length >= 3 || stable
              ? "medium"
              : "low",
        stable,
      });
    }

    hits.sort((a, b) => b.annual - a.annual);

    console.log(`\n=== Household ${h.id} — likely subscriptions (last ${months} months) ===`);
    if (hits.length === 0) {
      console.log("No recurring same-amount charges found.");
      continue;
    }
    const fmt = (n: number) => `$${n.toFixed(2)}`;
    for (const x of hits) {
      console.log(
        `[${x.confidence.toUpperCase().padEnd(6)}] ${x.merchant.padEnd(28)} ` +
          `${fmt(x.typical).padStart(9)} ${x.cadence.padEnd(10)} ` +
          `×${String(x.count).padStart(2)}  last ${x.last}  ~${fmt(x.annual)}/yr` +
          `${x.stable ? "" : "  (amount varies)"}`,
      );
    }
    const yearly = hits
      .filter((x) => x.confidence !== "low")
      .reduce((s, x) => s + x.annual, 0);
    console.log(`\nLikely-subscription total (high+medium): ~${fmt(yearly)}/yr`);
  }

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
