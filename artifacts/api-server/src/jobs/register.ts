import type { PgBoss } from "pg-boss";
import {
  PRUNE_SYNC_ATTEMPTS_CRON,
  PRUNE_SYNC_ATTEMPTS_TZ,
  handlePruneSyncAttempts,
} from "./handlers/maintenance";
import { handleSmsInbound } from "./handlers/smsInbound";
import { ALL_QUEUES, QUEUES, dlqName, queueOptions } from "./queues";

// (AI-0) Create every queue (dead-letter queue first — a queue's deadLetter
// must already exist), converge options on queues an older deploy created,
// register handlers, and upsert cron schedules. Safe to run on every boot.

export async function registerJobs(boss: PgBoss): Promise<void> {
  for (const q of ALL_QUEUES) {
    await boss.createQueue(dlqName(q));
  }
  for (const q of ALL_QUEUES) {
    const opts = queueOptions(q);
    await boss.createQueue(q, opts);
    // createQueue leaves an existing queue untouched; make it match the code.
    await boss.updateQueue(q, opts);
  }

  await boss.work(QUEUES.maintenancePruneSyncAttempts, handlePruneSyncAttempts);
  await boss.schedule(QUEUES.maintenancePruneSyncAttempts, PRUNE_SYNC_ATTEMPTS_CRON, null, {
    tz: PRUNE_SYNC_ATTEMPTS_TZ,
  });

  // (AI-4b) Inbound texts that are not STOP / START / HELP.
  await boss.work(QUEUES.smsInbound, handleSmsInbound);
}
