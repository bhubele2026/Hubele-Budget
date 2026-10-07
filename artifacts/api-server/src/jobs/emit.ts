import type { SendOptions } from "pg-boss";
import { logger } from "../lib/logger";
import { getBoss, getJobsMode } from "./boss";
import type { QueueName } from "./queues";

// (AI-0) Put work on a queue. Never throws into the caller: emitting is the
// last step of a money path (e.g. a Plaid sync) and must not fail it. With
// JOBS_MODE=off the call is recorded in `_emittedForTests` instead, so tests
// assert what was emitted and then call the handler directly.

export interface EmittedJob {
  queue: QueueName;
  data: object;
  opts?: SendOptions;
}

export const _emittedForTests: EmittedJob[] = [];

export async function emit(queue: QueueName, data: object, opts?: SendOptions): Promise<string | null> {
  if (getJobsMode() === "off") {
    _emittedForTests.push({ queue, data, ...(opts ? { opts } : {}) });
    return null;
  }
  const boss = getBoss();
  if (!boss) {
    logger.warn({ queue }, "emit dropped: jobs are not running");
    return null;
  }
  try {
    return await boss.send(queue, data, opts);
  } catch (err) {
    logger.error({ err, queue }, "emit failed");
    return null;
  }
}
