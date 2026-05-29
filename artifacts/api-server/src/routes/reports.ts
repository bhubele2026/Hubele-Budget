// (Play B) Per-tab Claude narrative for the Reports page.
//
// Mirrors the Avalanche advisor endpoint (forecast.ts
// /forecast/avalanche-schedule): build deterministic facts, hash the
// narration-relevant inputs, return the cached summary when the hash is
// unchanged, otherwise regenerate + cache. `?refresh=true` forces a new
// Anthropic call. The cache lives on forecast_settings, keyed per tab.

import { Router, type IRouter } from "express";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, forecastSettingsTable, type ReportsAdvisorTab } from "@workspace/db";
import { requireAuth } from "../middlewares/requireAuth";
import {
  buildTabFacts,
  generateReportsTabSummary,
  type ReportsTabParams,
} from "../lib/reportsAdvisorSummary";
import { buildSpendingFacts } from "../lib/spendingFacts";
import { buildBehaviorFacts } from "../lib/behaviorFacts";
import { buildBudgetFacts } from "../lib/budgetFacts";

const router: IRouter = Router();

const VALID_TABS: ReadonlySet<string> = new Set<ReportsAdvisorTab>([
  "debt",
  "cashflow",
  "spending",
  "budget",
  "behavior",
]);

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

router.get(
  "/reports/advisor-summary",
  requireAuth,
  async (req, res): Promise<void> => {
    const ownerUserId = req.householdOwnerId!;
    const householdId = req.householdId!;

    const tab = String(req.query.tab ?? "");
    if (!VALID_TABS.has(tab)) {
      res.status(400).json({
        error: "invalid tab (expected debt|cashflow|spending|budget|behavior)",
      });
      return;
    }
    const reportsTab = tab as ReportsAdvisorTab;
    const forceRefresh = req.query.refresh === "true" || req.query.refresh === "1";

    const rangeDays = Math.max(
      1,
      Math.min(366, Number(req.query.rangeDays) || 90),
    );
    const monthOffset = Math.max(0, Math.min(60, Number(req.query.monthOffset) || 0));

    const today = new Date();
    const toDate = isoDate(today);
    const from = new Date(today);
    from.setUTCDate(from.getUTCDate() - rangeDays);
    const fromDate = isoDate(from);
    const monthStart = isoDate(
      new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - monthOffset, 1)),
    );

    const params: ReportsTabParams = { fromDate, toDate, rangeDays, monthStart };

    // Deterministic facts — ground truth for the numbers + narrative.
    const facts = await buildTabFacts(reportsTab, householdId, ownerUserId, params);

    // Hash only the inputs that determine the narrative (the per-tab
    // hashInput), so identical facts reuse the cached summary.
    const factsHash = createHash("sha256")
      .update(JSON.stringify({ tab: reportsTab, h: facts.hashInput }))
      .digest("hex");

    // Ensure a settings row exists so the per-tab update lands.
    await db
      .insert(forecastSettingsTable)
      .values({ userId: ownerUserId, householdId })
      .onConflictDoNothing();

    const [settings] = await db
      .select()
      .from(forecastSettingsTable)
      .where(eq(forecastSettingsTable.userId, ownerUserId));

    const cachedSummaries = settings?.reportsAdvisorSummaries ?? {};
    const cachedHashes = settings?.reportsAdvisorFactsHashes ?? {};
    const cached = cachedSummaries[reportsTab] ?? null;
    const cachedHash = cachedHashes[reportsTab] ?? null;

    let summaryRow;
    let source: "cache" | "fresh";
    if (!forceRefresh && cached && cachedHash === factsHash) {
      summaryRow = cached;
      source = "cache";
    } else {
      summaryRow = await generateReportsTabSummary(reportsTab, facts);
      // Atomic per-tab write: jsonb_set against the CURRENT DB value (not a
      // value we read earlier) so concurrent requests for different tabs
      // cannot clobber each other's freshly written summary/hash.
      const summaryJson = JSON.stringify(summaryRow);
      await db
        .update(forecastSettingsTable)
        .set({
          reportsAdvisorSummaries: sql`jsonb_set(coalesce(${forecastSettingsTable.reportsAdvisorSummaries}, '{}'::jsonb), ${`{${reportsTab}}`}, ${summaryJson}::jsonb, true)`,
          reportsAdvisorFactsHashes: sql`jsonb_set(coalesce(${forecastSettingsTable.reportsAdvisorFactsHashes}, '{}'::jsonb), ${`{${reportsTab}}`}, ${JSON.stringify(factsHash)}::jsonb, true)`,
          updatedAt: new Date(),
        })
        .where(eq(forecastSettingsTable.userId, ownerUserId));
      source = "fresh";
    }

    res.json({
      tab: reportsTab,
      headline: summaryRow.headline,
      bullets: summaryRow.bullets,
      summarySource: summaryRow.source,
      generatedAt: summaryRow.generatedAt,
      source,
    });
  },
);

// (#850 — Spending overhaul, Phase 1) Clean merchant-centric Spending facts.
// Phase 2 will swap the Spending tab UI onto this endpoint. `from`/`to` are
// optional (defaults to the last 30 days); ranges before the tracking start
// are clamped server-side (range.floorApplied = true).
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Validate format AND that it's a real calendar date (rejects 2026-99-99).
function isValidIsoDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

router.get(
  "/reports/spending-facts",
  requireAuth,
  async (req, res): Promise<void> => {
    const householdId = req.householdId!;
    const fromRaw = typeof req.query.from === "string" ? req.query.from : undefined;
    const toRaw = typeof req.query.to === "string" ? req.query.to : undefined;

    if (fromRaw && !isValidIsoDate(fromRaw)) {
      res.status(400).json({ error: "invalid 'from' (expected YYYY-MM-DD)" });
      return;
    }
    if (toRaw && !isValidIsoDate(toRaw)) {
      res.status(400).json({ error: "invalid 'to' (expected YYYY-MM-DD)" });
      return;
    }
    if (fromRaw && toRaw && fromRaw > toRaw) {
      res.status(400).json({ error: "'from' must be on or before 'to'" });
      return;
    }

    const facts = await buildSpendingFacts(householdId, fromRaw, toRaw);
    res.json(facts);
  },
);

// (#851 — Behavior & Fun overhaul, Phase 1) Clean, personality-driven
// Behavior facts on top of the same real-spend pipeline. Phase 2 will swap
// the Behavior & Fun tab UI onto this endpoint. `from`/`to` are optional
// (defaults to the last 30 days); ranges before the tracking start are
// clamped server-side (range.floorApplied = true).
router.get(
  "/reports/behavior-facts",
  requireAuth,
  async (req, res): Promise<void> => {
    const householdId = req.householdId!;
    const fromRaw = typeof req.query.from === "string" ? req.query.from : undefined;
    const toRaw = typeof req.query.to === "string" ? req.query.to : undefined;

    if (fromRaw && !isValidIsoDate(fromRaw)) {
      res.status(400).json({ error: "invalid 'from' (expected YYYY-MM-DD)" });
      return;
    }
    if (toRaw && !isValidIsoDate(toRaw)) {
      res.status(400).json({ error: "invalid 'to' (expected YYYY-MM-DD)" });
      return;
    }
    if (fromRaw && toRaw && fromRaw > toRaw) {
      res.status(400).json({ error: "'from' must be on or before 'to'" });
      return;
    }

    const facts = await buildBehaviorFacts(householdId, fromRaw, toRaw);
    res.json(facts);
  },
);

// (#854 — Budget overhaul, Phase 1) Class-aware Budget facts. Phase 2 will
// swap the Budget tab UI onto this endpoint. `monthStart` is optional
// (defaults to the current month's first day); it is clamped to the same
// 2026-04-01 hard floor as `GET /budget/months`. `monthsBack` controls the
// streak-board window (default 6, clamped 1..12).
const BUDGET_FACTS_FLOOR = "2026-04-01";

router.get(
  "/reports/budget-facts",
  requireAuth,
  async (req, res): Promise<void> => {
    const householdId = req.householdId!;

    const monthStartRaw =
      typeof req.query.monthStart === "string"
        ? req.query.monthStart
        : undefined;
    if (monthStartRaw && !isValidIsoDate(monthStartRaw)) {
      res
        .status(400)
        .json({ error: "invalid 'monthStart' (expected YYYY-MM-DD)" });
      return;
    }

    const today = new Date();
    const defaultMonthStart = isoDate(
      new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)),
    );
    // Normalize any supplied date to the first of its month so a mid-month
    // value (e.g. 2026-05-15) does not produce partial month results.
    let monthStart = monthStartRaw
      ? `${monthStartRaw.slice(0, 7)}-01`
      : defaultMonthStart;
    if (monthStart < BUDGET_FACTS_FLOOR) monthStart = BUDGET_FACTS_FLOOR;

    const monthsBack = Math.max(
      1,
      Math.min(12, Number(req.query.monthsBack) || 6),
    );

    const facts = await buildBudgetFacts(householdId, monthStart, monthsBack);
    res.json(facts);
  },
);

export default router;
