/**
 * One-shot import: bring in the three late-April + May-1 Amex CSVs
 * (cards -71009, -51006, -31009) the user just downloaded, dedupe against
 * whatever's already in `transactions` (from the April backfill or Plaid),
 * and pin the combined Amex debt balance to $1,293.08 so the Amex page's
 * current-month ending balance reads correctly.
 *
 * Sign convention (per importApril2026Amex.ts and amex.tsx monthTotals):
 *   charges => POSITIVE, payments/credits => NEGATIVE.
 *
 * Dedupe key: occurredOn + normalized merchant token of description +
 * |amount|, scoped to source='amex' for this user.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import {
  db,
  pool,
  transactionsTable,
  debtsTable,
  budgetCategoriesTable,
} from "@workspace/db";

const USER_ID = "user_3DBrWZkCKIzrkYoLS6N9tIMcdso";
const TARGET_BALANCE = 1293.08;
const FROM = "2026-04-29";
const TO = "2026-05-01";

const FILES = [
  "../../attached_assets/activity_(10)_1777818568416.csv",
  "../../attached_assets/activity_(9)_1777818573567.csv",
  "../../attached_assets/activity_(8)_1777818578338.csv",
].map((p) => path.resolve(import.meta.dirname, p));

type Row = {
  date: string; // YYYY-MM-DD
  description: string;
  member: string | null;
  card: string;
  amount: number; // sign per CSV: positive=charge, negative=payment
};

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQ = false;
      } else cur += c;
    } else {
      if (c === ",") {
        out.push(cur);
        cur = "";
      } else if (c === '"') inQ = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function parseFile(filePath: string): Row[] {
  const text = readFileSync(filePath, "utf-8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const rows: Row[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < 5) continue;
    const [dateStr, descRaw, memberRaw, card, amtRaw] = cols;
    const m = dateStr.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) continue;
    const date = `${m[3]}-${m[1]}-${m[2]}`;
    const description = descRaw.replace(/\s+/g, " ").trim();
    const member =
      memberRaw === "BRAD HUBELE"
        ? "Brad"
        : memberRaw === "HANNAH HUBELE"
          ? "Hannah"
          : memberRaw.trim() || null;
    const amount = Number(amtRaw.replace(/[$,]/g, ""));
    if (!Number.isFinite(amount)) continue;
    rows.push({ date, description, member, card: card.trim(), amount });
  }
  return rows;
}

/** Same fingerprinting style as importApril2026Amex.ts */
function merchantToken(s: string): string {
  let t = s.toUpperCase();
  t = t.replace(/^MERCHANT:\s*/i, "");
  t = t.replace(/\bAPLPAY\b/g, " ");
  t = t.replace(/\b(TST|PP|DD|ZIP|HLU|ITI|OPC|PY|MLB|TMNA|BILL)\*\s*/g, " ");
  t = t.replace(/[#*().,]/g, " ");
  t = t.replace(/\b\d{2,}\b/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  const tokens = t.split(" ").filter(Boolean);
  return tokens.slice(0, 2).join(" ");
}

const PAYMENT_RE = /ONLINE PAYMENT - THANK YOU|MOBILE PAYMENT - THANK YOU/i;

function isPayment(r: Row): boolean {
  return PAYMENT_RE.test(r.description) || r.amount < 0;
}

const MERCHANT_FALLBACK: { match: RegExp; category: string }[] = [
  { match: /(online|mobile) payment - thank you/i, category: "Misc / Buffer" },
  { match: /lovable/i, category: "Other Tech / Software" },
  { match: /replit/i, category: "Other Tech / Software" },
  { match: /tax1099/i, category: "Other Tech / Software" },
  { match: /simm associates/i, category: "Misc / Buffer" },
  { match: /pokebay/i, category: "DoorDash & Delivery" },
  { match: /dd\/br|dd \*br/i, category: "DoorDash & Delivery" },
  { match: /harley/i, category: "Restaurants & Bars" },
  { match: /exact science/i, category: "Coffee (Starbucks, Dunkin)" },
];

function chooseCategory(
  r: Row,
  byName: Map<string, string>,
): string | null {
  for (const f of MERCHANT_FALLBACK) {
    if (f.match.test(r.description)) {
      const id = byName.get(f.category);
      if (id) return id;
    }
  }
  return byName.get("Misc / Buffer") ?? null;
}

async function main() {
  const allCsvRows: Row[] = [];
  for (const f of FILES) {
    const rows = parseFile(f);
    console.log(`Parsed ${rows.length} rows from ${path.basename(f)}`);
    allCsvRows.push(...rows);
  }
  console.log(`Total CSV rows: ${allCsvRows.length}`);

  // Load existing source='amex' rows in date range to dedupe against.
  const existing = await db
    .select({
      occurredOn: transactionsTable.occurredOn,
      description: transactionsTable.description,
      amount: transactionsTable.amount,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.userId, USER_ID),
        eq(transactionsTable.source, "amex"),
        gte(transactionsTable.occurredOn, FROM),
        lte(transactionsTable.occurredOn, TO),
      ),
    );
  const existingKeys = new Set<string>();
  for (const e of existing) {
    const tok = merchantToken(e.description);
    const abs = Math.abs(Number(e.amount)).toFixed(2);
    existingKeys.add(`${e.occurredOn}|${tok}|${abs}`);
  }
  console.log(`Existing amex rows in window: ${existing.length}`);

  const cats = await db
    .select({ id: budgetCategoriesTable.id, name: budgetCategoriesTable.name })
    .from(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.userId, USER_ID));
  const byName = new Map(cats.map((c) => [c.name, c.id]));
  if (!byName.size) throw new Error("No budget categories for user");

  const inserts: typeof transactionsTable.$inferInsert[] = [];
  let skipped = 0;
  // Track per-batch dupes within the CSVs themselves so two identical rows
  // in the same file produce two inserts only if both don't already exist.
  const batchSeen = new Map<string, number>();
  for (const r of allCsvRows) {
    const tok = merchantToken(r.description);
    const abs = Math.abs(r.amount).toFixed(2);
    const key = `${r.date}|${tok}|${abs}`;
    const seenInBatch = batchSeen.get(key) ?? 0;
    // Count how many existing DB rows share this key (handles the two
    // identical Lovable $50 rows on the same day).
    let existingCount = 0;
    for (const e of existing) {
      const ek = `${e.occurredOn}|${merchantToken(e.description)}|${Math.abs(Number(e.amount)).toFixed(2)}`;
      if (ek === key) existingCount++;
    }
    if (seenInBatch < existingCount) {
      // This CSV row is already represented by an existing DB row.
      skipped++;
      batchSeen.set(key, seenInBatch + 1);
      continue;
    }
    batchSeen.set(key, seenInBatch + 1);

    const payment = isPayment(r);
    const signed = payment ? -Math.abs(r.amount) : Math.abs(r.amount);
    inserts.push({
      userId: USER_ID,
      occurredOn: r.date,
      description: r.description,
      member: r.member,
      amount: signed.toFixed(2),
      categoryId: chooseCategory(r, byName),
      isTransfer: payment,
      source: "amex",
    });
  }

  console.log(`To insert: ${inserts.length}, skipped as dup: ${skipped}`);

  await db.transaction(async (tx) => {
    if (inserts.length) {
      await tx.insert(transactionsTable).values(inserts);
    }

    const existingDebt = await tx
      .select({ id: debtsTable.id })
      .from(debtsTable)
      .where(
        and(
          eq(debtsTable.userId, USER_ID),
          sql`${debtsTable.name} ILIKE ${"%amex%"}`,
        ),
      )
      .limit(1);
    if (existingDebt.length) {
      await tx
        .update(debtsTable)
        .set({ balance: TARGET_BALANCE.toFixed(2) })
        .where(eq(debtsTable.id, existingDebt[0].id));
      console.log(
        `Updated Amex debt ${existingDebt[0].id} balance -> ${TARGET_BALANCE}`,
      );
    } else {
      const [d] = await tx
        .insert(debtsTable)
        .values({
          userId: USER_ID,
          name: "Amex Delta SkyMiles Gold",
          type: "credit_card",
          apr: "0.2849",
          balance: TARGET_BALANCE.toFixed(2),
          minPayment: "40.00",
          payment: "40.00",
        })
        .returning({ id: debtsTable.id });
      console.log(`Created Amex debt ${d.id} balance=${TARGET_BALANCE}`);
    }
  });

  let charges = 0;
  let payments = 0;
  for (const r of inserts) {
    const a = Number(r.amount);
    if (a > 0) charges += a;
    else payments += a;
  }
  console.log(
    `SUMMARY inserted=${inserts.length} skipped=${skipped} charges=${charges.toFixed(2)} payments=${payments.toFixed(2)} endingBalance=${TARGET_BALANCE.toFixed(2)}`,
  );

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
