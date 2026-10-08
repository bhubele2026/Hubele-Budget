import type { PgBoss } from "pg-boss";
import {
  PRUNE_SYNC_ATTEMPTS_CRON,
  PRUNE_SYNC_ATTEMPTS_TZ,
  handlePruneSyncAttempts,
} from "./handlers/maintenance";
import { handleCategorizeJobs } from "./handlers/categorize";
import { METRICS_CRON, METRICS_TZ, handleMetricsSnapshot } from "./handlers/metricsSnapshot";
import { MONITOR_CRON, MONITOR_TZ, handleMonitorJobs } from "./handlers/monitor";
import { handleRecapGenerate, handleRecapSend } from "./handlers/recapJobs";
import { RECAP_TICK_CRON, RECAP_TICK_KEY, RECAP_TICK_TZ, handleRecapTick } from "./handlers/recapTick";
import { handleSmsInbound } from "./handlers/smsInbound";
import { handleTxnArrived } from "./handlers/txnArrived";
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

  // (AI-3) The proactive monitor: a worker, and one daily fan-out tick.
  await boss.work(QUEUES.monitorHousehold, handleMonitorJobs);
  await boss.schedule(QUEUES.monitorHousehold, MONITOR_CRON, { fanout: true }, { tz: MONITOR_TZ });
  // (PR-E) The nightly progress snapshot: a worker, and one 03:30 fan-out tick.
  await boss.work(QUEUES.metricsSnapshot, handleMetricsSnapshot);
  await boss.schedule(QUEUES.metricsSnapshot, METRICS_CRON, { fanout: true }, { tz: METRICS_TZ });
  // (AI-1) A sync landed rows → categorize the ambiguous ones and run the monitor.
  await boss.work(QUEUES.txnArrived, handleTxnArrived);
  await boss.work(QUEUES.categorizeBatch, handleCategorizeJobs);
  // (AI-4b) Inbound texts that are not STOP / START / HELP.
  await boss.work(QUEUES.smsInbound, handleSmsInbound);
  // (AI-4a) The morning recap: a 5-minute tick decides, two workers act.
  await boss.work(QUEUES.recapTick, handleRecapTick);
  await boss.schedule(QUEUES.recapTick, RECAP_TICK_CRON, null, { tz: RECAP_TICK_TZ, singletonKey: RECAP_TICK_KEY });
  await boss.work(QUEUES.recapGenerate, handleRecapGenerate);
  await boss.work(QUEUES.recapSend, handleRecapSend);
}
