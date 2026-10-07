import type { Queue } from "pg-boss";

// (AI-0) Every queue the reinvention program will use, named once. Later
// packages register handlers for these; this package creates them (and their
// dead-letter queues) and only handles the maintenance prune.

export const QUEUES = {
  txnArrived: "txn.arrived",
  categorizeBatch: "categorize.batch",
  monitorHousehold: "monitor.household",
  recapTick: "recap.tick",
  recapGenerate: "recap.generate",
  recapSend: "recap.send",
  receiptExtract: "receipt.extract",
  smsInbound: "sms.inbound",
  metricsSnapshot: "metrics.snapshot",
  maintenancePruneSyncAttempts: "maintenance.prune-sync-attempts",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const ALL_QUEUES: readonly QueueName[] = Object.values(QUEUES);

export const DLQ_SUFFIX = ".dlq";

export function dlqName(queue: QueueName): string {
  return `${queue}${DLQ_SUFFIX}`;
}

/**
 * Shared options for every work queue: a job may run 5 minutes, is retried 3
 * times with exponential backoff, then lands in `<queue>.dlq`. Handlers must
 * be idempotent (keyed on DB rows), because a retry re-runs them.
 */
export const SHARED_QUEUE_OPTIONS = {
  expireInSeconds: 300,
  retryLimit: 3,
  retryBackoff: true,
} as const;

export function queueOptions(queue: QueueName): Omit<Queue, "name"> {
  return { ...SHARED_QUEUE_OPTIONS, deadLetter: dlqName(queue) };
}
