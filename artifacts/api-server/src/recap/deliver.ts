import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db, recapSettingsTable } from "@workspace/db";
import { sendSms, type DeliveryKind, type SendSmsResult } from "../lib/sms/send";

// (AI-4b) The door the recap generator (a later package) calls to put a text
// on the wire for one household member. It owns the consent gates so no
// caller can bypass them: no verified number, an opted-out number, a disabled
// or paused recap, or alerts the member never asked for all stop here — and
// say why — before anything reaches sendSms().

export type DeliveryBlockReason =
  | "no_settings"
  | "not_verified"
  | "opted_out"
  | "disabled"
  | "paused"
  | "alerts_off";

export type RecapDeliveryResult =
  | (SendSmsResult & { blocked?: undefined })
  | { outcome: "blocked"; blocked: DeliveryBlockReason; deliveryId: null };

export interface RecapDeliveryInput {
  userId: string;
  householdId: string;
  kind: Exclude<DeliveryKind, "verification" | "reply">;
  body: string;
  forDate?: string | null;
  recapId?: string | null;
  /** Defaults: scheduled -> recap:<user>:<forDate>; test/alert -> unique per call. */
  idempotencyKey?: string;
}

export async function sendRecapDelivery(
  input: RecapDeliveryInput,
  now: Date = new Date(),
): Promise<RecapDeliveryResult> {
  const [s] = await db
    .select()
    .from(recapSettingsTable)
    .where(and(eq(recapSettingsTable.householdId, input.householdId), eq(recapSettingsTable.userId, input.userId)));
  if (!s) return { outcome: "blocked", blocked: "no_settings", deliveryId: null };
  if (s.optedOutAt) return { outcome: "blocked", blocked: "opted_out", deliveryId: null };
  if (!s.verifiedAt || !s.phoneE164) return { outcome: "blocked", blocked: "not_verified", deliveryId: null };
  if (input.kind !== "test") {
    if (!s.enabled) return { outcome: "blocked", blocked: "disabled", deliveryId: null };
    if (s.pausedUntil && s.pausedUntil > now) return { outcome: "blocked", blocked: "paused", deliveryId: null };
    if (input.kind === "alert" && !s.extraAlerts) return { outcome: "blocked", blocked: "alerts_off", deliveryId: null };
  }
  const idempotencyKey =
    input.idempotencyKey ??
    (input.kind === "scheduled" && input.forDate
      ? `recap:${input.userId}:${input.forDate}`
      : `${input.kind}:${input.userId}:${randomUUID()}`);
  return sendSms(
    {
      householdId: input.householdId,
      userId: input.userId,
      kind: input.kind,
      to: s.phoneE164,
      body: input.body,
      idempotencyKey,
      forDate: input.forDate ?? null,
      recapId: input.recapId ?? null,
    },
    now,
  );
}
