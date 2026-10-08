// (AI-1) Two household switches decide how far the model may go.
//
//   autoCategorize        (S1's What's-new sheet; default TRUE when absent)
//                         false → the model stage never runs; the deterministic
//                         stages still do.
//   modelAutoCategorize   (default false) the owner lets the model's HIGH
//                         answers write a category outright (band auto).
//                         It only counts when the track record backs it:
//                         at least 50 model decisions a person accepted in the
//                         last 30 days, and no more than 1 in 10 of the ones
//                         they judged was corrected. Otherwise the model stays
//                         provisional (written, flagged, queued for a look).
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db, categoryDecisionsTable, settingsTable } from "@workspace/db";

export const MODEL_AUTO_MIN_ACCEPTED = 50;
export const MODEL_AUTO_WINDOW_DAYS = 30;
/** Of accepted + corrected model decisions in the window, at least this share must be accepted. */
export const MODEL_AUTO_MIN_ACCEPT_RATE = 0.9;

export interface ModelGate {
  autoCategorize: boolean;
  modelAutoCategorize: boolean;
  accepted: number;
  corrected: number;
  /** True only when the owner opted in AND the track record holds. */
  autoAllowed: boolean;
}

export function isGateOpen(accepted: number, corrected: number): boolean {
  if (accepted < MODEL_AUTO_MIN_ACCEPTED) return false;
  return accepted / (accepted + corrected) >= MODEL_AUTO_MIN_ACCEPT_RATE;
}

export async function loadModelGate(
  householdId: string,
  ownerUserId: string,
  now: Date = new Date(),
): Promise<ModelGate> {
  const [s] = await db
    .select({ preferences: settingsTable.preferences })
    .from(settingsTable)
    .where(and(eq(settingsTable.userId, ownerUserId), eq(settingsTable.householdId, householdId)));
  const prefs = (s?.preferences && typeof s.preferences === "object" ? s.preferences : {}) as Record<string, unknown>;
  const autoCategorize = typeof prefs.autoCategorize === "boolean" ? prefs.autoCategorize : true;
  const modelAutoCategorize = prefs.modelAutoCategorize === true;
  let accepted = 0;
  let corrected = 0;
  if (modelAutoCategorize) {
    const since = new Date(now.getTime() - MODEL_AUTO_WINDOW_DAYS * 86_400_000);
    const rows = await db
      .select({ resolution: categoryDecisionsTable.resolution, n: sql<number>`count(*)::int` })
      .from(categoryDecisionsTable)
      .where(
        and(
          eq(categoryDecisionsTable.householdId, householdId),
          eq(categoryDecisionsTable.source, "model"),
          isNull(categoryDecisionsTable.undoneAt),
          inArray(categoryDecisionsTable.resolution, ["accepted", "corrected"]),
          gte(categoryDecisionsTable.resolvedAt, since),
        ),
      )
      .groupBy(categoryDecisionsTable.resolution);
    for (const r of rows) {
      if (r.resolution === "accepted") accepted = r.n;
      else corrected = r.n;
    }
  }
  return {
    autoCategorize,
    modelAutoCategorize,
    accepted,
    corrected,
    autoAllowed: modelAutoCategorize && isGateOpen(accepted, corrected),
  };
}
