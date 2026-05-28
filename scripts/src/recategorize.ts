/**
 * Re-categorize a user's transactions in a date window using the canonical
 * merchant→category map (`canonicalCategoryMap.ts`). Idempotent: never
 * overwrites an existing category, but flips `is_transfer=true` when the
 * canonical map flags a row as an internal transfer. Each applied merchant
 * pattern is upserted as a high-priority `mapping_rules` row so future
 * Plaid syncs auto-categorize the same way.
 *
 * Originally a one-shot Chase-April-2026 backfill; generalized so the same
 * logic can be re-run for May, June, etc. and for non-Chase sources, or
 * driven from a future "Re-run categorization" button / scheduled job.
 *
 * Behaviour:
 * - Skips any transaction whose category_id is already non-null (no overwrite).
 * - Never creates new budget categories. If a target category name doesn't
 *   exist yet, that pattern is logged and skipped.
 * - --dry-run (default): prints the plan and counts but writes nothing.
 * - --apply: wraps category updates and rule upserts in a single DB tx.
 *
 * CLI:
 *   --user=<userId>          required
 *   --source=<source>        required (e.g. plaid:chase, amex)
 *   --from=<YYYY-MM-DD>      required (inclusive)
 *   --to=<YYYY-MM-DD>        required (inclusive)
 *   --priority=<int>         optional, default 100 (mapping_rules priority)
 *   --apply                  optional, default dry-run
 *
 * Run from the repo root:
 *   pnpm --filter @workspace/scripts exec tsx ./src/recategorize.ts \
 *     --user=user_xxx --source=plaid:chase \
 *     --from=2026-05-01 --to=2026-05-31 --dry-run
 *   pnpm --filter @workspace/scripts exec tsx ./src/recategorize.ts \
 *     --user=user_xxx --source=plaid:chase \
 *     --from=2026-05-01 --to=2026-05-31 --apply
 */
import { and, eq, gte, isNull, lte } from "drizzle-orm";
import {
  budgetCategoriesTable,
  db,
  householdMembersTable,
  upsertMappingRule,
  pool,
  transactionsTable,
} from "@workspace/db";
import {
  AMBIGUOUS_PATTERNS,
  CANONICAL_CATEGORY_MAP,
  findAmbiguous,
  matchesEntry,
} from "../../artifacts/api-server/src/lib/canonicalCategoryMap";

type ParsedArgs = {
  userId: string;
  source: string;
  from: string;
  to: string;
  priority: number;
  apply: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const bools = new Set<string>();
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq >= 0) flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    else bools.add(arg.slice(2));
  }
  const required = (k: string): string => {
    const v = flags.get(k);
    if (!v) {
      console.error(`Missing required flag: --${k}=<value>`);
      printUsage();
      process.exit(2);
    }
    return v;
  };
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const from = required("from");
  const to = required("to");
  if (!dateRe.test(from) || !dateRe.test(to)) {
    console.error(`--from and --to must be YYYY-MM-DD`);
    process.exit(2);
  }
  if (from > to) {
    console.error(`--from (${from}) must be <= --to (${to})`);
    process.exit(2);
  }
  const priorityRaw = flags.get("priority");
  const priority = priorityRaw ? Number.parseInt(priorityRaw, 10) : 100;
  if (!Number.isInteger(priority)) {
    console.error(`--priority must be an integer`);
    process.exit(2);
  }
  return {
    userId: required("user"),
    source: required("source"),
    from,
    to,
    priority,
    apply: bools.has("apply"),
  };
}

function printUsage(): void {
  console.error(
    "Usage: tsx ./src/recategorize.ts --user=<id> --source=<src> " +
      "--from=YYYY-MM-DD --to=YYYY-MM-DD [--priority=100] [--apply]",
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.apply ? "APPLY" : "DRY-RUN";
  console.log(`\n=== Re-categorize transactions (${mode}) ===`);
  console.log(`User:     ${args.userId}`);
  console.log(`Window:   ${args.from} .. ${args.to}`);
  console.log(`Source:   ${args.source}`);
  console.log(`Priority: ${args.priority}\n`);

  // Resolve the user's household. `mapping_rules` is now household-scoped
  // (matching the rest of the schema), so the upsert below needs both
  // ids. Every signed-in user is a member of exactly one household.
  const member = await db
    .select({ householdId: householdMembersTable.householdId })
    .from(householdMembersTable)
    .where(eq(householdMembersTable.userId, args.userId))
    .limit(1);
  if (member.length === 0) {
    console.error(
      `No household_members row for user ${args.userId}. Aborting.`,
    );
    process.exit(1);
  }
  const householdId = member[0].householdId;
  console.log(`Household: ${householdId}\n`);

  // Resolve category names → ids.
  const cats = await db
    .select()
    .from(budgetCategoriesTable)
    .where(eq(budgetCategoriesTable.userId, args.userId));
  const byName = new Map(cats.map((c) => [c.name, c.id] as const));

  const wantedNames = Array.from(
    new Set(
      CANONICAL_CATEGORY_MAP.filter((e) => e.category !== "TRANSFER").map(
        (e) => e.category,
      ),
    ),
  );
  const unresolved = wantedNames.filter((n) => !byName.has(n));
  if (unresolved.length > 0) {
    console.log("⚠️  Unresolved category names (no matching budget_category):");
    for (const n of unresolved) console.log(`   - ${n}`);
    console.log("");
  }

  // Pull every txn in the window for the requested source.
  const txns = await db
    .select()
    .from(transactionsTable)
    .where(
      and(
        eq(transactionsTable.userId, args.userId),
        eq(transactionsTable.source, args.source),
        gte(transactionsTable.occurredOn, args.from),
        lte(transactionsTable.occurredOn, args.to),
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
    const hit = CANONICAL_CATEGORY_MAP.find((e) => matchesEntry(desc, e)) ?? null;
    const ambiguous = hit ? null : findAmbiguous(desc);
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
      // whether or not it has an existing category, so pre-existing
      // miscategorizations are visible.
      skippedNoMatch.push({
        date: t.occurredOn,
        description: desc,
        existingCategory: existingCatName,
      });
      continue;
    }

    if (hit.category === "TRANSFER") {
      // Transfers: ensure is_transfer=true. Don't change categoryId — if the
      // user had assigned one, leave it alone.
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
      // from what the canonical map says, surface the mismatch separately.
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
  console.log(`Found ${txns.length} txns in window.`);
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

  // Mapping rules to upsert. Skip TRANSFER and unresolved entries, and skip
  // patterns that no row in the window actually matched (avoids dead rules).
  const matchedPatterns = new Set([
    ...planUpdate.map((p) => p.matchedPattern),
    ...planTransferOnly.map((p) => p.matchedPattern),
  ]);
  // Also include patterns whose rows had agreeing OR disagreeing existing
  // categories — we still want the rule persisted for future syncs.
  for (const r of [...skippedAlreadyMatch, ...mismatchedExistingCat]) {
    const e = CANONICAL_CATEGORY_MAP.find((m) => matchesEntry(r.description, m));
    if (e && e.category !== "TRANSFER") matchedPatterns.add(e.pattern);
  }
  const ruleSeeds = CANONICAL_CATEGORY_MAP.filter(
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

  console.log(`Mapping rules to upsert (priority ${args.priority}): ${ruleSeeds.length}`);
  for (const r of ruleSeeds) {
    console.log(`  ${r.pattern}  (${r.matchType}) -> ${r.categoryId}`);
  }
  console.log("");

  // NOTE on transfer-rule persistence: mapping_rules' matcher
  // (autoCategorize.matchRule) skips rules with a NULL categoryId, so
  // persisting "transfer-only" patterns there would be inert. Transfer
  // detection lives in autoCategorize.categorize(): Plaid's PFC
  // TRANSFER_IN/TRANSFER_OUT plus a hard-coded TRANSFER_DESC_PATTERNS list
  // covers the common cases. If a user-specific transfer pattern needs
  // persistence later, extend autoCategorize's pattern list rather than
  // abusing mapping_rules.

  if (!args.apply) {
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
            eq(transactionsTable.userId, args.userId),
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
            eq(transactionsTable.userId, args.userId),
          ),
        );
    }
    for (const r of ruleSeeds) {
      const result = await upsertMappingRule(tx, {
        userId: args.userId,
        householdId,
        pattern: r.pattern,
        matchType: r.matchType,
        categoryId: r.categoryId,
        priority: args.priority,
      });
      if (result.status === "inserted") inserted++;
      else if (result.status === "updated") updated++;
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
