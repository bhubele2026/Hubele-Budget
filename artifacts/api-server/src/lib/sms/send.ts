import { and, eq, gte, ne, sql } from "drizzle-orm";
import { db, recapDeliveriesTable } from "@workspace/db";
import { logger } from "../logger";
import { getDailySendCap, getSmsProvider, getStatusCallbackUrl } from "./index";
import { phoneRef, scrubError } from "./phone";

// (AI-4b) The one door every outbound text goes through.
//
//  1. The delivery row is inserted FIRST (status queued). recap_deliveries'
//     unique idempotency_key is the dedupe: a second call with the same key
//     never reaches the provider, whatever the first call's fate. (Only a row
//     that FAILED may be claimed again, up to MAX_ATTEMPTS — a failed row
//     means the provider refused it, so nothing went out.)
//  2. The global daily cap (SMS_DAILY_SEND_CAP, default 50, per UTC day,
//     counting every non-failed row) is checked after the row exists, so two
//     concurrent sends cannot both squeeze under it. Compliance replies
//     (kind "reply": STOP/START/HELP answers) are never capped.
//  3. The provider is called; the row records the provider message id or the
//     error. A thrown provider error is stored scrubbed of phone numbers and
//     never rethrown: callers get an outcome.

export type DeliveryKind = "scheduled" | "test" | "verification" | "alert" | "reply";
export type SendOutcome = "sent" | "duplicate" | "capped" | "failed";

export interface SendSmsInput {
  householdId: string;
  userId: string;
  kind: DeliveryKind;
  to: string;
  body: string;
  idempotencyKey: string;
  forDate?: string | null;
  recapId?: string | null;
}

export interface SendSmsResult {
  outcome: SendOutcome;
  deliveryId: string | null;
  error?: string;
}

export const MAX_ATTEMPTS = 3;

function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export async function sendSms(input: SendSmsInput, now: Date = new Date()): Promise<SendSmsResult> {
  const provider = getSmsProvider();

  let [row] = await db
    .insert(recapDeliveriesTable)
    .values({
      householdId: input.householdId,
      userId: input.userId,
      recapId: input.recapId ?? null,
      forDate: input.forDate ?? null,
      kind: input.kind,
      toE164: input.to,
      provider: provider.name,
      status: "queued",
      idempotencyKey: input.idempotencyKey,
    })
    .onConflictDoNothing()
    .returning();

  if (!row) {
    const [existing] = await db
      .select()
      .from(recapDeliveriesTable)
      .where(eq(recapDeliveriesTable.idempotencyKey, input.idempotencyKey));
    // No row under this key: the (user, date) scheduled slot is already taken.
    if (!existing) return { outcome: "duplicate", deliveryId: null };
    if (existing.status !== "failed" || existing.attempts >= MAX_ATTEMPTS) {
      return { outcome: "duplicate", deliveryId: existing.id };
    }
    [row] = await db
      .update(recapDeliveriesTable)
      .set({ status: "queued", provider: provider.name, updatedAt: new Date() })
      .where(and(eq(recapDeliveriesTable.id, existing.id), eq(recapDeliveriesTable.status, "failed")))
      .returning();
    if (!row) return { outcome: "duplicate", deliveryId: existing.id };
  }

  if (input.kind !== "reply") {
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(recapDeliveriesTable)
      .where(
        and(gte(recapDeliveriesTable.createdAt, utcDayStart(now)), ne(recapDeliveriesTable.status, "failed")),
      );
    if (n > getDailySendCap()) {
      await db
        .update(recapDeliveriesTable)
        .set({ status: "failed", lastError: "daily_cap", updatedAt: new Date() })
        .where(eq(recapDeliveriesTable.id, row.id));
      logger.warn({ kind: input.kind, cap: getDailySendCap() }, "sms blocked by the daily send cap");
      return { outcome: "capped", deliveryId: row.id, error: "daily_cap" };
    }
  }

  try {
    const statusCallbackUrl = provider.name === "twilio" ? getStatusCallbackUrl() : null;
    const { providerId } = await provider.send({
      to: input.to,
      body: input.body,
      idempotencyKey: input.idempotencyKey,
      ...(statusCallbackUrl ? { statusCallbackUrl } : {}),
    });
    // Guarded on "queued": a status callback that already advanced the row wins.
    await db
      .update(recapDeliveriesTable)
      .set({
        status: "sent",
        providerMessageId: providerId,
        attempts: sql`${recapDeliveriesTable.attempts} + 1`,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(and(eq(recapDeliveriesTable.id, row.id), eq(recapDeliveriesTable.status, "queued")));
    return { outcome: "sent", deliveryId: row.id };
  } catch (err) {
    const message = scrubError(err instanceof Error ? err.message : String(err));
    await db
      .update(recapDeliveriesTable)
      .set({
        status: "failed",
        attempts: sql`${recapDeliveriesTable.attempts} + 1`,
        lastError: message,
        updatedAt: new Date(),
      })
      .where(eq(recapDeliveriesTable.id, row.id));
    logger.error({ kind: input.kind, provider: provider.name, toRef: phoneRef(input.to), error: message }, "sms send failed");
    return { outcome: "failed", deliveryId: row.id, error: message };
  }
}
