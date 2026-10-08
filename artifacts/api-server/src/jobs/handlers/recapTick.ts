import type { Job } from "pg-boss";
import { and, eq, isNotNull, isNull, lt, or } from "drizzle-orm";
import { db, recapDeliveriesTable, recapSettingsTable, recapsTable } from "@workspace/db";
import { dayOfWeekISO, localDateInZone, zonedTimeToUtc } from "@workspace/avalanche-core";
import { logger } from "../../lib/logger";
import { MAX_ATTEMPTS } from "../../lib/sms/send";
import { emit } from "../emit";
import { QUEUES } from "../queues";

// (AI-4a) `recap.tick`, every 5 minutes. For each member who has turned the
// recap on (verified, not opted out, not paused) it works out the member's
// own local date and send instant, and:
//
//   now >= send - 30 min, no recap for that date   -> emit recap.generate
//   now >= send, a drafted/failed recap, nothing sent -> emit recap.send
//   a failed delivery, attempts < 3, 60 s on        -> emit recap.send again
//
// It never decides whether to text: sendRecapDelivery owns consent, and the
// partial unique index on recap_deliveries is the real once-a-day dedupe.
// A recap more than SEND_GRACE_MS late is not sent (a 7 am text at 9 pm is
// worse than none); it is marked skipped.

export const RECAP_TICK_CRON = "*/5 * * * *";
export const RECAP_TICK_TZ = "UTC";
export const RECAP_TICK_KEY = "recap-tick";
export const GENERATE_LEAD_MS = 30 * 60_000;
export const SEND_GRACE_MS = 6 * 60 * 60_000;
export const RETRY_BACKOFF_MS = 60_000;

export interface RecapJobData {
  householdId: string;
  userId: string;
  forDate: string;
}

export interface TickResult {
  considered: number;
  generate: number;
  send: number;
  skipped: number;
}

export function generateJobOptions(userId: string, forDate: string) {
  return { singletonKey: `recap-gen:${userId}:${forDate}` } as const;
}

export function sendJobOptions(userId: string, forDate: string) {
  return { singletonKey: `recap:${userId}:${forDate}` } as const;
}

export async function runRecapTick(now: Date = new Date()): Promise<TickResult> {
  const result: TickResult = { considered: 0, generate: 0, send: 0, skipped: 0 };
  const members = await db
    .select()
    .from(recapSettingsTable)
    .where(
      and(
        eq(recapSettingsTable.enabled, true),
        isNotNull(recapSettingsTable.verifiedAt),
        isNull(recapSettingsTable.optedOutAt),
        or(isNull(recapSettingsTable.pausedUntil), lt(recapSettingsTable.pausedUntil, now)),
      ),
    );

  for (const s of members) {
    result.considered++;
    let forDate: string;
    let sendAt: Date;
    try {
      forDate = localDateInZone(now, s.timezone);
      sendAt = zonedTimeToUtc(forDate, s.sendTimeLocal, s.timezone);
    } catch (err) {
      logger.warn({ err, timezone: s.timezone }, "recap tick: unusable time zone or send time; member skipped");
      result.skipped++;
      continue;
    }
    const dow = dayOfWeekISO(forDate);
    if (s.skipWeekends && (dow === 0 || dow === 6)) {
      result.skipped++;
      continue;
    }
    const nowMs = now.getTime();
    if (nowMs < sendAt.getTime() - GENERATE_LEAD_MS) continue;

    const data: RecapJobData = { householdId: s.householdId, userId: s.userId, forDate };
    const [recap] = await db
      .select()
      .from(recapsTable)
      .where(and(eq(recapsTable.userId, s.userId), eq(recapsTable.forDate, forDate)));

    if (nowMs > sendAt.getTime() + SEND_GRACE_MS) {
      // Too late to be a morning text.
      if (recap && (recap.status === "drafted" || recap.status === "failed")) {
        await db.update(recapsTable).set({ status: "skipped" }).where(eq(recapsTable.id, recap.id));
      }
      result.skipped++;
      continue;
    }

    if (!recap) {
      await emit(QUEUES.recapGenerate, data, generateJobOptions(s.userId, forDate));
      result.generate++;
      continue;
    }
    if (recap.status !== "drafted" && recap.status !== "failed") continue; // sent or skipped
    if (nowMs < sendAt.getTime()) continue;

    const [delivery] = await db
      .select()
      .from(recapDeliveriesTable)
      .where(
        and(
          eq(recapDeliveriesTable.userId, s.userId),
          eq(recapDeliveriesTable.forDate, forDate),
          eq(recapDeliveriesTable.kind, "scheduled"),
        ),
      );
    const retryable =
      delivery &&
      delivery.status === "failed" &&
      delivery.attempts < MAX_ATTEMPTS &&
      nowMs - delivery.updatedAt.getTime() >= RETRY_BACKOFF_MS;
    if (!delivery || retryable) {
      await emit(QUEUES.recapSend, data, sendJobOptions(s.userId, forDate));
      result.send++;
    }
  }
  return result;
}

/** The `recap.tick` worker. Idempotent: it only decides what to emit. */
export async function handleRecapTick(_jobs: Job<unknown>[], now: Date = new Date()): Promise<TickResult> {
  return runRecapTick(now);
}
