// Deterministic Reports facts endpoints — server-computed aggregates for the
// Reports page tabs. All numbers are computed here in code; the client renders
// them as-is.

import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/requireAuth";
import { buildSpendingFacts } from "../lib/spendingFacts";
import { buildBehaviorFacts } from "../lib/behaviorFacts";
import { buildBudgetFacts } from "../lib/budgetFacts";

const router: IRouter = Router();

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

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
