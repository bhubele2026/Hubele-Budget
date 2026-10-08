import { Router, type IRouter, type Response } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  db,
  agentActionsTable,
  agentFindingsTable,
  agentRunsTable,
  type AgentAction,
  type AgentFinding,
  type AgentRun,
} from "@workspace/db";
import {
  DismissAgentFindingParams,
  ListAgentActionsQueryParams,
  ListAgentFindingsQueryParams,
  ListAgentRunsQueryParams,
  ResolveAgentFindingParams,
  UndoAgentActionParams,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { runMonitor } from "../monitor/run";

// (AI-3) The agent's trail, household-scoped: findings (what the monitor
// noticed), runs, and the Activity list of actions. Read-mostly; the only
// writes are dismiss / resolve on a finding and the owner's "run it now".
// A row from another household is a 404, never a 403: its existence is not
// confirmed.

const router: IRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function findingView(f: AgentFinding) {
  return {
    id: f.id,
    kind: f.kind,
    severity: f.severity,
    confidence: f.confidence,
    payload: f.payload as Record<string, unknown>,
    firstSeen: f.firstSeen.toISOString(),
    lastSeen: f.lastSeen.toISOString(),
    resolvedAt: iso(f.resolvedAt),
    dismissedAt: iso(f.dismissedAt),
  };
}

function runView(r: AgentRun) {
  return {
    id: r.id,
    kind: r.kind,
    trigger: r.trigger,
    status: r.status,
    startedAt: r.startedAt.toISOString(),
    finishedAt: iso(r.finishedAt),
    summary: r.summary,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    costUsd: r.costUsd === null ? null : Number(r.costUsd),
  };
}

function actionView(a: AgentAction) {
  return {
    id: a.id,
    runId: a.runId,
    type: a.type,
    targetKind: a.targetKind,
    targetId: a.targetId,
    outcome: a.outcome,
    reversible: a.reversible,
    undoneAt: iso(a.undoneAt),
    createdAt: a.createdAt.toISOString(),
  };
}

function notFound(res: Response): void {
  res.status(404).json({ error: "Not found" });
}

router.get("/agent/findings", requireAuth, async (req, res): Promise<void> => {
  const q = ListAgentFindingsQueryParams.safeParse(req.query);
  if (!q.success) {
    res.status(400).json({ error: q.error.message });
    return;
  }
  const status = q.data.status ?? "open";
  const limit = q.data.limit ?? 20;
  const scope = eq(agentFindingsTable.householdId, req.householdId!);
  const rows = await db
    .select()
    .from(agentFindingsTable)
    .where(
      status === "open"
        ? and(scope, isNull(agentFindingsTable.resolvedAt), isNull(agentFindingsTable.dismissedAt))
        : scope,
    )
    .orderBy(desc(agentFindingsTable.lastSeen), desc(agentFindingsTable.firstSeen))
    .limit(limit);
  res.json({ findings: rows.map(findingView) });
});

for (const [action, Params, column] of [
  ["dismiss", DismissAgentFindingParams, "dismissedAt"],
  ["resolve", ResolveAgentFindingParams, "resolvedAt"],
] as const) {
  router.post(`/agent/findings/:id/${action}`, requireAuth, async (req, res): Promise<void> => {
    const params = Params.safeParse(req.params);
    if (!params.success || !UUID_RE.test(params.data.id)) {
      notFound(res);
      return;
    }
    const [row] = await db
      .update(agentFindingsTable)
      .set({ [column]: new Date() })
      .where(and(eq(agentFindingsTable.id, params.data.id), eq(agentFindingsTable.householdId, req.householdId!)))
      .returning();
    if (!row) {
      notFound(res);
      return;
    }
    res.json(findingView(row));
  });
}

router.post("/agent/monitor/run", requireAuth, async (req, res): Promise<void> => {
  if (!req.actualUserId || req.actualUserId !== req.householdOwnerId) {
    res.status(403).json({ error: "Only the household owner runs the monitor" });
    return;
  }
  const r = await runMonitor(req.householdId!, { trigger: "user", ownerUserId: req.householdOwnerId! });
  res.json({
    runId: r.runId,
    status: r.status,
    detected: r.detected,
    created: r.created,
    autoResolved: r.autoResolved,
    summary: r.summary,
  });
});

router.get("/agent/runs", requireAuth, async (req, res): Promise<void> => {
  const q = ListAgentRunsQueryParams.safeParse(req.query);
  if (!q.success) {
    res.status(400).json({ error: q.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(agentRunsTable)
    .where(eq(agentRunsTable.householdId, req.householdId!))
    .orderBy(desc(agentRunsTable.startedAt))
    .limit(q.data.limit ?? 20);
  res.json({ runs: rows.map(runView) });
});

router.get("/agent/actions", requireAuth, async (req, res): Promise<void> => {
  const q = ListAgentActionsQueryParams.safeParse(req.query);
  if (!q.success) {
    res.status(400).json({ error: q.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(agentActionsTable)
    .where(eq(agentActionsTable.householdId, req.householdId!))
    .orderBy(desc(agentActionsTable.createdAt), desc(agentActionsTable.id))
    .limit(q.data.limit ?? 30);
  res.json({ actions: rows.map(actionView) });
});

router.post("/agent/actions/:id/undo", requireAuth, async (req, res): Promise<void> => {
  const params = UndoAgentActionParams.safeParse(req.params);
  if (!params.success || !UUID_RE.test(params.data.id)) {
    notFound(res);
    return;
  }
  const [row] = await db
    .select()
    .from(agentActionsTable)
    .where(and(eq(agentActionsTable.id, params.data.id), eq(agentActionsTable.householdId, req.householdId!)));
  if (!row) {
    notFound(res);
    return;
  }
  if (!row.reversible || row.undoneAt) {
    res.status(409).json({ error: row.undoneAt ? "Already undone" : "This action cannot be undone" });
    return;
  }
  // A reversible type (set_category) arrives with the categorizer, which
  // brings its own undo; until then nothing is reversible and this is
  // unreachable in production.
  res.status(501).json({ error: "Undo for this action type has not shipped yet" });
});

export default router;
