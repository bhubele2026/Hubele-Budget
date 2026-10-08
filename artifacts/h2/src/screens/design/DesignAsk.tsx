import { useMemo, useRef, useState } from "react";
import { Link, useSearch } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  getListAgentProposalsQueryKey,
  type AgentProposal,
  type AiConversation,
  type AiMessage,
  type AiUsageSummary,
  type MemoryItem,
  type MeResponse,
  type WishlistList,
} from "@workspace/api-client-react";
import type { Read } from "@/data/todayData";
import { Note } from "@/kit/Note";
import { AiCostView } from "@/screens/household/AiCost";
import { AskView, type AskModel } from "@/screens/ask/Ask";
import { MemoryView } from "@/screens/ask/AskMemory";
import { OPEN_PROPOSALS } from "@/screens/ask/askData";
import { ProposalsView } from "@/screens/ask/Proposals";
import { WishlistView } from "@/screens/plan/PlanWishlist";

/**
 * ⭐ /design/ask — ASK, MEMORY, PROPOSALS, THE WISH LIST AND THE AI COST ON
 * MADE-UP DATA, for judging the composition without signing in. Public, lazy,
 * and nothing here touches the network: it has its own query cache with
 * fetching switched off. `?page=` picks the screen (ask, memory, proposals,
 * wishlist, cost); for ask, `?state=` picks streaming, off, budget or new.
 * Every name, number and sentence is invented.
 */
const NOW = new Date("2026-10-07T15:00:00Z"); // Wednesday, 10:00 in Chicago
const loaded = <T,>(data: T): Read<T> => ({ data, state: "loaded", isFetching: false, refetch: () => {} });

const CONVERSATIONS: AiConversation[] = [
  { id: "c1", title: "Eating out last month", createdAt: "2026-10-07T14:20:00Z", lastMessageAt: "2026-10-07T14:21:00Z" },
  { id: "c2", title: "Weekend spending", createdAt: "2026-10-05T18:00:00Z", lastMessageAt: "2026-10-05T18:02:00Z" },
  { id: "c3", title: "Subscriptions", createdAt: "2026-10-01T12:00:00Z", lastMessageAt: "2026-10-01T12:03:00Z" },
];
const msg = (id: string, role: "user" | "assistant", text: string, runId: string | null, extra: Record<string, unknown> = {}): AiMessage => ({
  id,
  role,
  content: { text, ...extra },
  runId,
  createdAt: "2026-10-07T14:21:00Z",
});
const THREAD: AiMessage[] = [
  msg("m1", "user", "How much did we spend eating out last month?", null),
  msg(
    "m2",
    "assistant",
    "You spent $412 eating out in September, across 23 charges. The two biggest were at Sample Diner and Corner Grill.\n\nThat is $60 more than August.\nBased on: ref:txn-sample-0001, ref:txn-sample-0002\n\nNext step: lower the dining limit to $350 a month if you want to bring it back down.",
    "run-1",
    { grounded: true },
  ),
];
const PROPOSAL: AgentProposal = {
  id: "p1",
  kind: "budget_line",
  status: "proposed",
  payload: { target: "cat-dining", before: 400, after: 350, label: "Dining out, October" },
  rationale: "September ran $60 over August, and the October line is still $400.",
  runId: "run-1",
  decidedBy: null,
  decidedAt: null,
  appliedActionId: null,
  expiresAt: "2026-10-21T14:21:00Z",
  createdAt: "2026-10-07T14:21:00Z",
};
const DECIDED: AgentProposal[] = [
  { ...PROPOSAL, id: "p2", kind: "weekly_limit", status: "applied", payload: { target: "plan-1", before: 600, after: 550, label: "Weekly limit" }, rationale: "Spending has run under the limit for six weeks.", decidedAt: "2026-10-02T13:00:00Z" },
  { ...PROPOSAL, id: "p3", kind: "extra_debt_payment", status: "rejected", payload: { target: "extra", before: 100, after: 200, label: "Extra debt payment" }, rationale: "There is room after the October bills.", decidedAt: "2026-09-28T13:00:00Z" },
  { ...PROPOSAL, id: "p4", kind: "set_category", status: "expired", payload: { target: "t1", txnId: "txn-sample-0003", before: null, after: "cat-groceries", label: "Category" }, rationale: "This merchant is usually filed under Groceries.", createdAt: "2026-09-10T13:00:00Z" },
];
const CATS = new Map([["cat-groceries", "Groceries"]]);

const MEMORY: MemoryItem[] = [
  { id: "k1", scope: "categorization", key: "sample_diner", value: { text: "Sample Diner is Dining out, not Groceries." }, source: "user_stated", createdByKind: "user", memberUserId: null, updatedAt: "2026-10-03T12:00:00Z" },
  { id: "k2", scope: "categorization", key: "corner_market", value: { text: "Corner Market is Groceries.", evidence: ["txn-sample-0004"] }, source: "inferred", createdByKind: "agent", memberUserId: null, updatedAt: "2026-10-01T12:00:00Z" },
  { id: "k3", scope: "spending", key: "weekend_limit", value: { text: "We try to keep weekends under $150.", kind: "preference" }, source: "agent_proposed", createdByKind: "agent", memberUserId: null, updatedAt: "2026-09-29T12:00:00Z" },
  { id: "k4", scope: "general", key: "paydays", value: { text: "Paid on the 1st and 15th." }, source: "user_stated", createdByKind: "user", memberUserId: null, updatedAt: "2026-09-12T12:00:00Z" },
];

const WISHLIST: WishlistList = {
  waitDays: 7,
  items: [
    { id: "w1", title: "Standing desk", amount: 480, url: "https://example.com/desk", categoryId: null, targetDate: null, requestedBy: "u1", requestedAt: "2026-10-05T12:00:00Z", waitingUntil: "2026-10-12", waitingDaysLeft: 5, decision: "pending", decidedAt: null },
    { id: "w2", title: "Rain jacket", amount: 120, url: null, categoryId: null, targetDate: null, requestedBy: "u1", requestedAt: "2026-09-20T12:00:00Z", waitingUntil: "2026-09-27", waitingDaysLeft: 0, decision: "approved", decidedAt: "2026-09-28T12:00:00Z" },
    { id: "w3", title: "Board game", amount: 45, url: null, categoryId: null, targetDate: null, requestedBy: "u1", requestedAt: "2026-09-01T12:00:00Z", waitingUntil: "2026-09-08", waitingDaysLeft: 0, decision: "bought", decidedAt: "2026-09-10T12:00:00Z" },
  ],
};

const USAGE: AiUsageSummary = {
  month: "2026-10",
  monthToDateUsd: 1.84,
  calls: 96,
  failures: 3,
  blocked: 0,
  cacheHitRatio: 0.72,
  byTask: [
    { task: "chat", costUsd: 0.91, calls: 24, failures: 1 },
    { task: "categorize", costUsd: 0.62, calls: 58, failures: 1 },
    { task: "recap", costUsd: 0.31, calls: 14, failures: 1 },
  ],
  budget: { monthlyCapUsd: 5, hardCapUsd: 10, dailyCaps: {}, pausedUntil: null },
  recentRuns: [
    { id: "r1", kind: "chat", trigger: "user", status: "succeeded", startedAt: "2026-10-07T14:20:00Z", finishedAt: "2026-10-07T14:20:09Z", summary: "2 tools, 1 proposal", inputTokens: 3100, outputTokens: 240, costUsd: 0.04 },
    { id: "r2", kind: "categorize", trigger: "txn_arrived", status: "succeeded", startedAt: "2026-10-07T13:02:00Z", finishedAt: "2026-10-07T13:02:03Z", summary: "3 charges filed", inputTokens: 900, outputTokens: 60, costUsd: 0.01 },
    { id: "r3", kind: "recap", trigger: "schedule", status: "failed", startedAt: "2026-10-07T12:00:00Z", finishedAt: "2026-10-07T12:00:30Z", summary: "timeout", inputTokens: 0, outputTokens: 0, costUsd: null },
  ],
};
const ME = { isOwner: true } as MeResponse;

const PAGES = ["ask", "memory", "proposals", "wishlist", "cost"] as const;

function seededClient(): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  qc.setQueryData(getListAgentProposalsQueryKey(OPEN_PROPOSALS), { proposals: [PROPOSAL] });
  return qc;
}

function AskSample({ state }: { state: string }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const listButton = useRef<HTMLButtonElement>(null);
  const [typed, setTyped] = useState("");
  const [asked, setAsked] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const fresh = state === "new";
  const model: AskModel = {
    conversations: CONVERSATIONS,
    activeId: fresh ? null : "c1",
    stored: fresh || state === "streaming" ? [] : THREAD,
    loadingThread: false,
    names: CATS,
    byRun: new Map([["run-1", [PROPOSAL]]]),
    pending:
      state === "streaming"
        ? { question: "Can we spend $300 this weekend and still cover bills?", baseCount: 0, assistantBefore: 0, streamed: "You have $410 free until payday, so $300 fits. The electric bill is already counted.", tool: "get_bills_and_income" }
        : null,
    showUserOverlay: state === "streaming",
    showAnswerOverlay: state === "streaming",
    failure: state === "budget" ? { code: "budget_exceeded", message: "Ask has reached its limit for now." } : null,
    aiOff: state === "off",
    typed,
    setTyped,
    asked,
    setAsked,
    phase: state === "streaming" ? "sending" : "idle",
    send: () => {},
    pick: () => {},
    startNew: () => {},
    listOpen,
    setListOpen,
    input,
    end,
    listButton,
    bank: state === "stale" ? { asOfDate: "2026-10-04", source: "plaid", lastContactAt: "2026-10-04T12:00:00Z", stale: true, staleReason: "old" } : undefined,
    spineState: "loaded",
  };
  return <AskView m={model} />;
}

export default function DesignAsk() {
  const params = new URLSearchParams(useSearch());
  const page = params.get("page") ?? "ask";
  const state = params.get("state") ?? "";
  const client = useMemo(seededClient, []);
  return (
    <QueryClientProvider client={client}>
      <div className="flex flex-col gap-6" data-testid="page-design-ask">
        <Note kind="empty" data-testid="sample-note">
          Sample — every name, number and answer on this page is made up.
        </Note>
        <p className="flex flex-wrap gap-4 type-label" data-testid="sample-pages">
          {PAGES.map((p) => (
            <Link key={p} href={`/design/ask?page=${p}`} className={p === page ? "text-ink" : "text-moss underline decoration-1 underline-offset-4"}>
              {p}
            </Link>
          ))}
        </p>
        {page === "memory" ? (
          <MemoryView memories={loaded(MEMORY)} now={NOW} />
        ) : page === "proposals" ? (
          <ProposalsView data={{ open: loaded([PROPOSAL]), all: loaded([PROPOSAL, ...DECIDED]), categories: CATS }} />
        ) : page === "wishlist" ? (
          <WishlistView list={loaded(WISHLIST)} />
        ) : page === "cost" ? (
          <AiCostView data={{ usage: loaded(USAGE), me: loaded(ME) }} now={NOW} />
        ) : (
          <AskSample state={state} />
        )}
      </div>
    </QueryClientProvider>
  );
}
