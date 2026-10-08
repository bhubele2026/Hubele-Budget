import { createHash } from "node:crypto";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db, recapSettingsTable, recapDeliveriesTable, smsInboundTable } from "@workspace/db";
import { emit } from "../../jobs/emit";
import { getJobsMode } from "../../jobs/boss";
import { QUEUES } from "../../jobs/queues";
import { HELP_REPLY, START_REPLY, STOP_REPLY } from "../../recap/messages";
import { logger } from "../logger";
import { phoneRef } from "./phone";
import { sendSms } from "./send";

// (AI-4b) What happens when someone texts the H2 number, and what Twilio says
// about a message we sent. Both are called by routes/sms.ts after the
// X-Twilio-Signature check passed.

export type InboundAction = "stop" | "start" | "help" | "unhandled" | "unknown_sender";

const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const START_WORDS = new Set(["START", "UNSTOP", "YES"]);

/** Whole-message keyword match, case-insensitive, ignoring surrounding spaces and trailing punctuation. */
export function classifyInbound(body: string): "stop" | "start" | "help" | "other" {
  const word = body.trim().replace(/[.!\s]+$/g, "").toUpperCase();
  if (STOP_WORDS.has(word)) return "stop";
  if (START_WORDS.has(word)) return "start";
  if (word === "HELP") return "help";
  return "other";
}

export function bodyHash(body: string): string {
  return createHash("sha256").update(body.trim().toLowerCase()).digest("hex");
}

/** Audit row for an inbound text. The body itself is kept (first 160 chars) only outside production. */
export async function recordSmsInbound(input: {
  providerMessageId: string;
  fromE164: string;
  body: string;
  matchedUserId: string | null;
  action: InboundAction;
}): Promise<void> {
  await db
    .insert(smsInboundTable)
    .values({
      providerMessageId: input.providerMessageId,
      fromE164: input.fromE164,
      bodyHash: bodyHash(input.body),
      bodyPreview: process.env.NODE_ENV !== "production" ? input.body.slice(0, 160) : null,
      matchedUserId: input.matchedUserId,
      action: input.action,
    })
    .onConflictDoNothing({ target: smsInboundTable.providerMessageId });
}

/** Verified settings rows for this number: the people a text from it can speak for. */
async function verifiedRowsFor(fromE164: string) {
  return db
    .select()
    .from(recapSettingsTable)
    .where(and(eq(recapSettingsTable.phoneE164, fromE164), isNotNull(recapSettingsTable.verifiedAt)));
}

export async function processInbound(input: {
  providerMessageId: string;
  fromE164: string;
  body: string;
}): Promise<InboundAction> {
  const { providerMessageId, fromE164, body } = input;
  const rows = await verifiedRowsFor(fromE164);
  const first = rows[0];
  if (!first) {
    logger.info({ fromRef: phoneRef(fromE164) }, "inbound sms from an unknown number dropped");
    await recordSmsInbound({ providerMessageId, fromE164, body, matchedUserId: null, action: "unknown_sender" });
    return "unknown_sender";
  }

  const kind = classifyInbound(body);
  const reply = (text: string) =>
    sendSms({
      householdId: first.householdId,
      userId: first.userId,
      kind: "reply",
      to: fromE164,
      body: text,
      idempotencyKey: `reply:${providerMessageId}`,
    });

  if (kind === "stop") {
    await db
      .update(recapSettingsTable)
      .set({ optedOutAt: sql`coalesce(${recapSettingsTable.optedOutAt}, now())`, enabled: false, updatedAt: new Date() })
      .where(and(eq(recapSettingsTable.phoneE164, fromE164), isNotNull(recapSettingsTable.verifiedAt)));
    await reply(STOP_REPLY);
    await recordSmsInbound({ providerMessageId, fromE164, body, matchedUserId: first.userId, action: "stop" });
    return "stop";
  }

  if (kind === "start") {
    const changed = await db
      .update(recapSettingsTable)
      .set({ optedOutAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(recapSettingsTable.phoneE164, fromE164),
          isNotNull(recapSettingsTable.verifiedAt),
          isNotNull(recapSettingsTable.optedOutAt),
        ),
      )
      .returning({ id: recapSettingsTable.id });
    // Answer only when something actually changed; a stray "yes" gets no chatter.
    if (changed.length > 0) await reply(START_REPLY);
    await recordSmsInbound({ providerMessageId, fromE164, body, matchedUserId: first.userId, action: "start" });
    return "start";
  }

  if (kind === "help") {
    await reply(HELP_REPLY);
    await recordSmsInbound({ providerMessageId, fromE164, body, matchedUserId: first.userId, action: "help" });
    return "help";
  }

  // Anything else from a verified number goes to the sms.inbound queue; the
  // handler records it as "unhandled" (two-way texting is a later package).
  const jobId = await emit(
    QUEUES.smsInbound,
    { providerMessageId, fromE164, body },
    { singletonKey: providerMessageId },
  );
  if (jobId === null && getJobsMode() === "on") {
    // The queue is unreachable: keep the audit trail rather than lose the text.
    await recordSmsInbound({ providerMessageId, fromE164, body, matchedUserId: first.userId, action: "unhandled" });
  }
  return "unhandled";
}

// Twilio's message states, mapped to ours. `queued`, `accepted`, `sending` and
// `scheduled` change nothing: we already wrote `queued`/`sent` ourselves.
const STATUS_MAP: Record<string, "sent" | "delivered" | "undelivered" | "failed"> = {
  sent: "sent",
  delivered: "delivered",
  undelivered: "undelivered",
  failed: "failed",
};

/** Twilio error 21610: the recipient replied STOP at the carrier — treat that as an opt-out here too. */
const CARRIER_OPT_OUT_CODE = "21610";

export async function applyStatusCallback(input: {
  providerMessageId: string;
  messageStatus: string;
  errorCode?: string;
}): Promise<void> {
  const next = STATUS_MAP[input.messageStatus.toLowerCase()];
  if (!next) return;
  // Callbacks can arrive out of order: `sent` never overwrites a later state,
  // and nothing overwrites `delivered`.
  const guard =
    next === "sent"
      ? sql`${recapDeliveriesTable.status} in ('queued', 'sent')`
      : sql`${recapDeliveriesTable.status} <> 'delivered'`;
  const updated = await db
    .update(recapDeliveriesTable)
    .set({
      status: next,
      ...(input.errorCode ? { lastError: `twilio ${input.errorCode}` } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(recapDeliveriesTable.providerMessageId, input.providerMessageId), guard))
    .returning({ userId: recapDeliveriesTable.userId, householdId: recapDeliveriesTable.householdId });

  if (input.errorCode === CARRIER_OPT_OUT_CODE && updated[0]) {
    await db
      .update(recapSettingsTable)
      .set({ optedOutAt: sql`coalesce(${recapSettingsTable.optedOutAt}, now())`, enabled: false, updatedAt: new Date() })
      .where(
        and(
          eq(recapSettingsTable.userId, updated[0].userId),
          eq(recapSettingsTable.householdId, updated[0].householdId),
          isNull(recapSettingsTable.optedOutAt),
        ),
      );
  }
}
