/**
 * One-shot backfill: re-categorize the user's April 2026 Chase transactions
 * (source='plaid:chase', occurred_on in 2026-04-01..2026-04-30) so the generic
 * Plaid buckets (LOAN_PAYMENTS, FOOD_AND_DRINK, RENT_AND_UTILITIES, ...) are
 * replaced with real H2 budget categories. Also flags true transfers as
 * is_transfer=true so they don't pollute budget actuals, and persists each
 * applied merchant pattern as a high-priority mapping_rules row so future
 * Chase Plaid syncs auto-categorize the same way.
 *
 * Behaviour:
 * - Skips any transaction whose category_id is already non-null (no overwrite).
 * - Never creates new budget categories. If a target category name doesn't
 *   exist yet, that pattern is logged and skipped.
 * - --dry-run (default): prints the plan and counts but writes nothing.
 * - --apply: wraps category updates and rule upserts in a single DB tx.
 *
 * Run from the repo root:
 *   pnpm --filter @workspace/scripts exec tsx \
 *     ./src/recategorizeChaseApril2026.ts --dry-run
 *   pnpm --filter @workspace/scripts exec tsx \
 *     ./src/recategorizeChaseApril2026.ts --apply
 */
import { and, eq, gte, isNull, lte } from "drizzle-orm";
import {
  budgetCategoriesTable,
  db,
  upsertMappingRule,
  pool,
  transactionsTable,
} from "@workspace/db";

const USER_ID = "user_3DBrWZkCKIzrkYoLS6N9tIMcdso";
const FROM = "2026-04-01";
const TO = "2026-04-30";
const SOURCE = "plaid:chase";
const RULE_PRIORITY = 100;

type MapEntry = {
  pattern: string;            // case-insensitive `contains` substring
  matchType: "contains" | "starts_with";
  category: string | "TRANSFER";
};

// Merchant-by-merchant resolution map. `category` is the literal name in
// budget_categories for this user. Patterns are uppercase; matching is
// case-insensitive. Transfers don't get a category — just is_transfer=true.
const MAP: MapEntry[] = [
  // ---- True transfers between Brad's own accounts ----
  { pattern: "ONLINE TRANSFER TO",                matchType: "contains",    category: "TRANSFER" },
  { pattern: "ONLINE TRANSFER FROM",              matchType: "contains",    category: "TRANSFER" },
  { pattern: "ODP TRANSFER FROM SAVINGS",         matchType: "contains",    category: "TRANSFER" },
  { pattern: "APPLE GS SAVINGS TRANSFER",         matchType: "contains",    category: "TRANSFER" },
  { pattern: "Venmo",                             matchType: "starts_with", category: "TRANSFER" },
  { pattern: "PAYPAL TRANSFER",                   matchType: "starts_with", category: "TRANSFER" },
  { pattern: "PAYPAL INST XFER 1049422616723",    matchType: "contains",    category: "TRANSFER" },
  { pattern: "FID BKG SVC LLC MONEYLINE",         matchType: "contains",    category: "TRANSFER" },
  { pattern: "ATM WITHDRAWAL",                    matchType: "starts_with", category: "TRANSFER" },
  { pattern: "REMOTE ONLINE DEPOSIT",             matchType: "starts_with", category: "TRANSFER" },

  // ---- Loan / credit-card payments → debt-linked budget category ----
  { pattern: "APPLECARD GSBANK",                  matchType: "contains",    category: "Apple Card (Goldman Sachs)" },
  { pattern: "CAPITAL ONE CRCARDPMT",             matchType: "contains",    category: "Capital One Platinum" },
  { pattern: "CAPITAL ONE MOBILE PMT",            matchType: "contains",    category: "Capital One Platinum" },
  { pattern: "UPSTART NETWORK",                   matchType: "contains",    category: "Upstart Loan" },
  { pattern: "DISCOVER E-PAYMENT",                matchType: "contains",    category: "Discover" },
  { pattern: "CHASE CREDIT CRD AUTOPAY",          matchType: "contains",    category: "Chase Amazon Prime Visa" },
  { pattern: "PAYPAL INST XFER PYPL PAYMTHLY",    matchType: "contains",    category: "PayPal Credit (Brad) / Synchrony" },

  // ---- Mortgage / car / housing loans ----
  { pattern: "LAKEVIEW LN SRV",                   matchType: "contains",    category: "Mortgage (Lakeview)" },
  { pattern: "FIGURE LENDING",                    matchType: "contains",    category: "HELOC (Figure)" },
  { pattern: "TOYOTA ACH LEASE",                  matchType: "contains",    category: "Car Payments" },
  { pattern: "UW CREDIT UNION",                   matchType: "contains",    category: "Car Payments" },

  // ---- Recurring bills ----
  { pattern: "VERIZON",                           matchType: "contains",    category: "Utilities" },
  { pattern: "MADISON GAS",                       matchType: "contains",    category: "Utilities" },
  { pattern: "CITY OF MADISON",                   matchType: "contains",    category: "Utilities" },
  { pattern: "STATE FARM",                        matchType: "contains",    category: "Insurance" },
  { pattern: "TRUSTAGE",                          matchType: "contains",    category: "Insurance" },

  // ---- Income ----
  { pattern: "KFI STAFFING",                      matchType: "contains",    category: "Brad's paycheck (KFI)" },
  { pattern: "EXACT SCIENCES",                    matchType: "contains",    category: "Hannah's paycheck (Exact)" },

  // ---- Dining & coffee ----
  { pattern: "STARBUCKS",                         matchType: "contains",    category: "Dining & Coffee" },
  { pattern: "DUNKIN",                            matchType: "contains",    category: "Dining & Coffee" },
  { pattern: "DOORDASH MOOYAH",                   matchType: "contains",    category: "Dining & Coffee" },
  { pattern: "DOORDASH PHILZ",                    matchType: "contains",    category: "Dining & Coffee" },
  { pattern: "DOORDASH BIRDS",                    matchType: "contains",    category: "Dining & Coffee" },
  { pattern: "DOORDASH ORSOSR",                   matchType: "contains",    category: "Dining & Coffee" },
  { pattern: "MOOYAH",                            matchType: "contains",    category: "Dining & Coffee" },

  // ---- Groceries / general merch ----
  { pattern: "METRO MARKET",                      matchType: "contains",    category: "Groceries" },
  { pattern: "COSTCO",                            matchType: "contains",    category: "Groceries" },
  { pattern: "WALMART",                           matchType: "contains",    category: "Shopping" },
  { pattern: "ALDO",                              matchType: "contains",    category: "Shopping" },
  { pattern: "BRGHTWHL",                          matchType: "contains",    category: "Shopping" },
  { pattern: "SHEN ZHEN SHI",                     matchType: "contains",    category: "Shopping" },
  { pattern: "STITCHFIXIN",                       matchType: "contains",    category: "Shopping" },

  // ---- Gas & transportation ----
  { pattern: "KWIK TRIP",                         matchType: "contains",    category: "Gas, Maintenance & Parking" },

  // ---- Subscriptions / entertainment ----
  { pattern: "PLAYSTATION",                       matchType: "contains",    category: "Subscriptions" },
  { pattern: "NINTENDOAME",                       matchType: "contains",    category: "Subscriptions" },
  { pattern: "PARAMNTPLUS",                       matchType: "contains",    category: "Subscriptions" },
  { pattern: "ADOBE",                             matchType: "contains",    category: "Subscriptions" },
  { pattern: "ANCESTRYCOM",                       matchType: "contains",    category: "Subscriptions" },

  // ---- Misc / Buffer (catch-alls) ----
  // NOTE: DEPT EDUCATION (federal student loan ACH) and INTUIT FINANCING (QBC
  // line of credit) are intentionally NOT auto-mapped here — neither has a
  // dedicated debt-linked budget category for this user. They are surfaced
  // under the "ambiguous" section so Brad can either add a category or keep
  // routing them to Misc / Buffer manually. Persisting a high-priority
  // Misc/Buffer rule for these would silently misroute future syncs.
];

/**
 * Patterns that are intentionally NOT auto-applied because the right target
 * is ambiguous (multiple debts of the same family) or has no matching budget
 * category. Listed only for the summary so Brad can see why they're skipped.
 */
const AMBIGUOUS_PATTERNS: { pattern: string; reason: string }[] = [
  { pattern: "AMERICAN EXPRESS ACH PMT", reason: "no Amex budget category for this user" },
  { pattern: "AFFIRM.COM PAYME",         reason: "5 Affirm debts; cannot disambiguate by description" },
  { pattern: "SYNCHRONY BANK PAYMENT",   reason: "4 Synchrony debts; cannot disambiguate by description" },
  { pattern: "Credit One Bank Payment",  reason: "no Credit One budget category for this user" },
  { pattern: "Best Buy",                 reason: "Best Buy is a Plaid LOAN_PAYMENTS row but no Best Buy / Citi debt category exists for this user (only Affirm — Best Buy)" },
  { pattern: "DEPT EDUCATION",           reason: "no Student Loan budget category for this user (currently routed to Misc / Buffer by a stale low-priority rule)" },
  { pattern: "INTUIT FINANCING",         reason: "no Intuit / QBC line-of-credit budget category for this user (currently routed to Misc / Buffer by a stale low-priority rule)" },
];

function isAmbiguous(desc: string): { pattern: string; reason: string } | null {
  const hay = desc.toLowerCase();
  for (const a of AMBIGUOUS_PATTERNS) {
    if (hay.includes(a.pattern.toLowerCase())) return a;
  }
  return null;
}

function matches(desc: string, e: MapEntry): boolean {
  const hay = desc.toLowerCase();
  const needle = e.pattern.toLowerCase();
  return e.matchType === "starts_with" ? hay.startsWith(needle) : hay.includes(needle);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const apply = args.has("--apply");
  const mode = apply ? "APPLY" : "DRY-RUN";
  console.log(`\n=== Re-categorize Chase April 2026 (${mode}) ===`);
  console.log(`User:   ${USER_ID}`);
  console.log(`Window: ${FROM} .. ${TO}`);
  console.log(`Source: ${SOURCE}\n`);

  // Resolve category names → ids.
  const cats = await db
    .select()
    .from(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.userId, USER_ID));
  const byName = new Map(cats.map((c) => [c.name, c.id] as const));

  const wantedNames = Array.from(
    new Set(MAP.filter((e) => e.category !== "TRANSFER").map((e) => e.category)),
  );
  const unresolved = wantedNames.filter((n) => !byName.has(n));
  if (unresolved.length > 0) {
    console.log("⚠️  Unresolved category names (no matching budget_category):");
    for (const n of unresolved) console.log(`   - ${n}`);
    console.log("");
  }

  // Pull every Chase txn in the window. We sort newest-first to mirror the UI.
  const txns = await db
    .select()
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.userId, USER_ID),
        eq(transactionsTable.source, SOURCE),
        gte(transactionsTable.occurredOn, FROM),
        lte(transactionsTable.occurredOn, TO),
      ),
    );

  type Plan = {
    txnId: string;
    date: string;
    description: string;
    amount: string;
    matchedPattern: string;
    targetCategory: string | "TRANSFER" | null;
    targetCategoryId: string | null;
    setIsTransfer: boolean;
  };
  const planUpdate: Plan[] = [];
  const planTransferOnly: Plan[] = [];
  const skippedAlreadyMatch: { date: string; description: string; reason: string }[] = [];
  const mismatchedExistingCat: { date: string; description: string; existing: string; intended: string }[] = [];
  const skippedNoMatch: { date: string; description: string; existingCategory: string | null }[] = [];
  const skippedUnresolved: { date: string; description: string; pattern: string; want: string }[] = [];
  const skippedAmbiguous: { date: string; description: string; pattern: string; reason: string; existing: string | null }[] = [];

  const idToName = new Map(cats.map((c) => [c.id, c.name] as const));

  for (const t of txns) {
    const desc = t.description ?? "";
    const hit = MAP.find((e) => matches(desc, e)) ?? null;
    const ambiguous = hit ? null : isAmbiguous(desc);
    const existingCatName = t.categoryId ? (idToName.get(t.categoryId) ?? "(unknown)") : null;

    // 1. Ambiguous merchant — never auto-categorize, but always surface.
    if (ambiguous) {
      skippedAmbiguous.push({
        date: t.occurredOn,
        description: desc,
        pattern: ambiguous.pattern,
        reason: ambiguous.reason,
        existing: existingCatName,
      });
      continue;
    }

    if (!hit) {
      // No canonical map entry and not ambiguous — surface every row,
      // whether or not it has an existing category, so Brad can spot
      // pre-existing miscategorizations.
      skippedNoMatch.push({
        date: t.occurredOn,
        description: desc,
        existingCategory: existingCatName,
      });
      continue;
    }

    if (hit.category === "TRANSFER") {
      // Transfers: ensure is_transfer=true. Don't change categoryId — if the
      // user had assigned one, leave it alone (skip + log) and just note that
      // we'd flip the flag if it isn't set.
      if (!t.isTransfer) {
        planTransferOnly.push({
          txnId: t.id,
          date: t.occurredOn,
          description: desc,
          amount: t.amount,
          matchedPattern: hit.pattern,
          targetCategory: "TRANSFER",
          targetCategoryId: null,
          setIsTransfer: true,
        });
      }
      continue;
    }

    const targetId = byName.get(hit.category) ?? null;
    if (!targetId) {
      skippedUnresolved.push({
        date: t.occurredOn,
        description: desc,
        pattern: hit.pattern,
        want: hit.category,
      });
      continue;
    }

    if (t.categoryId !== null) {
      // Per task: do NOT overwrite an existing category. But if it differs
      // from what the canonical map says, surface the mismatch separately so
      // Brad can review (a stale auto-rule may have placed it wrong).
      if (t.categoryId !== targetId) {
        mismatchedExistingCat.push({
          date: t.occurredOn,
          description: desc,
          existing: existingCatName ?? "(unknown)",
          intended: hit.category,
        });
      } else {
        skippedAlreadyMatch.push({
          date: t.occurredOn,
          description: desc,
          reason: `already set to "${hit.category}"`,
        });
      }
      continue;
    }

    planUpdate.push({
      txnId: t.id,
      date: t.occurredOn,
      description: desc,
      amount: t.amount,
      matchedPattern: hit.pattern,
      targetCategory: hit.category,
      targetCategoryId: targetId,
      setIsTransfer: false,
    });
  }

  // Print plan
  console.log(`Found ${txns.length} Chase txns in window.`);
  console.log(`Will set categoryId on:               ${planUpdate.length}`);
  console.log(`Will set is_transfer=true on:         ${planTransferOnly.length}`);
  console.log(`Already correctly categorized:        ${skippedAlreadyMatch.length}`);
  console.log(`MISMATCH: existing != intended:       ${mismatchedExistingCat.length}`);
  console.log(`Ambiguous (manual disambiguation):    ${skippedAmbiguous.length}`);
  console.log(`Skipped (no mapping match):           ${skippedNoMatch.length}`);
  console.log(`Skipped (unresolved cat name):        ${skippedUnresolved.length}\n`);

  if (planUpdate.length > 0) {
    console.log("--- Category updates ---");
    for (const p of planUpdate) {
      console.log(
        `  ${p.date}  ${p.amount.padStart(10)}  ${p.description.slice(0, 60).padEnd(60)}  -> ${p.targetCategory}`,
      );
    }
    console.log("");
  }
  if (planTransferOnly.length > 0) {
    console.log("--- Transfer-flag updates ---");
    for (const p of planTransferOnly) {
      console.log(
        `  ${p.date}  ${p.amount.padStart(10)}  ${p.description.slice(0, 60).padEnd(60)}  -> TRANSFER`,
      );
    }
    console.log("");
  }
  if (skippedAmbiguous.length > 0) {
    console.log("--- Ambiguous (needs manual disambiguation) ---");
    for (const r of skippedAmbiguous) {
      const tag = r.existing ? `existing="${r.existing}"` : `uncategorized`;
      console.log(`  ${r.date}  ${r.description.slice(0, 70).padEnd(70)}  [${tag}]`);
    }
    console.log("");
    console.log("Ambiguous patterns (intentionally not auto-applied):");
    for (const a of AMBIGUOUS_PATTERNS) {
      console.log(`  - ${a.pattern}  (${a.reason})`);
    }
    console.log("");
  }
  if (mismatchedExistingCat.length > 0) {
    console.log("--- MISMATCH: existing category differs from canonical map (left as-is) ---");
    for (const r of mismatchedExistingCat) {
      console.log(`  ${r.date}  ${r.description.slice(0, 60).padEnd(60)}  existing="${r.existing}"  intended="${r.intended}"`);
    }
    console.log("");
  }
  if (skippedNoMatch.length > 0) {
    console.log("--- Skipped (no canonical map entry) ---");
    for (const r of skippedNoMatch) {
      const tag = r.existingCategory ? `existing="${r.existingCategory}"` : `uncategorized`;
      console.log(`  ${r.date}  ${r.description.slice(0, 70).padEnd(70)}  [${tag}]`);
    }
    console.log("");
  }
  if (skippedAlreadyMatch.length > 0) {
    console.log(`--- Already correctly categorized: ${skippedAlreadyMatch.length} rows (suppressed) ---\n`);
  }
  if (skippedUnresolved.length > 0) {
    console.log("--- Skipped (target category not found) ---");
    for (const r of skippedUnresolved) {
      console.log(`  ${r.date}  ${r.description.slice(0, 60)}  pattern=${r.pattern} want=${r.want}`);
    }
    console.log("");
  }

  // Mapping rules to upsert. We upsert one rule per pattern that resolves to
  // a real category (skips TRANSFER and unresolved entries, and skips
  // patterns that no row in the window actually matched, to avoid creating
  // dead rules).
  const matchedPatterns = new Set([
    ...planUpdate.map((p) => p.matchedPattern),
    ...planTransferOnly.map((p) => p.matchedPattern),
  ]);
  // Also include patterns that matched a row whose existing category already
  // agrees, OR disagrees but we're leaving it alone — Brad still wants the
  // rule persisted for future syncs (per task: every applied merchant
  // pattern → mapping_rules row).
  for (const r of [...skippedAlreadyMatch, ...mismatchedExistingCat]) {
    const e = MAP.find((m) => matches(r.description, m));
    if (e && e.category !== "TRANSFER") matchedPatterns.add(e.pattern);
  }
  const ruleSeeds = MAP.filter(
    (e) => e.category !== "TRANSFER" && matchedPatterns.has(e.pattern),
  ).flatMap((e) => {
    const target = byName.get(e.category as string);
    if (!target) return [];
    return [{
      pattern: e.pattern,
      matchType: e.matchType as "contains" | "starts_with" | "exact",
      categoryId: target,
    }];
  });

  console.log(`Mapping rules to upsert (priority ${RULE_PRIORITY}): ${ruleSeeds.length}`);
  for (const r of ruleSeeds) {
    console.log(`  ${r.pattern}  (${r.matchType}) -> ${r.categoryId}`);
  }
  console.log("");

  // NOTE on transfer-rule persistence: mapping_rules' matcher
  // (autoCategorize.matchRule) skips rules with a NULL categoryId, so
  // persisting "transfer-only" patterns there would be inert. Transfer
  // detection lives in autoCategorize.categorize(): Plaid's PFC
  // TRANSFER_IN/TRANSFER_OUT plus a hard-coded TRANSFER_DESC_PATTERNS list
  // covers Online Transfer / ODP / "transfer to/from savings" / internal
  // transfer. The 25 transfer rows in this Chase window were already flagged
  // by Plaid PFC, so no flag flips were needed and no future-sync gap
  // exists today. If a user-specific transfer pattern needs persistence
  // later, extend autoCategorize's pattern list rather than abusing
  // mapping_rules.

  if (!apply) {
    console.log("Dry run complete. Re-run with --apply to write changes.");
    await pool.end();
    return;
  }

  // Apply: single transaction over txn updates + mapping_rules upserts.
  let inserted = 0;
  let updated = 0;
  let noop = 0;
  await db.transaction(async (tx) => {
    for (const p of planUpdate) {
      await tx
        .update(transactionsTable)
        .set({ categoryId: p.targetCategoryId })
        .where(
          and(
            eq(transactionsTable.id, p.txnId),
            eq(transactionsTable.userId, USER_ID),
            isNull(transactionsTable.categoryId),
          ),
        );
    }
    for (const p of planTransferOnly) {
      await tx
        .update(transactionsTable)
        .set({ isTransfer: true })
        .where(
          and(
            eq(transactionsTable.id, p.txnId),
            eq(transactionsTable.userId, USER_ID),
          ),
        );
    }
    for (const r of ruleSeeds) {
      const result = await upsertMappingRule(tx, {
        userId: USER_ID,
        pattern: r.pattern,
        matchType: r.matchType,
        categoryId: r.categoryId,
        priority: RULE_PRIORITY,
      });
      if (result === "inserted") inserted++;
      else if (result === "updated") updated++;
      else noop++;
    }
  });

  console.log("✅ Applied.\n");
  console.log(`Summary:`);
  console.log(`  rows updated (category set):     ${planUpdate.length}`);
  console.log(`  rows flagged as transfers:       ${planTransferOnly.length}`);
  console.log(`  mapping rules inserted:          ${inserted}`);
  console.log(`  mapping rules updated:           ${updated}`);
  console.log(`  mapping rules unchanged:         ${noop}`);
  console.log(`  rows already correctly cat'd:    ${skippedAlreadyMatch.length}`);
  console.log(`  rows w/ MISMATCH (left as-is):   ${mismatchedExistingCat.length}`);
  console.log(`  rows ambiguous (manual needed):  ${skippedAmbiguous.length}`);
  console.log(`  rows skipped (no match):         ${skippedNoMatch.length}`);
  console.log(`  rows skipped (unresolved):       ${skippedUnresolved.length}`);

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  try { await pool.end(); } catch {}
  process.exit(1);
});
