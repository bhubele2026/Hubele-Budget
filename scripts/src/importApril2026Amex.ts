/**
 * One-time backfill: import April 2026 Amex activity from the user's pasted
 * statement file into transactions, fully categorized, and persist the April
 * ending balance on the (auto-created if missing) Amex debt so the Amex page's
 * month picker (Task #85) shows accurate "Apr 2026" numbers. Idempotent: a
 * re-run wipes only the user's existing source='amex' rows in 2026-04 and
 * re-inserts.
 *
 * Sign convention (per Task #93): expense charges are stored POSITIVE, and
 * payments / credits / income are stored NEGATIVE — matches the amex.tsx
 * monthTotals math (positive => CHARGES, negative => PAYMENTS & CREDITS).
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

const FILE = path.resolve(
  import.meta.dirname,
  "../../attached_assets/Pasted-1-2026-04-01-AplPay-CITY-VIEW-LIQMADISON-WI-BRAD-HUBELE_1777807298433.txt",
);
const USER_ID = "user_3DBrWZkCKIzrkYoLS6N9tIMcdso";
const APRIL_FROM = "2026-04-01";
const APRIL_TO = "2026-04-30";

type Row = {
  index: number;
  date: string;
  description: string;
  merchantHint: string | null;
  member: string | null;
  type: "expense" | "income" | "transfer";
  rawCategory: string;
  amount: number;
  runningBalance: number;
};

function parseFile(text: string): Row[] {
  const lines = text.split(/\r?\n/);
  const rows: Row[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^\s*(\d+)\s+(\d{4}-\d{2}-\d{2})\s*$/);
    if (!m) {
      i++;
      continue;
    }
    const index = Number(m[1]);
    const date = m[2];
    i++;

    const block: string[] = [];
    while (i < lines.length && !/^\s*\d+\s+\d{4}-\d{2}-\d{2}\s*$/.test(lines[i])) {
      block.push(lines[i]);
      i++;
    }

    // Walk block fields. Skip blank lines except as separators.
    const nonEmpty = block.map((l) => l.trim()).filter((l) => l.length > 0);
    if (nonEmpty.length < 4) continue;

    const description = nonEmpty[0];
    let cursor = 1;
    let merchantHint: string | null = null;
    if (nonEmpty[cursor]?.startsWith("Merchant:")) {
      merchantHint = nonEmpty[cursor].slice("Merchant:".length).trim();
      cursor++;
    }
    const memberRaw = nonEmpty[cursor++] ?? "";
    const member =
      memberRaw === "—" || memberRaw === "-" || memberRaw === ""
        ? null
        : memberRaw === "BRAD HUBELE"
          ? "Brad"
          : memberRaw === "HANNAH HUBELE"
            ? "Hannah"
            : memberRaw;
    const type = (nonEmpty[cursor++] ?? "expense").toLowerCase() as Row["type"];
    const rawCategory = nonEmpty[cursor++] ?? "Uncategorized";

    // Last non-empty line carries amount and running balance, separated by
    // whitespace. Some rows have the amount on its own line and balance on
    // the next; detect by counting numeric tokens.
    const tail = nonEmpty.slice(cursor).join(" ");
    const numMatches = tail.match(/-?\$?[\d,]+\.\d{2}/g);
    if (!numMatches || numMatches.length < 2) continue;
    const toNum = (s: string) =>
      Number(s.replace(/[$,]/g, ""));
    const amount = toNum(numMatches[0]);
    const runningBalance = toNum(numMatches[1]);

    rows.push({
      index,
      date,
      description,
      merchantHint,
      member,
      type,
      rawCategory,
      amount,
      runningBalance,
    });
  }
  return rows;
}

/**
 * Pull the first ~2 significant alphanumeric tokens from a description so
 * "AplPay CITY VIEW LIQMADISON WI" and "AplPay CITY VIEW LIQMADISON" both
 * normalize to the same fingerprint for de-duplication against Plaid copies.
 * Stripped: AplPay/MERCHANT prefixes, TST/PP/DD/ZIP star-prefixes, trailing
 * state abbreviations, punctuation noise.
 */
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

const PAYMENT_PATTERNS = [
  /ONLINE PAYMENT - THANK YOU/i,
  /MOBILE PAYMENT - THANK YOU/i,
  /POINTS FOR STATEMENT CREDIT/i,
  /Platinum .* Credit/i,
];

function isPaymentOrCredit(r: Row): boolean {
  if (r.type === "transfer" || r.type === "income") return true;
  return PAYMENT_PATTERNS.some((p) => p.test(r.description));
}

/**
 * Drop Plaid-style "Merchant:" / member='—' rows that duplicate a member-
 * labeled row within ±1 day, same |amount|, same merchant token. Returns the
 * surviving rows in original index order.
 */
function dedupe(rows: Row[]): Row[] {
  const labeled = rows.filter((r) => r.member !== null);
  const drop = new Set<number>();
  for (const r of rows) {
    if (r.member !== null) continue;
    const tok = merchantToken(r.merchantHint ?? r.description);
    const rDate = new Date(r.date + "T00:00:00Z").getTime();
    const match = labeled.find((l) => {
      const lDate = new Date(l.date + "T00:00:00Z").getTime();
      const dayDiff = Math.abs(lDate - rDate) / 86_400_000;
      if (dayDiff > 1) return false;
      if (Math.abs(l.amount - r.amount) > 0.001) return false;
      const lt = merchantToken(l.description);
      return lt === tok || lt.startsWith(tok) || tok.startsWith(lt);
    });
    if (match) drop.add(r.index);
  }
  return rows.filter((r) => !drop.has(r.index));
}

/** Maps the file's category strings to the names present in
 * budget_categories for this user. Anything not in this map (or "Uncategorized")
 * falls through to merchant-based heuristics in `categorizeByMerchant`. */
const RAW_CATEGORY_MAP: Record<string, string> = {
  "Restaurants & Bars": "Restaurants & Bars",
  "Brewers F&B / Streaming Sports": "Brewers F&B / Streaming Sports",
  "Coffee (Starbucks, Dunkin)": "Coffee (Starbucks, Dunkin)",
  "Camp K9 (Pet Boarding)": "Camp K9 (Pet Boarding)",
  "Charitable Giving (Athenaeum)": "Charitable Giving (Athenaeum)",
  "Groceries ($425/wk × 4.33 wks)": "Groceries ($425/wk × 4.33 wks)",
  "Tech Subscriptions (Boost, Ring, Tonal)":
    "Tech Subscriptions (Boost, Ring, Tonal)",
  "Movies / Concerts / Other Fun": "Movies / Concerts / Other Fun",
  "Childcare / School Costs": "Childcare / School Costs",
  "Misc / Buffer": "Misc / Buffer",
  "Other Tech / Software": "Other Tech / Software",
  "Streaming (Netflix, Hulu, Spotify, Peacock)":
    "Streaming (Netflix, Hulu, Spotify, Peacock)",
  "DoorDash & Delivery": "DoorDash & Delivery",
  "Auto Maintenance / Wash": "Auto Maintenance / Wash",
  "Gasoline (Kwik Trip / Woodmans)": "Gasoline (Kwik Trip / Woodmans)",
  "Education (Becker, Eastern Univ)": "Education (Becker, Eastern Univ)",
  "Vet / Pet Other": "Vet / Pet Other",
  "Walmart / Target": "Walmart / Target",
  "Home Maintenance / Repairs": "Home Maintenance / Repairs",
  "Gaming subs": "Gaming subs",
  "Clothing (Threadbeast/Stitch/Lulu)": "Clothing (Threadbeast/Stitch/Lulu)",
};

/** Plaid PFC values → best-fit user category. Used only when a Plaid-only
 * row survives de-dup (no member-labeled twin). */
const PLAID_PFC_MAP: Record<string, string> = {
  FOOD_AND_DRINK: "Restaurants & Bars",
  GENERAL_MERCHANDISE: "Misc / Buffer",
  ENTERTAINMENT: "Movies / Concerts / Other Fun",
  GENERAL_SERVICES: "Misc / Buffer",
  PERSONAL_CARE: "Misc / Buffer",
  MEDICAL: "Health/Medical Out-of-Pocket",
  TRANSPORTATION: "Gasoline (Kwik Trip / Woodmans)",
  HOME_IMPROVEMENT: "Home & Menards",
  RENT_AND_UTILITIES: "Internet/Cable (AT&T Uverse)",
  TRAVEL: "Misc / Buffer",
  LOAN_PAYMENTS: "Misc / Buffer",
  INCOME: "Misc / Buffer",
  OTHER: "Misc / Buffer",
};

/** Merchant-text fallback for "Uncategorized" rows. Order matters: longer /
 * more specific patterns first. */
const MERCHANT_FALLBACK: { match: RegExp; category: string }[] = [
  { match: /interest charge/i, category: "Misc / Buffer" },
  { match: /points for statement credit/i, category: "Misc / Buffer" },
  { match: /(online|mobile) payment - thank you/i, category: "Misc / Buffer" },
  { match: /platinum .* credit/i, category: "Misc / Buffer" },

  { match: /threadbeast/i, category: "Clothing (Threadbeast/Stitch/Lulu)" },
  { match: /lululemon/i, category: "Clothing (Threadbeast/Stitch/Lulu)" },

  { match: /best buy/i, category: "Best Buy / Electronics" },
  { match: /\bzip\* best buy/i, category: "Best Buy / Electronics" },

  { match: /netease/i, category: "Other Tech / Software" },
  { match: /claude\.ai|anthropic/i, category: "Other Tech / Software" },
  { match: /openai|chatgpt/i, category: "Other Tech / Software" },
  { match: /tmna subscription/i, category: "Other Tech / Software" },
  { match: /efax/i, category: "Other Tech / Software" },
  { match: /lovable/i, category: "Other Tech / Software" },
  { match: /tax1099/i, category: "Other Tech / Software" },
  { match: /zenwork/i, category: "Other Tech / Software" },
  { match: /bill\*bill/i, category: "Other Tech / Software" },

  { match: /spotify/i, category: "Streaming (Netflix, Hulu, Spotify, Peacock)" },
  { match: /netflix/i, category: "Streaming (Netflix, Hulu, Spotify, Peacock)" },
  { match: /peacock/i, category: "Streaming (Netflix, Hulu, Spotify, Peacock)" },
  { match: /hulu/i, category: "Streaming (Netflix, Hulu, Spotify, Peacock)" },
  { match: /paramount\+/i, category: "Streaming (Netflix, Hulu, Spotify, Peacock)" },

  { match: /mlb tv/i, category: "Brewers F&B / Streaming Sports" },
  { match: /milwaukee bre|mlb\*brewers|brewers/i, category: "Brewers F&B / Streaming Sports" },

  { match: /rundisney|wb studio|overture center/i, category: "Movies / Concerts / Other Fun" },
  { match: /flix brewhouse/i, category: "Movies / Concerts / Other Fun" },

  { match: /peloton/i, category: "Tech Subscriptions (Boost, Ring, Tonal)" },
  { match: /\bring\b/i, category: "Tech Subscriptions (Boost, Ring, Tonal)" },
  { match: /boost membership/i, category: "Tech Subscriptions (Boost, Ring, Tonal)" },

  { match: /playstation/i, category: "Gaming subs" },

  { match: /spot pet|chewy/i, category: "Vet / Pet Other" },
  { match: /camp k9|k9 crush/i, category: "Camp K9 (Pet Boarding)" },

  { match: /madison metro school|madison newspapers/i, category: "Childcare / School Costs" },
  { match: /becker professional|eastern univ|opc col\*service fee/i, category: "Education (Becker, Eastern Univ)" },
  { match: /athenaeum/i, category: "Charitable Giving (Athenaeum)" },

  { match: /target\.com|^target$/i, category: "Walmart / Target" },
  { match: /walmart/i, category: "Walmart / Target" },

  { match: /at&t uverse/i, category: "Internet/Cable (AT&T Uverse)" },
  { match: /universal home prote/i, category: "Home Maintenance / Repairs" },
  { match: /kopke/i, category: "Home & Menards" },

  { match: /il tollway/i, category: "Auto Maintenance / Wash" },
  { match: /kwik trip|woodmans/i, category: "Gasoline (Kwik Trip / Woodmans)" },
  { match: /triton auto/i, category: "Auto Maintenance / Wash" },

  { match: /metro market|hungryroot/i, category: "Groceries ($425/wk × 4.33 wks)" },
  { match: /doordash|seamlss|pokebay/i, category: "DoorDash & Delivery" },
  { match: /starbucks|dunkin|grace ?coff|exact science/i, category: "Coffee (Starbucks, Dunkin)" },
  {
    match:
      /city view liq|harleys liquor|harley s balt|cousins m|ancora|milio|yako sushi|weber grill|bodihow|working draft|igredo|starkweather|kopke|wtb &|berkshire room|chinanew|scoop, scoop|pokebay|seamlss/i,
    category: "Restaurants & Bars",
  },

  { match: /vrbo/i, category: "Misc / Buffer" },
  { match: /simm associates/i, category: "Misc / Buffer" },
  { match: /neat fades|barbersho/i, category: "Misc / Buffer" },
  { match: /iti\* wido/i, category: "Misc / Buffer" },
];

function chooseCategory(
  r: Row,
  byName: Map<string, string>,
): { categoryId: string | null; rawTried: string[] } {
  const rawTried: string[] = [];
  // 1) Explicit user-labeled category
  if (RAW_CATEGORY_MAP[r.rawCategory]) {
    const target = RAW_CATEGORY_MAP[r.rawCategory];
    const id = byName.get(target);
    rawTried.push(`raw=${r.rawCategory}->${target}`);
    if (id) return { categoryId: id, rawTried };
  }
  // 2) Merchant fallback (works for Uncategorized rows AND Plaid-only rows)
  const haystack = `${r.description} ${r.merchantHint ?? ""}`;
  for (const f of MERCHANT_FALLBACK) {
    if (f.match.test(haystack)) {
      const id = byName.get(f.category);
      rawTried.push(`merchant->${f.category}`);
      if (id) return { categoryId: id, rawTried };
    }
  }
  // 3) Plaid PFC fallback
  if (PLAID_PFC_MAP[r.rawCategory]) {
    const target = PLAID_PFC_MAP[r.rawCategory];
    const id = byName.get(target);
    rawTried.push(`pfc=${r.rawCategory}->${target}`);
    if (id) return { categoryId: id, rawTried };
  }
  // 4) Hard fallback
  const fallback = byName.get("Misc / Buffer");
  rawTried.push(`fallback->Misc / Buffer`);
  return { categoryId: fallback ?? null, rawTried };
}

async function main() {
  const text = readFileSync(FILE, "utf-8");
  const allRows = parseFile(text);
  console.log(`Parsed ${allRows.length} raw rows from file`);

  // Restrict to April 2026
  const april = allRows.filter(
    (r) => r.date >= APRIL_FROM && r.date <= APRIL_TO,
  );
  console.log(`April rows before dedup: ${april.length}`);

  const surviving = dedupe(april);
  console.log(`April rows after dedup: ${surviving.length}`);

  // Find ending balance: the running balance on the last April-dated row.
  const lastApril = april[april.length - 1];
  if (!lastApril) throw new Error("No April rows parsed");
  const endingBalance = lastApril.runningBalance;
  console.log(
    `April 30 ending balance from file: ${endingBalance} (row #${lastApril.index} ${lastApril.description})`,
  );

  // Load category name -> id for this user.
  const cats = await db
    .select({ id: budgetCategoriesTable.id, name: budgetCategoriesTable.name })
    .from(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.userId, USER_ID));
  const byName = new Map(cats.map((c) => [c.name, c.id]));
  if (!byName.size) throw new Error("No budget categories for user — cannot categorize");

  // Build inserts.
  const inserts: typeof transactionsTable.$inferInsert[] = [];
  let unmapped = 0;
  for (const r of surviving) {
    const isTransfer = isPaymentOrCredit(r);
    const { categoryId } = chooseCategory(r, byName);
    if (!categoryId) {
      unmapped++;
      console.warn(
        `UNMAPPED: ${r.date} ${r.description} rawCat=${r.rawCategory}`,
      );
    }
    // Sign per task: expenses (charges) positive; payments/credits/income negative.
    const signedAmount = isTransfer
      ? -Math.abs(r.amount)
      : Math.abs(r.amount);
    inserts.push({
      userId: USER_ID,
      occurredOn: r.date,
      description: r.description,
      member: r.member ?? null,
      amount: signedAmount.toFixed(2),
      categoryId,
      isTransfer,
      source: "amex",
    });
  }
  console.log(`Built ${inserts.length} inserts; unmapped=${unmapped}`);

  await db.transaction(async (tx) => {
    // Idempotent: wipe existing source='amex' rows in April 2026 for this user.
    const del = await tx
      .delete(transactionsTable)
      .where(
        and(
          eq(transactionsTable.userId, USER_ID),
          eq(transactionsTable.source, "amex"),
          gte(transactionsTable.occurredOn, APRIL_FROM),
          lte(transactionsTable.occurredOn, APRIL_TO),
        ),
      )
      .returning({ id: transactionsTable.id });
    console.log(`Deleted ${del.length} existing April amex rows`);

    if (inserts.length) {
      // Insert in chunks
      const CHUNK = 200;
      for (let i = 0; i < inserts.length; i += CHUNK) {
        await tx.insert(transactionsTable).values(inserts.slice(i, i + CHUNK));
      }
    }

    // Find or create Amex debt; set its balance to the file's last April
    // running balance so the amex page (Task #85) anchors month-rollback math
    // on a true number.
    const existing = await tx
      .select({ id: debtsTable.id })
      .from(debtsTable)
      .where(
        and(
          eq(debtsTable.userId, USER_ID),
          sql`${debtsTable.name} ILIKE ${"%amex%"}`,
        ),
      )
      .limit(1);
    if (existing.length) {
      await tx
        .update(debtsTable)
        .set({ balance: endingBalance.toFixed(2) })
        .where(eq(debtsTable.id, existing[0].id));
      console.log(`Updated existing Amex debt ${existing[0].id} balance to ${endingBalance}`);
    } else {
      const [d] = await tx
        .insert(debtsTable)
        .values({
          userId: USER_ID,
          name: "Amex Delta SkyMiles Gold",
          type: "credit_card",
          apr: "0.2849",
          balance: endingBalance.toFixed(2),
          minPayment: "40.00",
          payment: "40.00",
        })
        .returning({ id: debtsTable.id });
      console.log(`Created Amex debt ${d.id} balance=${endingBalance}`);
    }
  });

  // Reconciliation summary
  let charges = 0;
  let payments = 0;
  for (const r of inserts) {
    const a = Number(r.amount);
    if (a > 0) charges += a;
    else payments += a;
  }
  console.log(`SUMMARY  charges=${charges.toFixed(2)}  payments=${payments.toFixed(2)}  netChange=${(charges + payments).toFixed(2)}`);
  console.log(`Ending balance set to ${endingBalance.toFixed(2)}`);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
