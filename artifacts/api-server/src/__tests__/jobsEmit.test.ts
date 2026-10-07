import { describe, it, expect, beforeEach } from "vitest";
import { emit, _emittedForTests } from "../jobs/emit";
import { getJobsMode } from "../jobs/boss";
import { QUEUES, ALL_QUEUES, dlqName, queueOptions, SHARED_QUEUE_OPTIONS } from "../jobs/queues";
import { pinEnv } from "./_helpers/aiEnv";

// (AI-0) With JOBS_MODE=off (the default under vitest) emit() records the
// job instead of sending it, so a test can assert what a code path emitted
// and call the handler itself.

pinEnv({ JOBS_MODE: undefined });

beforeEach(() => {
  _emittedForTests.length = 0;
});

describe("emit in off mode", () => {
  it("jobs are off under vitest by default", () => {
    expect(getJobsMode()).toBe("off");
  });

  it("records queue, data and options, in order, and sends nothing", async () => {
    const a = await emit(QUEUES.txnArrived, { itemId: "item-1", txnIds: ["t1", "t2"] }, { singletonKey: "item-1", singletonSeconds: 300 });
    const b = await emit(QUEUES.recapTick, {});
    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(_emittedForTests).toEqual([
      { queue: "txn.arrived", data: { itemId: "item-1", txnIds: ["t1", "t2"] }, opts: { singletonKey: "item-1", singletonSeconds: 300 } },
      { queue: "recap.tick", data: {} },
    ]);
  });

  it("JOBS_MODE=off wins even when explicitly set; on/off are the only modes", () => {
    process.env.JOBS_MODE = "off";
    expect(getJobsMode()).toBe("off");
    process.env.JOBS_MODE = "ON";
    expect(getJobsMode()).toBe("on");
    process.env.JOBS_MODE = "sometimes";
    expect(getJobsMode()).toBe("off"); // falls back to the default (vitest → off)
    delete process.env.JOBS_MODE;
  });
});

describe("queue catalogue", () => {
  it("names the ten program queues, each with retries, a 5-minute expiry and its own DLQ", () => {
    expect([...ALL_QUEUES]).toEqual([
      "txn.arrived",
      "categorize.batch",
      "monitor.household",
      "recap.tick",
      "recap.generate",
      "recap.send",
      "receipt.extract",
      "sms.inbound",
      "metrics.snapshot",
      "maintenance.prune-sync-attempts",
    ]);
    expect(SHARED_QUEUE_OPTIONS).toEqual({ expireInSeconds: 300, retryLimit: 3, retryBackoff: true });
    expect(queueOptions(QUEUES.recapSend)).toEqual({ ...SHARED_QUEUE_OPTIONS, deadLetter: "recap.send.dlq" });
    expect(dlqName(QUEUES.smsInbound)).toBe("sms.inbound.dlq");
  });
});
