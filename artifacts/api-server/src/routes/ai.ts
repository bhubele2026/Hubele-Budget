import { Router, type IRouter, type Response } from "express";
import rateLimit from "express-rate-limit";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  agentConversationsTable,
  agentMessagesTable,
  agentProposalsTable,
  agentRunsTable,
  aiBudgetTable,
  aiUsageTable,
  budgetCategoriesTable,
  db,
  wishlistItemsTable,
} from "@workspace/db";
import {
  AiChatBody,
  ApproveAgentProposalParams,
  CreateWishlistItemBody,
  DeleteMemoryParams,
  GetAiConversationParams,
  ListAgentProposalsQueryParams,
  ListAiConversationsQueryParams,
  PutMemoryBody,
  PutMemoryParams,
  RejectAgentProposalParams,
  UpdateAiBudgetBody,
  UpdateWishlistItemBody,
  UpdateWishlistItemParams,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { runAgent, type AiChatEvent } from "../ai/agent/runAgent";
import { BLOCKED_STATUSES, getBudgetState, startOfUtcMonth } from "../ai/budget";
import { memoryView, listMemory, revokeMemory, upsertUserMemory, cleanKey, MEMORY_SCOPES, type MemoryScope } from "../lib/agentMemory";
import { expireProposals, isUuid, proposalView } from "../lib/proposalTargets";
import { applyProposal } from "../lib/proposalApply";
import { addWishlistItem, wishlistView, wishlistWaitDays } from "../lib/wishlist";
import { householdTodayISO } from "../lib/householdClock";
import { logger } from "../lib/logger";

// (AI-2) Ask: conversations, the chat stream, proposals, memory, the wish
// list and the AI usage screen's two endpoints. Everything is household-scoped;
// a row of another household is a 404, never a 403. The model proposes; only
// the approve route below applies a change, and only for a signed-in person.

const router: IRouter = Router();

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const actorOf = (req: { actualUserId?: string; userId?: string }): string => (req.actualUserId ?? req.userId)!;
const isOwnerReq = (req: { actualUserId?: string; householdOwnerId?: string }): boolean =>
  !!req.actualUserId && req.actualUserId === req.householdOwnerId;
const notFound = (res: Response): void => void res.status(404).json({ error: "Not found" });

// Per signed-in person, 30 a minute, on every /ai/* route. Registered after
// requireAuth so the key is the person, not the address.
const AI_RATE_LIMIT = Number(process.env.AI_RATE_LIMIT_MAX) || 30;
const aiLimiter = rateLimit({
  windowMs: 60_000,
  limit: AI_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `ai:${(req as { actualUserId?: string; userId?: string }).actualUserId ?? (req as { userId?: string }).userId ?? "anon"}`,
  message: { error: "Too many requests. Try again in a minute." },
});
const aiAuth = [requireAuth, aiLimiter];

// ── Conversations ───────────────────────────────────────────────────────────
function conversationView(c: typeof agentConversationsTable.$inferSelect) {
  return { id: c.id, title: c.title, createdAt: c.createdAt.toISOString(), lastMessageAt: c.lastMessageAt.toISOString() };
}

async function ownConversation(householdId: string, userId: string, id: string) {
  if (!isUuid(id)) return null;
  const [c] = await db
    .select()
    .from(agentConversationsTable)
    .where(and(eq(agentConversationsTable.id, id), eq(agentConversationsTable.householdId, householdId), eq(agentConversationsTable.userId, userId)));
  return c ?? null;
}

router.post("/ai/conversations", ...aiAuth, async (req, res): Promise<void> => {
  const [c] = await db
    .insert(agentConversationsTable)
    .values({ householdId: req.householdId!, userId: actorOf(req) })
    .returning();
  res.status(201).json(conversationView(c!));
});

router.get("/ai/conversations", ...aiAuth, async (req, res): Promise<void> => {
  const q = ListAiConversationsQueryParams.safeParse(req.query);
  if (!q.success) {
    res.status(400).json({ error: q.error.message });
    return;
  }
  const rows = await db
    .select()
    .from(agentConversationsTable)
    .where(and(eq(agentConversationsTable.householdId, req.householdId!), eq(agentConversationsTable.userId, actorOf(req))))
    .orderBy(desc(agentConversationsTable.lastMessageAt))
    .limit(q.data.limit ?? 20);
  res.json({ conversations: rows.map(conversationView) });
});

router.get("/ai/conversations/:id", ...aiAuth, async (req, res): Promise<void> => {
  const p = GetAiConversationParams.safeParse(req.params);
  const c = p.success ? await ownConversation(req.householdId!, actorOf(req), p.data.id) : null;
  if (!c) return notFound(res);
  const rows = await db
    .select()
    .from(agentMessagesTable)
    .where(eq(agentMessagesTable.conversationId, c.id))
    .orderBy(agentMessagesTable.createdAt, agentMessagesTable.id)
    .limit(200);
  res.json({
    conversation: conversationView(c),
    messages: rows.map((m) => ({
      id: m.id,
      role: m.role,
      // A tool message shows which tool ran; its result stays on the server.
      content: m.role === "tool" ? { name: (m.content as { name?: string }).name ?? "" } : (m.content as Record<string, unknown>),
      runId: m.runId,
      createdAt: m.createdAt.toISOString(),
    })),
  });
});

// ── Chat (server-sent events) ───────────────────────────────────────────────
const answering = new Set<string>();
const pingMs = (): number => Number(process.env.AI_SSE_PING_MS) || 15_000;

router.post("/ai/chat", ...aiAuth, async (req, res): Promise<void> => {
  const body = AiChatBody.strict().safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const userId = actorOf(req);
  const conv = await ownConversation(req.householdId!, userId, body.data.conversationId);
  if (!conv) return notFound(res);
  if (answering.has(conv.id)) {
    res.status(409).json({ error: "This conversation is already answering." });
    return;
  }
  answering.add(conv.id);

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const write = (chunk: string): void => {
    if (res.writableEnded || res.destroyed) return;
    res.write(chunk);
    (res as unknown as { flush?: () => void }).flush?.();
  };
  const send = (e: AiChatEvent): void => write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  write(": open\n\n");
  const ping = setInterval(() => write(": ping\n\n"), pingMs());

  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) ac.abort(new Error("client-gone"));
  });

  try {
    if (!conv.title) {
      await db
        .update(agentConversationsTable)
        .set({ title: body.data.text.trim().slice(0, 60) })
        .where(eq(agentConversationsTable.id, conv.id));
    }
    await runAgent({
      ctx: { householdId: req.householdId!, ownerUserId: req.householdOwnerId!, actorUserId: userId },
      conversationId: conv.id,
      userText: body.data.text.trim(),
      userAskedToChange: body.data.userAskedToChange === true,
      onEvent: send,
      signal: ac.signal,
    });
  } catch (err) {
    logger.error({ err }, "ai chat route crashed");
    send({ type: "error", code: "api_error", message: "Something went wrong.", retryable: true });
  } finally {
    clearInterval(ping);
    answering.delete(conv.id);
    if (!res.writableEnded) res.end();
  }
});

// ── Proposals ───────────────────────────────────────────────────────────────
router.get("/agent/proposals", requireAuth, async (req, res): Promise<void> => {
  const q = ListAgentProposalsQueryParams.safeParse(req.query);
  if (!q.success) {
    res.status(400).json({ error: q.error.message });
    return;
  }
  const hh = req.householdId!;
  await expireProposals(hh);
  const status = q.data.status ?? "proposed";
  const rows = await db
    .select()
    .from(agentProposalsTable)
    .where(status === "all" ? eq(agentProposalsTable.householdId, hh) : and(eq(agentProposalsTable.householdId, hh), eq(agentProposalsTable.status, status)))
    .orderBy(desc(agentProposalsTable.createdAt), desc(agentProposalsTable.id))
    .limit(q.data.limit ?? 20);
  res.json({ proposals: rows.map(proposalView) });
});

async function openProposal(hh: string, rawId: string) {
  if (!isUuid(rawId)) return { row: null as null, error: 404 as const };
  await expireProposals(hh);
  const [row] = await db
    .select()
    .from(agentProposalsTable)
    .where(and(eq(agentProposalsTable.id, rawId), eq(agentProposalsTable.householdId, hh)));
  if (!row) return { row: null as null, error: 404 as const };
  return { row, error: null };
}

router.post("/agent/proposals/:id/approve", requireAuth, async (req, res): Promise<void> => {
  const p = ApproveAgentProposalParams.safeParse(req.params);
  if (!p.success) return notFound(res);
  const hh = req.householdId!;
  const { row } = await openProposal(hh, p.data.id);
  if (!row) return notFound(res);
  if (row.status !== "proposed") {
    res.status(409).json({ error: row.status === "expired" ? "This proposal has expired." : "This proposal was already decided." });
    return;
  }
  const actor = actorOf(req);
  // Claim it first, so two taps apply once.
  const [claimed] = await db
    .update(agentProposalsTable)
    .set({ status: "approved", decidedBy: actor, decidedAt: new Date() })
    .where(and(eq(agentProposalsTable.id, row.id), eq(agentProposalsTable.householdId, hh), eq(agentProposalsTable.status, "proposed")))
    .returning();
  if (!claimed) {
    res.status(409).json({ error: "This proposal was already decided." });
    return;
  }
  let result;
  try {
    result = await applyProposal(claimed, { householdId: hh, ownerUserId: req.householdOwnerId!, actorUserId: actor, isOwner: isOwnerReq(req) });
  } catch (err) {
    await db.update(agentProposalsTable).set({ status: "proposed", decidedBy: null, decidedAt: null }).where(eq(agentProposalsTable.id, row.id));
    throw err;
  }
  if (!result.ok) {
    // Nothing was written: it stays open for whoever may apply it.
    await db.update(agentProposalsTable).set({ status: "proposed", decidedBy: null, decidedAt: null }).where(eq(agentProposalsTable.id, row.id));
    res.status(result.status).json({ error: result.error });
    return;
  }
  const [done] = await db
    .update(agentProposalsTable)
    .set({ status: "applied", appliedActionId: result.actionId })
    .where(eq(agentProposalsTable.id, row.id))
    .returning();
  res.json(proposalView(done!));
});

router.post("/agent/proposals/:id/reject", requireAuth, async (req, res): Promise<void> => {
  const p = RejectAgentProposalParams.safeParse(req.params);
  if (!p.success) return notFound(res);
  const hh = req.householdId!;
  const { row } = await openProposal(hh, p.data.id);
  if (!row) return notFound(res);
  const [rejected] = await db
    .update(agentProposalsTable)
    .set({ status: "rejected", decidedBy: actorOf(req), decidedAt: new Date() })
    .where(and(eq(agentProposalsTable.id, row.id), eq(agentProposalsTable.householdId, hh), eq(agentProposalsTable.status, "proposed")))
    .returning();
  if (!rejected) {
    res.status(409).json({ error: row.status === "expired" ? "This proposal has expired." : "This proposal was already decided." });
    return;
  }
  res.json(proposalView(rejected));
});

// ── Memory ──────────────────────────────────────────────────────────────────
router.get("/memory", requireAuth, async (req, res): Promise<void> => {
  const rows = await listMemory(req.householdId!, actorOf(req));
  res.json({ memories: rows.map(memoryView) });
});

router.put("/memory/:scope/:key", requireAuth, async (req, res): Promise<void> => {
  const params = PutMemoryParams.safeParse(req.params);
  const body = PutMemoryBody.strict().safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: (!params.success ? params.error : body.error!).message });
    return;
  }
  const key = cleanKey(params.data.key);
  const value = body.data.value.trim();
  if (!key || !value || !(MEMORY_SCOPES as readonly string[]).includes(params.data.scope)) {
    res.status(400).json({ error: "Invalid key or value." });
    return;
  }
  const actor = actorOf(req);
  const r = await upsertUserMemory(req.householdId!, actor, {
    scope: params.data.scope as MemoryScope,
    key,
    value: { text: value },
    memberUserId: body.data.mine ? actor : null,
  });
  if (!r.ok) {
    res.status(409).json({ error: "The household's memory is full. Forget something first." });
    return;
  }
  res.json(memoryView(r.memory));
});

router.delete("/memory/:id", requireAuth, async (req, res): Promise<void> => {
  const p = DeleteMemoryParams.safeParse(req.params);
  if (!p.success || !isUuid(p.data.id) || !(await revokeMemory(req.householdId!, p.data.id))) return notFound(res);
  res.sendStatus(204);
});

// ── Wish list ───────────────────────────────────────────────────────────────
router.get("/wishlist", requireAuth, async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(wishlistItemsTable)
    .where(eq(wishlistItemsTable.householdId, req.householdId!))
    .orderBy(desc(wishlistItemsTable.requestedAt))
    .limit(100);
  const today = householdTodayISO();
  res.json({ waitDays: await wishlistWaitDays(req.householdOwnerId!), items: rows.map((w) => wishlistView(w, today)) });
});

router.post("/wishlist", requireAuth, async (req, res): Promise<void> => {
  const b = CreateWishlistItemBody.strict().safeParse(req.body);
  if (!b.success) {
    res.status(400).json({ error: b.error.message });
    return;
  }
  const hh = req.householdId!;
  if (b.data.categoryId) {
    const [c] = await db
      .select({ id: budgetCategoriesTable.id })
      .from(budgetCategoriesTable)
      .where(and(eq(budgetCategoriesTable.id, b.data.categoryId), eq(budgetCategoriesTable.householdId, hh)));
    if (!c) {
      res.status(400).json({ error: "Unknown category." });
      return;
    }
  }
  const item = await addWishlistItem(hh, req.householdOwnerId!, actorOf(req), {
    title: b.data.title.trim(),
    amount: b.data.amount,
    url: b.data.url ?? null,
    categoryId: b.data.categoryId ?? null,
    targetDate: b.data.targetDate ?? null,
  });
  res.status(201).json(wishlistView(item));
});

router.patch("/wishlist/:id", requireAuth, async (req, res): Promise<void> => {
  const p = UpdateWishlistItemParams.safeParse(req.params);
  const b = UpdateWishlistItemBody.strict().safeParse(req.body);
  if (!p.success || !isUuid(p.data.id)) return notFound(res);
  if (!b.success) {
    res.status(400).json({ error: b.error.message });
    return;
  }
  const hh = req.householdId!;
  const [item] = await db
    .select()
    .from(wishlistItemsTable)
    .where(and(eq(wishlistItemsTable.id, p.data.id), eq(wishlistItemsTable.householdId, hh)));
  if (!item) return notFound(res);
  const today = householdTodayISO();
  const d = b.data;
  const set: Partial<typeof wishlistItemsTable.$inferInsert> = {};
  if (d.title !== undefined) set.title = d.title.trim();
  if (d.amount !== undefined) set.amount = d.amount === null ? null : d.amount.toFixed(2);
  if (d.url !== undefined) set.url = d.url;
  if (d.targetDate !== undefined) set.targetDate = d.targetDate;
  if (d.decision !== undefined) {
    // A yes (approved / bought) waits out the waiting period; a no never does.
    if ((d.decision === "approved" || d.decision === "bought") && item.waitingUntil > today) {
      res.status(409).json({ error: `This waits until ${item.waitingUntil}.`, waitingUntil: item.waitingUntil });
      return;
    }
    set.decision = d.decision;
    set.decidedAt = d.decision === "pending" ? null : new Date();
  }
  if (Object.keys(set).length === 0) {
    res.json(wishlistView(item, today));
    return;
  }
  const [row] = await db
    .update(wishlistItemsTable)
    .set(set)
    .where(and(eq(wishlistItemsTable.id, item.id), eq(wishlistItemsTable.householdId, hh)))
    .returning();
  res.json(wishlistView(row!, today));
});

// ── AI usage ────────────────────────────────────────────────────────────────
function budgetView(state: Awaited<ReturnType<typeof getBudgetState>>) {
  return {
    monthlyCapUsd: state.monthlyCapUsd,
    hardCapUsd: state.hardCapUsd,
    dailyCaps: state.dailyCaps as Record<string, number>,
    pausedUntil: iso(state.pausedUntil),
  };
}

router.get("/ai/usage/summary", ...aiAuth, async (req, res): Promise<void> => {
  const hh = req.householdId!;
  const now = new Date();
  const since = startOfUtcMonth(now);
  const state = await getBudgetState(hh, now);
  const blocked = sql.join(BLOCKED_STATUSES.map((s) => sql`${s}`), sql`, `);
  const rows = (
    await db.execute<{ task: string; cost: string; calls: number; failures: number; input: string; read: string; write: string; blocked: number }>(sql`
      select task,
             coalesce(sum(cost_usd), 0)::text as cost,
             (count(*) filter (where status not in (${blocked})))::int as calls,
             (count(*) filter (where status not in ('ok', ${blocked})))::int as failures,
             coalesce(sum(input_tokens), 0)::text as input,
             coalesce(sum(cache_read_tokens), 0)::text as read,
             coalesce(sum(cache_write_tokens), 0)::text as write,
             (count(*) filter (where status in (${blocked})))::int as blocked
        from ai_usage
       where household_id = ${hh} and created_at >= ${since.toISOString()}::timestamptz and created_at <= ${now.toISOString()}::timestamptz
       group by task order by task`)
  ).rows;
  const sum = (f: (r: (typeof rows)[number]) => number): number => rows.reduce((a, r) => a + f(r), 0);
  const input = sum((r) => Number(r.input));
  const read = sum((r) => Number(r.read));
  const write = sum((r) => Number(r.write));
  const runs = await db
    .select()
    .from(agentRunsTable)
    .where(eq(agentRunsTable.householdId, hh))
    .orderBy(desc(agentRunsTable.startedAt))
    .limit(20);
  res.json({
    month: since.toISOString().slice(0, 7),
    monthToDateUsd: Math.round(state.monthToDateUsd * 1e6) / 1e6,
    calls: sum((r) => r.calls),
    failures: sum((r) => r.failures),
    blocked: sum((r) => r.blocked),
    cacheHitRatio: input + read + write > 0 ? Math.round((read / (input + read + write)) * 1e4) / 1e4 : null,
    byTask: rows.map((r) => ({ task: r.task, costUsd: Math.round(Number(r.cost) * 1e6) / 1e6, calls: r.calls, failures: r.failures })),
    budget: budgetView(state),
    recentRuns: runs.map((r) => ({
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
    })),
  });
});

router.put("/ai/budget", ...aiAuth, async (req, res): Promise<void> => {
  if (!isOwnerReq(req)) {
    res.status(403).json({ error: "Only the household owner sets the AI budget" });
    return;
  }
  const b = UpdateAiBudgetBody.strict().safeParse(req.body);
  if (!b.success) {
    res.status(400).json({ error: b.error.message });
    return;
  }
  const hh = req.householdId!;
  const cur = await getBudgetState(hh);
  const monthly = b.data.monthlyCapUsd ?? cur.monthlyCapUsd;
  const hard = b.data.hardCapUsd ?? cur.hardCapUsd;
  if (hard < monthly) {
    res.status(400).json({ error: "The hard limit cannot be lower than the monthly budget." });
    return;
  }
  const pausedUntil = b.data.pausedUntil === undefined ? cur.pausedUntil : b.data.pausedUntil === null ? null : new Date(b.data.pausedUntil);
  await db
    .insert(aiBudgetTable)
    .values({ householdId: hh, monthlyCapUsd: monthly.toFixed(2), hardCapUsd: hard.toFixed(2), pausedUntil, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: aiBudgetTable.householdId,
      set: { monthlyCapUsd: monthly.toFixed(2), hardCapUsd: hard.toFixed(2), pausedUntil, updatedAt: new Date() },
    });
  res.json(budgetView(await getBudgetState(hh)));
});

export default router;
