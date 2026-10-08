import type { Job } from "pg-boss";
import { and, eq } from "drizzle-orm";
import { db, recapDeliveriesTable, recapsTable } from "@workspace/db";
import { logger } from "../../lib/logger";
import { generateRecap } from "../../recap/generate";
import { sendRecapDelivery } from "../../recap/deliver";
import type { RecapJobData } from "./recapTick";

// (AI-4a) `recap.generate` and `recap.send`.
//
// generate: build the facts, draft, store ONE recaps row for (member, day).
//           Idempotent: an existing row is returned untouched.
// send:     hand the stored text to sendRecapDelivery (kind "scheduled", with
//           the recap id) exactly once. sendSms inserts the delivery row first
//           and the partial unique index on (user, date) makes a second send
//           impossible; a delivered recap is never sent again.
//
// Neither handler throws for a business outcome (blocked, capped, failed): the
// recap row records it and the tick decides about a retry (attempts < 3, 60 s
// apart). A thrown error is a real fault, and pg-boss retries it.

export async function handleRecapGenerate(jobs: Job<RecapJobData>[]): Promise<{ generated: number }> {
  let generated = 0;
  for (const job of jobs) {
    const { householdId, userId, forDate } = job.data;
    const out = await generateRecap(householdId, userId, forDate, { trigger: "schedule", jobId: job.id });
    if (!out.preview && out.created) generated++;
  }
  return { generated };
}

export type SendRecapOutcome =
  | "sent"
  | "already_sent"
  | "missing"
  | "not_sendable"
  | "blocked"
  | "capped"
  | "failed"
  | "duplicate";

export async function sendScheduledRecap(data: RecapJobData, now: Date = new Date()): Promise<SendRecapOutcome> {
  const [recap] = await db
    .select()
    .from(recapsTable)
    .where(and(eq(recapsTable.userId, data.userId), eq(recapsTable.forDate, data.forDate)));
  if (!recap || recap.householdId !== data.householdId) return "missing";
  if (recap.status === "sent") return "already_sent";
  if (recap.status === "skipped") return "not_sendable";

  const result = await sendRecapDelivery(
    {
      userId: recap.userId,
      householdId: recap.householdId,
      kind: "scheduled",
      body: recap.text,
      forDate: data.forDate,
      recapId: recap.id,
    },
    now,
  );

  const mark = async (status: "sent" | "failed" | "skipped") => {
    await db.update(recapsTable).set({ status }).where(eq(recapsTable.id, recap.id));
  };
  switch (result.outcome) {
    case "sent":
      await mark("sent");
      return "sent";
    case "blocked":
      await mark("skipped");
      return "blocked";
    case "capped":
      await mark("failed");
      return "capped";
    case "failed":
      await mark("failed");
      return "failed";
    case "duplicate": {
      // The slot is taken: if that text went out, the recap is sent.
      const [d] = await db
        .select({ status: recapDeliveriesTable.status })
        .from(recapDeliveriesTable)
        .where(
          and(
            eq(recapDeliveriesTable.userId, recap.userId),
            eq(recapDeliveriesTable.forDate, data.forDate),
            eq(recapDeliveriesTable.kind, "scheduled"),
          ),
        );
      if (d && (d.status === "sent" || d.status === "delivered" || d.status === "undelivered")) await mark("sent");
      return "duplicate";
    }
  }
}

export async function handleRecapSend(jobs: Job<RecapJobData>[]): Promise<{ sent: number }> {
  let sent = 0;
  for (const job of jobs) {
    const outcome = await sendScheduledRecap(job.data);
    if (outcome === "sent") sent++;
    logger.info({ recap: { outcome } }, "recap send");
  }
  return { sent };
}
