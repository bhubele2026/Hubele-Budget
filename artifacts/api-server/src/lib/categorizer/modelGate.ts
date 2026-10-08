// (AI-1, V1) How far the model may go: off, suggest, or auto.
//
// Two household switches, both in the OWNER's `settings.preferences` (written by
// PUT /categorization/settings, read here and nowhere else):
//
//   autoCategorize        default TRUE when absent. false → the model stage never
//                         runs; the deterministic stages still do.
//   modelAutoCategorize   default false. The owner lets the model's HIGH answers
//                         write a category outright (band auto) — once the
//                         household's record has earned it (`eligible`).
//
// ⭐ Eligibility v2 (V1) is a cumulative, explainable record of JUDGED model
// suggestions: a model decision (source 'model', not undone) that was accepted
// or corrected — through the review queue, by a hand filing, or silently (a
// provisional suggestion left standing for SILENT_ACCEPT_DAYS; review.ts).
//
//   1. Warm-up: at least MODEL_AUTO_MIN_JUDGED judged, lifetime (never expires).
//   2. Accuracy: among the last 50 judged (by resolved_at), accepted ÷ judged ≥
//      MODEL_AUTO_MIN_ACCEPT_RATE.
//   3. Hysteresis: once open, the record stays open while the last 20 judged
//      hold MODEL_AUTO_FLOOR_RATE; below it the floor closes it, and it reopens
//      only when (1) and (2) hold AND the last 20 are back to
//      MODEL_AUTO_MIN_ACCEPT_RATE.
//
// "Was it open?" is DERIVED, not stored: `replayGate` walks the judged record
// oldest first and applies the three rules after every judgment. The same rows
// always give the same answer, so the job and GET /categorization/settings —
// which both call `evaluateModelGate` — can never disagree, and no table holds
// a gate state that could drift from the decisions it summarises.
//
// The old rule ("50 accepted in the last 30 days") could never open for a
// household whose rules and memory file most charges: the model only sees the
// leftovers, so 50 accepted model answers inside any 30-day window may never
// happen. See docs/reviews/2026-10-08-v1-categorization.md.
import { and, asc, eq, inArray, isNull, isNotNull, lte } from "drizzle-orm";
import { db, categoryDecisionsTable, settingsTable } from "@workspace/db";
import { getAiStatus } from "../../ai/client";

/** Lifetime judged model suggestions before the model may file on its own. */
export const MODEL_AUTO_MIN_JUDGED = 30;
/** The accuracy window: the last N judged. */
export const MODEL_AUTO_ACCURACY_WINDOW = 50;
/** Of the last MODEL_AUTO_ACCURACY_WINDOW judged, at least this share must be accepted. */
export const MODEL_AUTO_MIN_ACCEPT_RATE = 0.9;
/** The floor window: the last N judged. */
export const MODEL_AUTO_FLOOR_WINDOW = 20;
/** Once open, the last MODEL_AUTO_FLOOR_WINDOW judged must hold this share, or the gate closes. */
export const MODEL_AUTO_FLOOR_RATE = 0.8;

export type ModelMode = "off" | "suggest" | "auto";

export interface GateRequirement {
  key: "ai" | "owner_switch" | "judged" | "accuracy" | "floor";
  label: string;
  met: boolean;
  current: number;
  target: number;
}

export interface GateRecord {
  judged: number;
  accurateOfLast50: number;
  last50: number;
  accurateOfLast20: number;
  last20: number;
  eligible: boolean;
  /** Closed by the floor and not yet back to 9 in 10 among the last 20. */
  heldByFloor: boolean;
}

export interface GateEvaluation extends GateRecord {
  autoCategorize: boolean;
  modelAutoCategorize: boolean;
  aiEnabled: boolean;
  aiConfigured: boolean;
  mode: ModelMode;
  requirements: GateRequirement[];
}

/** The smallest count of right answers out of `n` that meets `rate` (float-safe). */
export function neededRight(n: number, rate: number): number {
  return Math.ceil(rate * n - 1e-9);
}

function meets(right: number, n: number, rate: number): boolean {
  return n > 0 && right >= neededRight(n, rate);
}

/**
 * ⭐ Replay the judged record (oldest first; true = accepted, false = corrected)
 * and return where it stands now. Pure: the whole eligibility rule lives here.
 */
export function replayGate(record: readonly boolean[]): GateRecord {
  let open = false;
  let floorClosed = false;
  let right50 = 0;
  let right20 = 0;
  for (let i = 0; i < record.length; i += 1) {
    const ok = record[i] ? 1 : 0;
    right50 += ok;
    right20 += ok;
    if (i >= MODEL_AUTO_ACCURACY_WINDOW && record[i - MODEL_AUTO_ACCURACY_WINDOW]) right50 -= 1;
    if (i >= MODEL_AUTO_FLOOR_WINDOW && record[i - MODEL_AUTO_FLOOR_WINDOW]) right20 -= 1;
    const judged = i + 1;
    const n50 = Math.min(judged, MODEL_AUTO_ACCURACY_WINDOW);
    const n20 = Math.min(judged, MODEL_AUTO_FLOOR_WINDOW);
    const base = judged >= MODEL_AUTO_MIN_JUDGED && meets(right50, n50, MODEL_AUTO_MIN_ACCEPT_RATE);
    if (!open && base && (!floorClosed || meets(right20, n20, MODEL_AUTO_MIN_ACCEPT_RATE))) {
      open = true;
      floorClosed = false;
    }
    if (open && !meets(right20, n20, MODEL_AUTO_FLOOR_RATE)) {
      open = false;
      floorClosed = true;
    }
  }
  const judged = record.length;
  return {
    judged,
    accurateOfLast50: right50,
    last50: Math.min(judged, MODEL_AUTO_ACCURACY_WINDOW),
    accurateOfLast20: right20,
    last20: Math.min(judged, MODEL_AUTO_FLOOR_WINDOW),
    eligible: open,
    heldByFloor: !open && floorClosed,
  };
}

export function modeFor(o: { autoCategorize: boolean; modelAutoCategorize: boolean; aiEnabled: boolean; eligible: boolean }): ModelMode {
  if (!o.autoCategorize || !o.aiEnabled) return "off";
  return o.modelAutoCategorize && o.eligible ? "auto" : "suggest";
}

/** The rows the settings screen shows, in order. Plain sentences. */
export function requirementsFor(
  rec: GateRecord,
  o: { aiEnabled: boolean; autoCategorize: boolean; modelAutoCategorize: boolean },
): GateRequirement[] {
  const ownerOn = o.autoCategorize && o.modelAutoCategorize;
  const out: GateRequirement[] = [
    { key: "ai", label: "AI is turned on for this app.", met: o.aiEnabled, current: o.aiEnabled ? 1 : 0, target: 1 },
    {
      key: "owner_switch",
      label: "The owner lets sure answers file on their own.",
      met: ownerOn,
      current: ownerOn ? 1 : 0,
      target: 1,
    },
    {
      key: "judged",
      label: `At least ${MODEL_AUTO_MIN_JUDGED} suggestions judged.`,
      met: rec.judged >= MODEL_AUTO_MIN_JUDGED,
      current: rec.judged,
      target: MODEL_AUTO_MIN_JUDGED,
    },
    {
      key: "accuracy",
      label: `9 in 10 right among the last ${MODEL_AUTO_ACCURACY_WINDOW} judged.`,
      met: meets(rec.accurateOfLast50, rec.last50, MODEL_AUTO_MIN_ACCEPT_RATE),
      current: rec.accurateOfLast50,
      target: neededRight(rec.last50 || MODEL_AUTO_ACCURACY_WINDOW, MODEL_AUTO_MIN_ACCEPT_RATE),
    },
  ];
  if (rec.heldByFloor) {
    out.push({
      key: "floor",
      label: `Recent answers slipped below 8 in 10. It reopens at 9 in 10 right among the last ${MODEL_AUTO_FLOOR_WINDOW}.`,
      met: false,
      current: rec.accurateOfLast20,
      target: neededRight(MODEL_AUTO_FLOOR_WINDOW, MODEL_AUTO_MIN_ACCEPT_RATE),
    });
  }
  return out;
}

/** The two switches, from the owner's settings row. */
export async function loadCategorizationSwitches(
  householdId: string,
  ownerUserId: string,
): Promise<{ autoCategorize: boolean; modelAutoCategorize: boolean }> {
  const [s] = await db
    .select({ preferences: settingsTable.preferences })
    .from(settingsTable)
    .where(and(eq(settingsTable.userId, ownerUserId), eq(settingsTable.householdId, householdId)));
  const prefs = (s?.preferences && typeof s.preferences === "object" && !Array.isArray(s.preferences)
    ? s.preferences
    : {}) as Record<string, unknown>;
  return {
    autoCategorize: typeof prefs.autoCategorize === "boolean" ? prefs.autoCategorize : true,
    modelAutoCategorize: prefs.modelAutoCategorize === true,
  };
}

/** The judged record, oldest first (true = accepted), resolved on or before `now`. */
export async function loadJudgedRecord(householdId: string, now: Date): Promise<boolean[]> {
  const rows = await db
    .select({ resolution: categoryDecisionsTable.resolution })
    .from(categoryDecisionsTable)
    .where(
      and(
        eq(categoryDecisionsTable.householdId, householdId),
        eq(categoryDecisionsTable.source, "model"),
        isNull(categoryDecisionsTable.undoneAt),
        inArray(categoryDecisionsTable.resolution, ["accepted", "corrected"]),
        isNotNull(categoryDecisionsTable.resolvedAt),
        lte(categoryDecisionsTable.resolvedAt, now),
      ),
    )
    .orderBy(asc(categoryDecisionsTable.resolvedAt), asc(categoryDecisionsTable.id));
  return rows.map((r) => r.resolution === "accepted");
}

/**
 * ⭐ THE gate. The categorize job and GET/PUT /categorization/settings both call
 * this, so what the screen says is what the job does.
 */
export async function evaluateModelGate(
  householdId: string,
  ownerUserId: string,
  now: Date = new Date(),
): Promise<GateEvaluation> {
  const switches = await loadCategorizationSwitches(householdId, ownerUserId);
  const ai = getAiStatus();
  const rec = replayGate(await loadJudgedRecord(householdId, now));
  return {
    ...switches,
    aiEnabled: ai.enabled,
    aiConfigured: ai.configured,
    ...rec,
    mode: modeFor({ ...switches, aiEnabled: ai.enabled, eligible: rec.eligible }),
    requirements: requirementsFor(rec, { ...switches, aiEnabled: ai.enabled }),
  };
}

export interface ModelGate {
  autoCategorize: boolean;
  modelAutoCategorize: boolean;
  /** Accepted among the last 50 judged. */
  accepted: number;
  /** Corrected among the last 50 judged. */
  corrected: number;
  /** True only in mode "auto": AI on, both switches on, and the record eligible. */
  autoAllowed: boolean;
}

/** (AI-1 shape, kept) The job's view of the gate — a projection of `evaluateModelGate`. */
export async function loadModelGate(
  householdId: string,
  ownerUserId: string,
  now: Date = new Date(),
): Promise<ModelGate> {
  const g = await evaluateModelGate(householdId, ownerUserId, now);
  return {
    autoCategorize: g.autoCategorize,
    modelAutoCategorize: g.modelAutoCategorize,
    accepted: g.accurateOfLast50,
    corrected: g.last50 - g.accurateOfLast50,
    autoAllowed: g.mode === "auto",
  };
}
