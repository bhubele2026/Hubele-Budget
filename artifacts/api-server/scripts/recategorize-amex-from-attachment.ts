/**
 * Backfill script: assign budget categories to all `categoryId IS NULL`
 * Amex/Plaid transactions for the user, using a merchant→category map
 * PARSED FROM the attached export
 * (`attached_assets/Pasted--Date-Description-Card-Type-Category-Wk-Mo-Un-Re-Amount_*.txt`).
 *
 * Scope guarantees (so the script can never touch unrelated rows):
 *   1. Only Amex (`source = 'amex'`) and Plaid (`source LIKE 'plaid:%'`) txns.
 *   2. Only rows whose `occurred_on` falls inside the date range present in
 *      the attachment (min..max date observed when parsing).
 *   3. Only rows whose description contains a merchant key actually parsed
 *      from the attachment. Anything else is logged as skipped.
 *   4. Existing categories are never overwritten — `category_id IS NULL` is
 *      re-asserted in the UPDATE WHERE clause.
 *
 * Each parsed record contributes votes under TWO normalized keys when
 * available: one derived from the raw description (matches Amex import
 * descriptions) and one derived from the Plaid `Merchant:` hint (matches
 * Plaid sync descriptions, which `plaidSync.ts` stores as
 * `t.merchant_name || t.name`). Both keys are seeded into `mapping_rules`
 * (priority 100) so future imports auto-categorize regardless of source.
 *
 * The mapping-rule upsert uses `lib/autoCategorize.ts:upsertMappingRule` —
 * the same helper the manual quick-categorize flow uses — so learning
 * semantics stay in one place.
 *
 * Usage (runnable from anywhere; attachment path is resolved relative to
 * this script file):
 *   ./scripts/node_modules/.bin/tsx \
 *     artifacts/api-server/scripts/recategorize-amex-from-attachment.ts        # dry run
 *   ./scripts/node_modules/.bin/tsx \
 *     artifacts/api-server/scripts/recategorize-amex-from-attachment.ts --apply
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq, gte, inArray, isNull, like, lte, or } from "drizzle-orm";
import {
  budgetCategoriesTable,
  db,
  transactionsTable,
  upsertMappingRule,
} from "@workspace/db";

const TARGET_USER_ID =
  process.env.TARGET_USER_ID ?? "user_3DBrWZkCKIzrkYoLS6N9tIMcdso";
const APPLY = process.argv.includes("--apply");
const DRY_RUN = !APPLY;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ATTACHMENT_PATH = resolve(
  SCRIPT_DIR,
  "../../../attached_assets/Pasted--Date-Description-Card-Type-Category-Wk-Mo-Un-Re-Amount_1777808556865.txt",
);

// ---------------------------------------------------------------------------
// Old-name → current-name collapse. The attachment was exported BEFORE the
// budget_categories table was consolidated to a shorter list, so the
// "Category" column in the file uses long names that no longer exist in DB.
// ---------------------------------------------------------------------------
const OLD_TO_CURRENT: Record<string, string> = {
  "Restaurants & Bars": "Dining & Coffee",
  "Coffee (Starbucks, Dunkin)": "Dining & Coffee",
  "DoorDash & Delivery": "Dining & Coffee",
  "Brewers F&B / Streaming Sports": "Entertainment",
  "Movies / Concerts / Other Fun": "Entertainment",
  "Streaming (Netflix, Hulu, Spotify, Peacock)": "Subscriptions",
  "Tech Subscriptions (Boost, Ring, Tonal)": "Subscriptions",
  "Other Tech / Software": "Subscriptions",
  "Gaming subs": "Subscriptions",
  "Groceries ($425/wk × 4.33 wks)": "Groceries",
  "Walmart / Target": "Shopping",
  "Clothing (Threadbeast/Stitch/Lulu)": "Shopping",
  "Camp K9 (Pet Boarding)": "Pets",
  "Vet / Pet Other": "Pets",
  "Charitable Giving (Athenaeum)": "Charitable Giving & Education",
  "Education (Becker, Eastern Univ)": "Charitable Giving & Education",
  "Childcare / School Costs": "Childcare & Activities",
  "Gasoline (Kwik Trip / Woodmans)": "Gas, Maintenance & Parking",
  "Auto Maintenance / Wash": "Gas, Maintenance & Parking",
  "Home Maintenance / Repairs": "Home Maintenance & Warranty",
  "Misc / Buffer": "Misc / Buffer",
  // Pass-through: current names that may already appear in the file.
  "Dining & Coffee": "Dining & Coffee",
  "Entertainment": "Entertainment",
  "Subscriptions": "Subscriptions",
  "Groceries": "Groceries",
  "Shopping": "Shopping",
  "Pets": "Pets",
  "Charitable Giving & Education": "Charitable Giving & Education",
  "Childcare & Activities": "Childcare & Activities",
  "Gas, Maintenance & Parking": "Gas, Maintenance & Parking",
  "Home Maintenance & Warranty": "Home Maintenance & Warranty",
  "Health": "Health",
  "Insurance": "Insurance",
  "Utilities": "Utilities",
};

// Plaid `personal_finance_category.primary` values are too generic to vote
// directly. If a merchant has ONLY these votes, fall back via PFC_FALLBACK.
const GENERIC_PLAID_CATEGORIES = new Set([
  "FOOD_AND_DRINK",
  "ENTERTAINMENT",
  "GENERAL_MERCHANDISE",
  "MEDICAL",
  "GENERAL_SERVICES",
  "PERSONAL_CARE",
  "HOME_IMPROVEMENT",
  "TRANSPORTATION",
  "TRAVEL",
  "RENT_AND_UTILITIES",
  "LOAN_PAYMENTS",
  "INCOME",
  "OTHER",
]);

const PFC_FALLBACK: Record<string, string | "transfer" | "skip"> = {
  FOOD_AND_DRINK: "Dining & Coffee",
  ENTERTAINMENT: "Entertainment",
  GENERAL_MERCHANDISE: "Shopping",
  MEDICAL: "Health",
  GENERAL_SERVICES: "Misc / Buffer",
  PERSONAL_CARE: "Misc / Buffer",
  HOME_IMPROVEMENT: "Home Maintenance & Warranty",
  TRANSPORTATION: "Gas, Maintenance & Parking",
  TRAVEL: "Misc / Buffer",
  RENT_AND_UTILITIES: "Utilities",
  LOAN_PAYMENTS: "transfer",
  INCOME: "skip",
  OTHER: "skip",
};

// "Uncategorized" in the file means the user hadn't categorized that row in
// the source spreadsheet either; ignore those votes entirely.
const IGNORE_FILE_CATEGORIES = new Set(["", "Uncategorized"]);

// ---------------------------------------------------------------------------
// Attachment parser. Each record block:
//
//   1\t2026-04-01\t
//   AplPay CITY VIEW LIQMADISON WI         <- description
//   [Merchant: City View Liquor]            <- optional Plaid merchant hint
//   BRAD HUBELE | HANNAH HUBELE | —         <- cardholder
//   expense | income | transfer             <- type
//   <Category text>                         <- file's category column
//   <amount columns>
// ---------------------------------------------------------------------------
type ParsedRecord = {
  idx: number;
  date: string;
  description: string;
  merchantHint: string | null;
  type: "expense" | "income" | "transfer";
  category: string;
};

function parseAttachment(path: string): ParsedRecord[] {
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n").map((l) => l.replace(/\r$/, ""));
  const startRe = /^(\d+)\t(\d{4}-\d{2}-\d{2})/;

  type Block = { idx: number; date: string; lines: string[] };
  const blocks: Block[] = [];
  let cur: Block | null = null;
  for (const line of lines) {
    const m = startRe.exec(line);
    if (m) {
      if (cur) blocks.push(cur);
      cur = { idx: Number(m[1]), date: m[2], lines: [] };
    } else if (cur && line.trim()) {
      cur.lines.push(line.trim());
    }
  }
  if (cur) blocks.push(cur);

  const records: ParsedRecord[] = [];
  const cardholderRe = /^(BRAD|HANNAH)\s+HUBELE\b|^—$/;
  const amountRe = /^\$?-?[\d,]+\.\d{2}$/;
  const typeRe = /^(expense|income|transfer)$/;

  for (const b of blocks) {
    let i = 0;
    const description = b.lines[i++] ?? "";
    let merchantHint: string | null = null;
    if (b.lines[i]?.startsWith("Merchant: ")) {
      merchantHint = b.lines[i].slice("Merchant: ".length).trim() || null;
      i++;
    }
    if (i < b.lines.length && cardholderRe.test(b.lines[i])) i++;
    const typeLine = b.lines[i++] ?? "";
    if (!typeRe.test(typeLine)) continue;
    const type = typeLine as ParsedRecord["type"];
    let category = "";
    while (i < b.lines.length) {
      const candidate = b.lines[i++];
      if (!candidate || amountRe.test(candidate)) continue;
      if (/[\t ]\$/.test(candidate)) continue;
      category = candidate;
      break;
    }
    records.push({
      idx: b.idx,
      date: b.date,
      description,
      merchantHint,
      type,
      category: category.trim(),
    });
  }
  return records;
}

// ---------------------------------------------------------------------------
// Merchant-key normalization. Produces a short, lowercase substring suitable
// as a `contains` rule pattern. Strips: "AplPay " prefix, anything after the
// first `#` or `*` (Amex reference suffixes), trailing 2-letter state code,
// trailing pure-digit / phone-fragment tokens. Then keeps the first 2 tokens.
// ---------------------------------------------------------------------------
const STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "DC",
]);

function normalizeMerchant(input: string): string {
  let s = input.replace(/\t.*$/, "").trim();
  s = s.replace(/^AplPay\s+/i, "");
  // Strip everything after first `#` or `*` (Amex ref tail) — but keep the
  // marker token's leading word if it stands alone (e.g. "DD *DOORDASH").
  s = s.replace(/\s+[#*].*$/, "");
  s = s.replace(/[#*].*$/, "");
  let tokens = s.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && STATE_CODES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  while (
    tokens.length > 1 &&
    /^[\d-]+$/.test(tokens[tokens.length - 1])
  ) {
    tokens.pop();
  }
  const head = tokens.slice(0, 2).join(" ").slice(0, 30);
  return head.toLowerCase();
}

// ---------------------------------------------------------------------------
// Vote aggregation.
//
// Each record contributes vote(s) under up to TWO keys:
//   - hintKey  = normalize(merchantHint)   — when a Plaid Merchant: line is
//                present. This key matches future Plaid imports because
//                `plaidSync.ts` stores `t.merchant_name || t.name` as the
//                txn description.
//   - descKey  = normalize(description)    — matches the Amex import
//                description (and Plaid descriptions when no merchant_name
//                is available).
// Both keys vote for the same category, so they end up in the same plan
// bucket. Both get seeded into mapping_rules so future imports of either
// source auto-categorize.
// ---------------------------------------------------------------------------
type Action =
  | { kind: "category"; categoryName: string; sample: string }
  | { kind: "transfer"; sample: string }
  | { kind: "skip"; reason: string; sample: string };

type Tally = {
  categoryVotes: Map<string, number>;
  genericVotes: Map<string, number>;
  transferVotes: number;
  incomeVotes: number;
  sample: string;
};

function emptyTally(sample: string): Tally {
  return {
    categoryVotes: new Map(),
    genericVotes: new Map(),
    transferVotes: 0,
    incomeVotes: 0,
    sample,
  };
}

function addVote(
  t: Tally,
  rec: ParsedRecord,
  unresolvedCategories: Set<string>,
): void {
  if (rec.type === "transfer") {
    t.transferVotes++;
    return;
  }
  if (rec.type === "income") {
    t.incomeVotes++;
    return;
  }
  if (IGNORE_FILE_CATEGORIES.has(rec.category)) return;
  if (GENERIC_PLAID_CATEGORIES.has(rec.category)) {
    t.genericVotes.set(
      rec.category,
      (t.genericVotes.get(rec.category) ?? 0) + 1,
    );
    return;
  }
  const collapsed = OLD_TO_CURRENT[rec.category];
  if (!collapsed) {
    unresolvedCategories.add(rec.category);
    return;
  }
  t.categoryVotes.set(collapsed, (t.categoryVotes.get(collapsed) ?? 0) + 1);
}

function resolveAction(t: Tally): Action {
  if (t.transferVotes > 0 && t.categoryVotes.size === 0) {
    return { kind: "transfer", sample: t.sample };
  }
  if (
    t.incomeVotes > 0 &&
    t.categoryVotes.size === 0 &&
    t.genericVotes.size === 0
  ) {
    return { kind: "skip", reason: "income", sample: t.sample };
  }
  if (t.categoryVotes.size > 0) {
    const top = [...t.categoryVotes.entries()].sort((a, b) => b[1] - a[1])[0];
    return { kind: "category", categoryName: top[0], sample: t.sample };
  }
  if (t.genericVotes.size > 0) {
    const top = [...t.genericVotes.entries()].sort((a, b) => b[1] - a[1])[0];
    const bucket = PFC_FALLBACK[top[0]];
    if (!bucket) {
      return {
        kind: "skip",
        reason: `unknown PFC ${top[0]}`,
        sample: t.sample,
      };
    }
    if (bucket === "transfer") return { kind: "transfer", sample: t.sample };
    if (bucket === "skip") {
      return { kind: "skip", reason: `pfc=${top[0]}`, sample: t.sample };
    }
    return { kind: "category", categoryName: bucket, sample: t.sample };
  }
  return { kind: "skip", reason: "no votes", sample: t.sample };
}

function buildPlan(records: ParsedRecord[]): {
  entries: Array<{ key: string; action: Action }>;
  unresolvedCategories: Set<string>;
  dateMin: string;
  dateMax: string;
} {
  const tallies = new Map<string, Tally>();
  const unresolvedCategories = new Set<string>();
  let dateMin = "9999-12-31";
  let dateMax = "0000-01-01";

  for (const r of records) {
    if (r.date < dateMin) dateMin = r.date;
    if (r.date > dateMax) dateMax = r.date;

    const keys = new Set<string>();
    const descKey = normalizeMerchant(r.description);
    if (descKey.length >= 3) keys.add(descKey);
    if (r.merchantHint) {
      const hintKey = normalizeMerchant(r.merchantHint);
      if (hintKey.length >= 3) keys.add(hintKey);
    }
    for (const k of keys) {
      const t = tallies.get(k) ?? emptyTally(r.merchantHint ?? r.description);
      addVote(t, r, unresolvedCategories);
      tallies.set(k, t);
    }
  }

  const entries = [...tallies.entries()].map(([key, t]) => ({
    key,
    action: resolveAction(t),
  }));
  // Longer keys first so contains-matching prefers more specific patterns
  // when two plan keys could both match the same description.
  entries.sort((a, b) => b.key.length - a.key.length);

  return { entries, unresolvedCategories, dateMin, dateMax };
}

// `contains` lookup mirroring `autoCategorize.matchRule` semantics: first
// plan entry whose key is a substring of the (lowercased) description wins.
function findMatch(
  description: string,
  entries: Array<{ key: string; action: Action }>,
): { key: string; action: Action } | null {
  const hay = description.toLowerCase();
  for (const e of entries) {
    if (hay.includes(e.key)) return e;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log(
    `[recategorize] mode=${DRY_RUN ? "DRY-RUN" : "APPLY"} user=${TARGET_USER_ID}`,
  );
  console.log(`[recategorize] attachment=${ATTACHMENT_PATH}`);

  const records = parseAttachment(ATTACHMENT_PATH);
  console.log(`[recategorize] parsed ${records.length} records from attachment`);

  const { entries, unresolvedCategories, dateMin, dateMax } =
    buildPlan(records);
  console.log(`[recategorize] attachment date range: ${dateMin} .. ${dateMax}`);
  console.log(`[recategorize] unique merchant keys parsed: ${entries.length}`);
  if (unresolvedCategories.size > 0) {
    console.warn(
      `[recategorize] WARN — file categories with no OLD_TO_CURRENT mapping (votes ignored): ${[
        ...unresolvedCategories,
      ].join(", ")}`,
    );
  }

  // Resolve current category names → ids and validate every plan target
  // exists. Fail loudly otherwise (per task spec).
  const cats = await db
    .select({ id: budgetCategoriesTable.id, name: budgetCategoriesTable.name })
    .from(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.userId, TARGET_USER_ID));
  const catIdByName = new Map(cats.map((c) => [c.name, c.id]));

  const missing = new Set<string>();
  for (const e of entries) {
    if (e.action.kind === "category" && !catIdByName.has(e.action.categoryName)) {
      missing.add(e.action.categoryName);
    }
  }
  if (missing.size > 0) {
    console.error(
      `[recategorize] ERROR — missing budget_categories for: ${[...missing].join(", ")}`,
    );
    process.exit(1);
  }

  // Fetch candidate uncategorized Amex/Plaid txns inside the attachment date
  // range only.
  const candidates = await db
    .select({
      id: transactionsTable.id,
      description: transactionsTable.description,
      source: transactionsTable.source,
      occurredOn: transactionsTable.occurredOn,
      isTransfer: transactionsTable.isTransfer,
    })
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.userId, TARGET_USER_ID),
        isNull(transactionsTable.categoryId),
        gte(transactionsTable.occurredOn, dateMin),
        lte(transactionsTable.occurredOn, dateMax),
        or(
          eq(transactionsTable.source, "amex"),
          like(transactionsTable.source, "plaid:%"),
        ),
      ),
    );
  console.log(
    `[recategorize] candidate uncategorized rows in date range: ${candidates.length}`,
  );

  type Update = {
    id: string;
    key: string;
    description: string;
    action: Action;
  };
  const updates: Update[] = [];
  const skipped: { id: string; description: string; reason: string }[] = [];
  for (const t of candidates) {
    const match = findMatch(t.description ?? "", entries);
    if (!match) {
      skipped.push({
        id: t.id,
        description: t.description,
        reason: "no merchant key from attachment matches this description",
      });
      continue;
    }
    if (match.action.kind === "skip") {
      skipped.push({
        id: t.id,
        description: t.description,
        reason: `plan skip: ${match.action.reason}`,
      });
      continue;
    }
    updates.push({
      id: t.id,
      key: match.key,
      description: t.description,
      action: match.action,
    });
  }

  // Plan summary by (category, key).
  const planByKey = new Map<
    string,
    { label: string; key: string; count: number; sample: string }
  >();
  for (const u of updates) {
    const label =
      u.action.kind === "transfer" ? "(transfer)" : u.action.categoryName;
    const k = `${label}|${u.key}`;
    const existing = planByKey.get(k) ?? {
      label,
      key: u.key,
      count: 0,
      sample: u.description,
    };
    existing.count++;
    planByKey.set(k, existing);
  }
  console.log("\n[recategorize] plan by merchant key (parsed from file):");
  const sortedPlan = [...planByKey.values()].sort((a, b) => b.count - a.count);
  for (const p of sortedPlan) {
    console.log(
      `  ${String(p.count).padStart(4)}  ${p.label.padEnd(34)} key="${p.key}"  e.g. ${p.sample}`,
    );
  }
  console.log(
    `\n[recategorize] would update: ${updates.length}; skipped: ${skipped.length}`,
  );
  if (skipped.length > 0) {
    console.log(
      `[recategorize] skipped sample (first 20 of ${skipped.length}):`,
    );
    for (const s of skipped.slice(0, 20)) {
      console.log(`  - ${s.description}  [${s.reason}]`);
    }
  }

  let txnsUpdated = 0;
  let rulesCreated = 0;
  let rulesUpdated = 0;
  let rulesSkipped = 0;

  if (APPLY) {
    await db.transaction(async (tx) => {
      type Bucket = {
        ids: string[];
        categoryId: string | null;
        setTransfer: boolean;
      };
      const buckets = new Map<string, Bucket>();
      for (const u of updates) {
        const categoryId =
          u.action.kind === "category"
            ? (catIdByName.get(u.action.categoryName) ?? null)
            : null;
        const setTransfer = u.action.kind === "transfer";
        const k = `${categoryId ?? "null"}|${setTransfer}`;
        const b = buckets.get(k) ?? { ids: [], categoryId, setTransfer };
        b.ids.push(u.id);
        buckets.set(k, b);
      }
      for (const b of buckets.values()) {
        const setClause: Record<string, unknown> = {};
        if (b.categoryId) setClause.categoryId = b.categoryId;
        if (b.setTransfer) setClause.isTransfer = true;
        if (Object.keys(setClause).length === 0) continue;
        const res = await tx
          .update(transactionsTable)
          .set(setClause)
          .where(
            and(
              eq(transactionsTable.userId, TARGET_USER_ID),
              isNull(transactionsTable.categoryId),
              inArray(transactionsTable.id, b.ids),
            ),
          )
          .returning({ id: transactionsTable.id });
        txnsUpdated += res.length;
      }

      // Seed mapping_rules for every plan entry that resolves to a real
      // category. Transfer entries are intentionally NOT seeded (mapping_rules
      // routes to categories only). Both desc-derived and hint-derived keys
      // get seeded so future imports of either source auto-categorize.
      for (const e of entries) {
        if (e.action.kind !== "category") continue;
        const categoryId = catIdByName.get(e.action.categoryName)!;
        const result = await upsertMappingRule(tx, {
          userId: TARGET_USER_ID,
          pattern: e.key,
          matchType: "contains",
          categoryId,
          priority: 100,
        });
        if (result.status === "inserted") rulesCreated++;
        else if (result.status === "updated") rulesUpdated++;
        else rulesSkipped++;
      }
    });
  }

  console.log(
    `\n[recategorize] result: txnsUpdated=${txnsUpdated} rulesCreated=${rulesCreated} rulesUpdated=${rulesUpdated} rulesSkipped=${rulesSkipped} skipped=${skipped.length} (${DRY_RUN ? "dry-run, nothing written" : "applied"})`,
  );

  await db.$client.end();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await db.$client.end();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
