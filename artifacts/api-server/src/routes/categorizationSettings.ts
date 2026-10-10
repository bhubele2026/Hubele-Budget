// (V1) The categorizer's settings: what files charges, how far the model may go,
// and what it has done lately.
//
//   GET /categorization/settings   any member of the household
//   PUT /categorization/settings   the household's owner only (403 owner_only)
//
// The switches live in the OWNER's `settings.preferences` (`autoCategorize`,
// `modelAutoCategorize`) — the exact keys the categorize job reads through
// `evaluateModelGate`, which this view also calls, so the screen and the job
// cannot disagree. The per-user `/me/ui-preferences` copies of those keys are
// deprecated: the server never read them.
import { Router, type IRouter, type Request } from "express";
import * as z from "zod/v4";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  budgetCategoriesTable,
  categoryDecisionsTable,
  mappingRulesTable,
  merchantMemoryTable,
  plaidAccountsTable,
  plaidItemsTable,
  recurringItemsTable,
  settingsTable,
  transactionsTable,
} from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import { isSyntheticPlaidItem } from "../lib/plaid";
import { lastBankTxOnByItem } from "../lib/bankCoverage";
import { evaluateModelGate } from "../lib/categorizer/modelGate";
import { backlogOf, openReviewCount, undoRefusal, unreviewedCount } from "../lib/categorizer/review";
import { autoUpdatesOf } from "./plaid";

const router: IRouter = Router();

/** How many recent decisions the view lists. */
export const RECENT_DECISIONS_MAX = 20;

const UpdateBody = z
  .strictObject({
    autoCategorize: z.boolean().optional(),
    modelAutoCategorize: z.boolean().optional(),
  })
  .refine((o) => o.autoCategorize !== undefined || o.modelAutoCategorize !== undefined, {
    message: "Send autoCategorize, modelAutoCategorize, or both.",
  });

const total = async (q: Promise<Array<{ n: number }>>): Promise<number> => Number((await q)[0]?.n ?? 0);

async function recentDecisions(householdId: string) {
  const rows = await db
    .select({
      id: categoryDecisionsTable.id,
      transactionId: categoryDecisionsTable.transactionId,
      source: categoryDecisionsTable.source,
      band: categoryDecisionsTable.band,
      categoryId: categoryDecisionsTable.categoryId,
      resolution: categoryDecisionsTable.resolution,
      resolvedVia: categoryDecisionsTable.resolvedVia,
      undoneAt: categoryDecisionsTable.undoneAt,
      createdAt: categoryDecisionsTable.createdAt,
      description: transactionsTable.description,
      amount: transactionsTable.amount,
      occurredOn: transactionsTable.occurredOn,
      txnCategoryId: transactionsTable.categoryId,
      locked: transactionsTable.categoryLockedByUser,
      categoryName: budgetCategoriesTable.name,
    })
    .from(categoryDecisionsTable)
    .innerJoin(
      transactionsTable,
      and(eq(transactionsTable.id, categoryDecisionsTable.transactionId), eq(transactionsTable.householdId, householdId)),
    )
    .leftJoin(
      budgetCategoriesTable,
      and(eq(budgetCategoriesTable.id, categoryDecisionsTable.categoryId), eq(budgetCategoriesTable.householdId, householdId)),
    )
    .where(eq(categoryDecisionsTable.householdId, householdId))
    .orderBy(desc(categoryDecisionsTable.createdAt), desc(categoryDecisionsTable.id))
    .limit(RECENT_DECISIONS_MAX);
  return rows.map((r) => ({
    id: r.id,
    transactionId: r.transactionId,
    description: r.description,
    amount: r.amount,
    occurredOn: r.occurredOn,
    source: r.source,
    band: r.band,
    categoryId: r.categoryId,
    categoryName: r.categoryName ?? null,
    resolution: r.resolution as "accepted" | "corrected" | "skipped" | "unreviewed" | null,
    resolvedBy: (r.resolvedVia ?? null) as "user" | "silent" | null,
    decidedAt: r.createdAt.toISOString(),
    undoable: undoRefusal(r, { categoryId: r.txnCategoryId, locked: r.locked }) === null,
  }));
}

/**
 * (V7) One row per linked bank: the same rows GET /plaid/items lists (this
 * household's items, synthetic seed rows hidden) and the same `autoUpdatesOf`.
 * Read from the tables only; no Plaid call.
 *
 * (WP3) `lastDataOn` is a DATA date — the newest bank transaction H2 holds for
 * the item, by the same rule as GET /plaid/items `lastBankTxOn`
 * (`lib/bankCoverage.ts`). It used to be the household day of the last sync,
 * which a sync that brought nothing new still moved. The sync moment is its
 * own field, `lastSyncedAt`.
 */
async function banksOf(householdId: string) {
  const items = (await db.select().from(plaidItemsTable).where(eq(plaidItemsTable.householdId, householdId))).filter(
    (it) => !isSyntheticPlaidItem(it),
  );
  const accts = await db
    .select({ accountId: plaidAccountsTable.accountId, itemId: plaidAccountsTable.itemId })
    .from(plaidAccountsTable)
    .where(eq(plaidAccountsTable.householdId, householdId));
  const lastByItem = await lastBankTxOnByItem(householdId, accts);
  return items
    .map((it) => {
      const auto = autoUpdatesOf(it);
      return {
        itemId: it.itemId,
        name: it.institutionName ?? null,
        lastDataOn: lastByItem.get(it.id) ?? null,
        lastSyncedAt: it.lastSyncedAt ? it.lastSyncedAt.toISOString() : null,
        autoUpdates: { on: auto.on, reason: auto.reason },
      };
    })
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "") || a.itemId.localeCompare(b.itemId));
}

/** ⭐ The whole view. Reads only; scoped to the household on every query. */
export async function categorizationSettingsView(householdId: string, ownerUserId: string, now: Date = new Date()) {
  const gate = await evaluateModelGate(householdId, ownerUserId, now);
  const [rules, learned, memories, recurring, recent, reviewCount, unreviewed, backlog, banks] = await Promise.all([
    // The rules the household wrote.
    total(db.select({ n: count() }).from(mappingRulesTable).where(eq(mappingRulesTable.householdId, householdId))),
    // Learned rules: every merchant_memory row GET /learned-rules lists (disabled ones too).
    total(db.select({ n: count() }).from(merchantMemoryTable).where(eq(merchantMemoryTable.householdId, householdId))),
    // Memories the engine acts on now.
    total(
      db
        .select({ n: count() })
        .from(merchantMemoryTable)
        .where(and(eq(merchantMemoryTable.householdId, householdId), isNull(merchantMemoryTable.disabledAt))),
    ),
    total(
      db
        .select({ n: count() })
        .from(recurringItemsTable)
        .where(and(eq(recurringItemsTable.householdId, householdId), eq(recurringItemsTable.active, "true"))),
    ),
    recentDecisions(householdId),
    openReviewCount(householdId),
    unreviewedCount(householdId),
    backlogOf(householdId),
    banksOf(householdId),
  ]);
  return {
    autoCategorize: gate.autoCategorize,
    modelAutoCategorize: gate.modelAutoCategorize,
    ai: { configured: gate.aiConfigured, enabled: gate.aiEnabled },
    engine: { rules, learned, memories, recurring },
    model: {
      mode: gate.mode,
      eligible: gate.eligible,
      judged: gate.judged,
      // (V7) Verified = judged: accepted or corrected by a person.
      verified: gate.judged,
      // (V7) Left unchanged 14 days: out of the queue, not verified, counted nowhere.
      unreviewed,
      requirements: gate.requirements,
      accuracy: {
        last50: { right: gate.accurateOfLast50, judged: gate.last50 },
        last20: { right: gate.accurateOfLast20, judged: gate.last20 },
      },
    },
    recent,
    reviewCount,
    backlog,
    banks,
  };
}

const isHouseholdOwner = (req: Request) =>
  !!req.householdOwnerId && (req.actualUserId ?? req.userId) === req.householdOwnerId;

router.get("/categorization/settings", requireAuth, async (req, res): Promise<void> => {
  res.json(await categorizationSettingsView(req.householdId!, req.householdOwnerId!));
});

router.put("/categorization/settings", requireAuth, async (req, res): Promise<void> => {
  if (!isHouseholdOwner(req)) {
    res.status(403).json({ error: "owner_only" });
    return;
  }
  const parsed = UpdateBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    return;
  }
  const { autoCategorize, modelAutoCategorize } = parsed.data;
  const ownerUserId = req.householdOwnerId!;
  const householdId = req.householdId!;
  // One statement: create the owner's row when missing; otherwise set exactly
  // the keys sent (jsonb_set) on the stored preferences, every other key kept.
  let preferences = sql`(CASE WHEN jsonb_typeof(${settingsTable.preferences}) = 'object' THEN ${settingsTable.preferences} ELSE '{}'::jsonb END)`;
  if (autoCategorize !== undefined) {
    preferences = sql`jsonb_set(${preferences}, '{autoCategorize}', ${JSON.stringify(autoCategorize)}::jsonb)`;
  }
  if (modelAutoCategorize !== undefined) {
    preferences = sql`jsonb_set(${preferences}, '{modelAutoCategorize}', ${JSON.stringify(modelAutoCategorize)}::jsonb)`;
  }
  await db
    .insert(settingsTable)
    .values({ userId: ownerUserId, householdId, preferences: { ...(autoCategorize !== undefined ? { autoCategorize } : {}), ...(modelAutoCategorize !== undefined ? { modelAutoCategorize } : {}) } })
    .onConflictDoUpdate({
      target: settingsTable.userId,
      set: {
        preferences,
        householdId: sql`coalesce(${settingsTable.householdId}, ${householdId}::uuid)`,
        updatedAt: new Date(),
      },
    });
  res.json(await categorizationSettingsView(householdId, ownerUserId));
});

export default router;
