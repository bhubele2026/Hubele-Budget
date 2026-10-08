import type { Job } from "pg-boss";
import { and, eq, isNotNull } from "drizzle-orm";
import { db, recapSettingsTable } from "@workspace/db";
import { recordSmsInbound } from "../../lib/sms/inbound";

// (AI-4b) `sms.inbound`: a text from a verified number that was not STOP,
// START or HELP. Two-way texting is a later package, so for now this only
// records it as "unhandled". Idempotent: the audit row is unique on the
// provider message id, so a retry changes nothing.

export interface SmsInboundJob {
  providerMessageId: string;
  fromE164: string;
  body: string;
}

export async function handleSmsInbound(jobs: Job<SmsInboundJob>[]): Promise<{ recorded: number }> {
  for (const job of jobs) {
    const { providerMessageId, fromE164, body } = job.data;
    const [match] = await db
      .select({ userId: recapSettingsTable.userId })
      .from(recapSettingsTable)
      .where(and(eq(recapSettingsTable.phoneE164, fromE164), isNotNull(recapSettingsTable.verifiedAt)))
      .limit(1);
    await recordSmsInbound({
      providerMessageId,
      fromE164,
      body,
      matchedUserId: match?.userId ?? null,
      action: "unhandled",
    });
  }
  return { recorded: jobs.length };
}
