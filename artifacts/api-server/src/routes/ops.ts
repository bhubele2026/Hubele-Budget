import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { GetOpsJobsResponse, RetryOpsJobResponse } from "@workspace/api-zod";
import { requireOwner } from "../middlewares/requireOwner";
import { getBoss, getJobsMode, getPgBossSchema } from "../jobs/boss";

// (AI-0) Owner-only job operations. Reads go straight to the pg-boss tables
// (so this answers even on an instance with JOBS_MODE=off); a retry needs the
// running pg-boss instance. Error text is cut to the message — no stacks.

const router: IRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAILURES_LIMIT = 50;
const ERROR_MAX_CHARS = 500;

async function jobTableExists(schema: string): Promise<boolean> {
  const r = await pool.query<{ t: string | null }>("select to_regclass($1) as t", [`${schema}.job`]);
  return !!r.rows[0]?.t;
}

function errorText(output: unknown): string | null {
  if (output == null) return null;
  let msg: unknown = output;
  if (typeof output === "object") {
    const o = output as Record<string, unknown>;
    msg = o.message ?? o.value ?? JSON.stringify(output);
  }
  const s = String(msg);
  return s.length > ERROR_MAX_CHARS ? `${s.slice(0, ERROR_MAX_CHARS)}…` : s;
}

router.get("/ops/jobs", ...requireOwner, async (_req, res, next) => {
  try {
    const schema = getPgBossSchema();
    const base = { mode: getJobsMode(), started: getBoss() !== null, schema };
    if (!(await jobTableExists(schema))) {
      res.json(GetOpsJobsResponse.parse({ ...base, counts: [], failures: [] }));
      return;
    }
    const counts = await pool.query<{ queue: string; state: string; count: string }>(
      `select name as queue, state::text as state, count(*) as count
         from "${schema}".job
        group by name, state
        order by name, state`,
    );
    const failures = await pool.query<{
      id: string;
      queue: string;
      output: unknown;
      retry_count: number;
      created_on: Date;
      started_on: Date | null;
      completed_on: Date | null;
    }>(
      `select id, name as queue, output, retry_count, created_on, started_on, completed_on
         from "${schema}".job
        where state = 'failed'
        order by completed_on desc nulls last, created_on desc
        limit ${FAILURES_LIMIT}`,
    );
    res.json(
      GetOpsJobsResponse.parse({
        ...base,
        counts: counts.rows.map((r) => ({ queue: r.queue, state: r.state, count: Number(r.count) })),
        failures: failures.rows.map((r) => ({
          id: r.id,
          queue: r.queue,
          error: errorText(r.output),
          retryCount: r.retry_count,
          createdOn: r.created_on,
          startedOn: r.started_on,
          completedOn: r.completed_on,
        })),
      }),
    );
  } catch (err) {
    next(err);
  }
});

router.post("/ops/jobs/:id/retry", ...requireOwner, async (req, res, next) => {
  try {
    const id = String(req.params.id ?? "");
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "Not a job id" });
      return;
    }
    const schema = getPgBossSchema();
    if (!(await jobTableExists(schema))) {
      res.status(404).json({ error: "No such job" });
      return;
    }
    const found = await pool.query<{ queue: string; state: string }>(
      `select name as queue, state::text as state from "${schema}".job where id = $1 limit 1`,
      [id],
    );
    const job = found.rows[0];
    if (!job) {
      res.status(404).json({ error: "No such job" });
      return;
    }
    if (job.state !== "failed") {
      res.status(409).json({ error: `Job is ${job.state}, not failed` });
      return;
    }
    const boss = getBoss();
    if (!boss) {
      res.status(503).json({ error: "Jobs are not running on this instance" });
      return;
    }
    // pg-boss 12 types CommandResponse as `{}`; at runtime it carries
    // { jobs, requested, affected }.
    const result = (await boss.retry(job.queue, id)) as { affected?: number };
    res.json(
      RetryOpsJobResponse.parse({ id, queue: job.queue, retried: (result.affected ?? 0) > 0 }),
    );
  } catch (err) {
    next(err);
  }
});

export default router;
