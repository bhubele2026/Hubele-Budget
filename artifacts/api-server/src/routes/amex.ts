import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, settingsTable } from "@workspace/db";
import { GetAmexSummaryQueryParams } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { computeWeeklyPayoff } from "../lib/amexAnchor";
import { resolveAmexAnchor } from "../lib/amexAnchorRead";
import { AmexSummaryError, buildAmexSummary } from "../lib/amexSummary";

const router: IRouter = Router();

/**
 * Resolved Amex ending balance for the household — see `resolveAmexAnchor`
 * (lib/amexAnchorRead.ts) for the resolution order. (S5) The handler only reads
 * the request and sends the answer; the logic moved verbatim into the lib, so
 * `GET /amex/summary`'s `owed` is the same call.
 *
 * (#748) Optional `?accountId=<external Plaid account_id>` scopes resolution to
 * a single physical card (WP8b: any credit card of the household).
 */
router.get("/amex/anchor", requireAuth, async (req, res): Promise<void> => {
  const scopedAccountIdRaw = req.query.accountId;
  const scopedAccountId =
    typeof scopedAccountIdRaw === "string" && scopedAccountIdRaw.length > 0
      ? scopedAccountIdRaw
      : null;
  res.json(await resolveAmexAnchor(req.householdId!, req.householdOwnerId!, scopedAccountId));
});

/**
 * Persist a user-provided actual Amex balance to
 * `settings.preferences.amexAnchor`. The Amex page exposes this when the
 * computed/transaction-derived ending balance is the only thing available
 * (no linked debt row, no prior anchor) so the user can pin reality and
 * have the chip switch back to "From saved anchor".
 *
 * Body: { balance: number, asOf?: string (ISO) }
 */
router.post("/amex/anchor", requireAuth, async (req, res): Promise<void> => {
  const ownerId = req.householdOwnerId!;
  const householdId = req.householdId!;
  const body = (req.body ?? {}) as { balance?: unknown; asOf?: unknown };
  const balanceNum = Number(body.balance);
  if (!Number.isFinite(balanceNum)) {
    res.status(400).json({ error: "balance must be a finite number" });
    return;
  }
  let asOf: string;
  if (typeof body.asOf === "string" && body.asOf) {
    // A bare YYYY-MM-DD is a day. Parsed as-is it is UTC midnight, 7pm the evening
    // before in Chicago, so that day's rows would count after the anchor on top of
    // a balance that already holds them. Noon UTC keeps it an instant on the same
    // household day all year.
    const bareDay = /^\d{4}-\d{2}-\d{2}$/.test(body.asOf);
    const d = bareDay
      ? new Date(`${body.asOf}T12:00:00.000Z`)
      : new Date(body.asOf);
    // A bare day must also exist: V8 rolls 2026-02-30 over to Mar 2 rather than
    // failing, so check that the day survives the round trip.
    if (
      Number.isNaN(d.getTime()) ||
      (bareDay && d.toISOString().slice(0, 10) !== body.asOf)
    ) {
      res.status(400).json({ error: "asOf must be a valid ISO date string" });
      return;
    }
    asOf = d.toISOString();
  } else {
    asOf = new Date().toISOString();
  }

  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ preferences: settingsTable.preferences })
      .from(settingsTable)
      .where(eq(settingsTable.userId, ownerId));
    const prevPrefs =
      (existing?.preferences as Record<string, unknown> | null | undefined) ??
      {};
    const nextPrefs = {
      ...prevPrefs,
      amexAnchor: { balance: balanceNum, asOf },
    };
    if (existing) {
      await tx
        .update(settingsTable)
        .set({ preferences: nextPrefs, updatedAt: new Date() })
        .where(eq(settingsTable.userId, ownerId));
    } else {
      await tx
        .insert(settingsTable)
        .values({ userId: ownerId, householdId, preferences: nextPrefs })
        .onConflictDoUpdate({
          target: settingsTable.userId,
          set: { preferences: nextPrefs, updatedAt: new Date() },
        });
    }
  });

  res.json({
    amexEndingBalance: balanceNum,
    asOf,
    source: "anchor" as const,
  });
});

/**
 * Clear a previously persisted Amex anchor at
 * `settings.preferences.amexAnchor`. Lets the user remove the saved value so
 * the Amex page falls back to the linked debt row, the computed running sum,
 * or the missing state — whichever resolves next via GET /amex/anchor.
 */
router.delete("/amex/anchor", requireAuth, async (req, res): Promise<void> => {
  const ownerId = req.householdOwnerId!;
  await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ preferences: settingsTable.preferences })
      .from(settingsTable)
      .where(eq(settingsTable.userId, ownerId));
    if (!existing) return;
    const prevPrefs =
      (existing.preferences as Record<string, unknown> | null | undefined) ??
      {};
    if (!("amexAnchor" in prevPrefs)) return;
    const nextPrefs = { ...prevPrefs };
    delete (nextPrefs as Record<string, unknown>).amexAnchor;
    await tx
      .update(settingsTable)
      .set({ preferences: nextPrefs, updatedAt: new Date() })
      .where(eq(settingsTable.userId, ownerId));
  });
  res.json({ ok: true });
});

/**
 * (#weekly-payoff) Per-card weekly payoff — what to pay, per physical Amex
 * card (Blue/Silver/Gold), for one Sun–Sat week. Read-only, fully
 * deterministic (all numbers computed in code).
 *
 * `?weekStart=YYYY-MM-DD` selects the week (defaults to the last fully
 * completed Sun–Sat week).
 *
 * ⭐ (WP8, owner's decision 2026-10-10) THE CARD PAGE BILLS WHAT THE HOOK BILLS:
 * every charge on the card, filed or not (`allCoverages`), less refunds. An
 * unfiled charge is still owed to the card, and the forecast's Saturday payoff
 * already counts it (`everydayHooks.ts`), so "this week's charges" here plus
 * what is left of the week IS that payoff, to the cent. Before, this page
 * counted filed charges only and read lower by every unfiled charge.
 */
router.get("/amex/weekly-payoff", requireAuth, async (req, res): Promise<void> => {
  const householdId = req.householdId!;
  const weekStartRaw = req.query.weekStart;
  const weekStart =
    typeof weekStartRaw === "string" && weekStartRaw.length > 0 ? weekStartRaw : undefined;

  const payoff = await computeWeeklyPayoff(householdId, weekStart, req.householdOwnerId, { allCoverages: true });

  res.json(payoff);
});

/**
 * ⭐ (S5) One Amex card's period — or every Amex card's — and what was not in
 * the plan: what is owed, purchases, refunds, payments and other credits apart,
 * what the card added to the household's allowances, the plan it answers to,
 * and the purchases still to resolve. All of the logic is in lib/amexSummary;
 * this handler only validates and delegates. Read-only.
 */
router.get("/amex/summary", requireAuth, async (req, res): Promise<void> => {
  const query = (req.query ?? {}) as Record<string, unknown>;
  // `zod.coerce.number()` would also take "1e1" or "0x10": rowsPerGroup is plain digits.
  const rawRows = query.rowsPerGroup;
  if (rawRows !== undefined && !(typeof rawRows === "string" && /^[0-9]{1,3}$/.test(rawRows))) {
    res.status(400).json({ error: "invalid_rows_per_group" });
    return;
  }
  // `zod.coerce.string()` reads a missing value as "undefined": the required ones must be there.
  if (["accountId", "from", "to"].some((k) => typeof query[k] !== "string")) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const q = GetAmexSummaryQueryParams.safeParse(query);
  if (!q.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  try {
    res.json(await buildAmexSummary(req.householdId!, req.householdOwnerId!, q.data));
  } catch (err) {
    if (err instanceof AmexSummaryError) {
      res.status(err.status).json({ error: err.code });
      return;
    }
    throw err;
  }
});

export default router;
