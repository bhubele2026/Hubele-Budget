import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getAiConversation,
  getGetAiConversationQueryKey,
  getListAiConversationsQueryKey,
  useCreateAiConversation,
  type AgentProposal,
  type AiConversation,
  type AiMessage,
} from "@workspace/api-client-react/features";
import { PageGrid, Panel } from "@/components/next";
import { FreshnessLine } from "@/components/data-state";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useSpine } from "@/hooks/useSpine";
import { OWN_INVALIDATION, invalidateAfterWrite } from "@/lib/mutationInvalidation";
import { pollForAnswer, streamAnswer } from "@/lib/aiStream";
import { BASED_ON, paragraphs, refHref, splitRefs, toolLine } from "@/lib/askWords";
import { relativeTime } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { btn, btnLink, btnSecondarySm, input } from "@/ui";
import { TabSkeleton } from "@/pages/settings/parts";
import {
  CONVERSATIONS,
  PROPOSALS_PREFIX,
  useAiHealth,
  useAllProposals,
  useCategoryNames,
  useConversation,
  useConversations,
  useOpenProposals,
} from "./askData";
import { ProposalCard } from "./ProposalCard";

export const HINT = "Ask about your money. H2 answers from your own records.";
export const SUGGESTIONS = [
  "How much did we spend eating out last month?",
  "Can we spend $300 this weekend and still cover bills?",
  "Which subscriptions haven't I looked at lately?",
] as const;
/** The honest state when the server has AI switched off (`/healthz` `ai.enabled`). */
export const AI_OFF = "AI is off for this app, so Ask can't answer yet. It is turned on on the server (AI_ENABLED).";
const MAX_LEN = 2000;

export type Phase = "idle" | "sending" | "finishing";
export interface Pending {
  question: string;
  /** How many stored messages (user and assistant) the thread had when it was sent. */
  baseCount: number;
  assistantBefore: number;
  streamed: string;
  tool: string | null;
}
export interface Failure {
  message: string;
  code: string;
}

const textOf = (m: Pick<AiMessage, "content">): string => {
  const t = (m.content as { text?: unknown }).text;
  return typeof t === "string" ? t : "";
};

/** One answer line: plain text, with each `ref:<id>` as a link to that charge. */
function Line({ text }: { text: string }) {
  const based = BASED_ON.test(text);
  const body = based ? text.replace(BASED_ON, "") : text;
  let n = 0;
  return (
    <>
      {based && <span className="text-label font-semibold text-neutral-500">Based on </span>}
      {splitRefs(body).map((p, i) =>
        p.kind === "text" ? (
          <Fragment key={i}>{based ? p.text.replace(/^[\s,;]+|[\s,;]+$/g, " ") : p.text}</Fragment>
        ) : (
          <Link
            key={i}
            href={refHref(p.id)}
            className="text-label font-semibold text-brand-navy underline underline-offset-4 hover:text-brand-navy2"
            data-testid="answer-ref"
          >
            {`Charge ${++n}`}
          </Link>
        ),
      )}
    </>
  );
}

/** An answer as plain React text, in paragraphs. Never HTML. */
export function AnswerText({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-3 text-body text-brand-ink" data-testid="answer-text">
      {paragraphs(text).map((para, i) => (
        <p key={i} className="whitespace-pre-line">
          {para.split("\n").map((line, j, all) => (
            <Fragment key={j}>
              <Line text={line} />
              {j < all.length - 1 ? "\n" : null}
            </Fragment>
          ))}
        </p>
      ))}
    </div>
  );
}

function Bubble({ who, children, testId }: { who: "you" | "h2"; children: ReactNode; testId: string }) {
  return (
    <div className={cn("flex flex-col gap-1", who === "you" && "items-end")} data-testid={testId}>
      <span className="text-micro font-semibold uppercase tracking-wide text-neutral-400">{who === "you" ? "You" : "H2"}</span>
      <div
        className={cn(
          "max-w-full",
          who === "you" && "rounded-control bg-platinum-2 px-3 py-2 text-body text-brand-ink ring-1 ring-brand-line",
        )}
      >
        {children}
      </div>
    </div>
  );
}

function ConversationList({
  conversations,
  activeId,
  onPick,
  onNew,
}: {
  conversations: readonly AiConversation[];
  activeId: string | null;
  onPick: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="flex flex-col gap-2" data-testid="conversation-list">
      <button type="button" onClick={onNew} className={`${btnSecondarySm} self-start`} data-testid="new-conversation">
        New conversation
      </button>
      {conversations.length === 0 ? (
        <p className="text-micro text-neutral-400">Nothing asked yet.</p>
      ) : (
        <ul className="divide-y divide-brand-line/70">
          {conversations.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onPick(c.id)}
                aria-current={c.id === activeId ? "true" : undefined}
                className={cn(
                  "press flex w-full flex-col gap-0.5 rounded-control px-2 py-2 text-left hover:bg-platinum-2",
                  c.id === activeId && "bg-platinum-3",
                )}
                data-testid="conversation-item"
              >
                <span className="truncate text-label font-semibold text-brand-navy">{c.title?.trim() || "New conversation"}</span>
                <span className="text-micro text-neutral-400">{relativeTime(c.lastMessageAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * ⭐ (F8) ASK — a question, an answer that streams in, and the records it
 * rests on. H2 answers from your own data through tools; every `$` figure is
 * checked on the server, and a change it suggests is a proposal you approve
 * below the answer (and on Review › Suggestions). The browser never works out
 * a figure. Gated on `/healthz` `ai.enabled`: when the server has AI off the
 * page says so and the composer is disabled.
 *
 * Ported from h2's `screens/ask/Ask.tsx` onto h2budget's panels; hooks from
 * the `features` client; the stream is `lib/aiStream.ts` (plain fetch, SSE,
 * Stop aborts it — and leaving the page does too).
 */
export default function AskPage() {
  const qc = useQueryClient();
  const health = useAiHealth();
  const spine = useSpine();
  const list = useConversations();
  const createConversation = useCreateAiConversation({ mutation: { meta: OWN_INVALIDATION } });
  const proposals = useAllProposals();
  const openProposals = useOpenProposals();
  const names = useCategoryNames();

  const [activeId, setActiveId] = useState<string | null>(null);
  const detail = useConversation(activeId);
  const [typed, setTyped] = useState("");
  const [asked, setAsked] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [pending, setPending] = useState<Pending | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const stopper = useRef<AbortController | null>(null);

  // Leaving the page stops a question in flight.
  useEffect(() => () => stopper.current?.abort("unmount"), []);

  const aiOff = health.data?.ai?.enabled === false;
  const stored = useMemo(
    () => (detail.data?.messages ?? []).filter((m) => m.role === "user" || m.role === "assistant"),
    [detail.data],
  );
  const byRun = useMemo(() => {
    const m = new Map<string, AgentProposal[]>();
    for (const p of proposals.data?.proposals ?? []) m.set(p.runId, [...(m.get(p.runId) ?? []), p]);
    return m;
  }, [proposals.data]);

  const storedAssistants = stored.filter((m) => m.role === "assistant").length;
  const showUserOverlay = pending != null && stored.length <= pending.baseCount;
  const showAnswerOverlay = pending != null && storedAssistants <= pending.assistantBefore;

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "end" });
  }, [stored.length, pending?.streamed, pending?.tool, phase]);

  const send = async (raw: string) => {
    const question = raw.trim();
    if (!question || phase !== "idle" || aiOff) return;
    const changeAsked = asked;
    setTyped("");
    setAsked(false);
    setFailure(null);
    setPhase("sending");
    const baseCount = stored.length;
    const assistantBefore = storedAssistants;
    setPending({ question, baseCount, assistantBefore, streamed: "", tool: null });

    let id = activeId;
    try {
      if (!id) {
        const c = await createConversation.mutateAsync();
        id = c.id;
        setActiveId(id);
      }
    } catch {
      setFailure({ message: "Couldn't start a conversation. Try again.", code: "start_failed" });
      setPending(null);
      setPhase("idle");
      setTyped(question);
      return;
    }

    const ctrl = new AbortController();
    stopper.current = ctrl;
    const result = await streamAnswer({
      conversationId: id,
      text: question,
      userAskedToChange: changeAsked,
      signal: ctrl.signal,
      onToken: (t) => setPending((p) => (p ? { ...p, streamed: p.streamed + t } : p)),
      onTool: (name, status) => setPending((p) => (p ? { ...p, tool: status === "running" ? name : null } : p)),
    });
    stopper.current = null;

    setPhase("finishing");
    if (result.kind === "done") {
      setPending((p) => (p ? { ...p, streamed: result.done.text, tool: null } : p));
      // A message that let H2 file a charge may have moved money.
      if (changeAsked) invalidateAfterWrite(qc);
    } else if (result.kind === "error") {
      setFailure({ message: result.message, code: result.code });
    } else if (result.kind === "aborted") {
      if (ctrl.signal.reason === "unmount") return;
      setFailure({
        message: "Stopped. If H2 had already started, its answer may still appear in this conversation.",
        code: "stopped",
      });
    } else {
      setPending((p) => (p ? { ...p, tool: null } : p));
      const convId = id;
      const found = await pollForAnswer({ assistantBefore, getDetail: () => getAiConversation(convId) });
      if (!found) {
        setFailure({
          message: "H2 lost the connection before the answer arrived. Open the conversation again in a moment.",
          code: "dropped",
        });
      }
    }
    await Promise.all([
      qc.refetchQueries({ queryKey: getGetAiConversationQueryKey(id) }),
      qc.invalidateQueries({ queryKey: getListAiConversationsQueryKey(CONVERSATIONS) }),
      qc.invalidateQueries({ queryKey: PROPOSALS_PREFIX }),
    ]);
    setPending(null);
    setPhase("idle");
  };

  const stop = () => stopper.current?.abort();
  const pick = (id: string) => {
    if (phase !== "idle") return;
    setActiveId(id);
    setFailure(null);
    setListOpen(false);
  };
  const startNew = () => {
    if (phase !== "idle") return;
    setActiveId(null);
    setFailure(null);
    setListOpen(false);
    input.current?.focus();
  };

  return (
    <AskView
      m={{
        conversations: list.data?.conversations ?? [],
        activeId,
        activeTitle: (list.data?.conversations ?? []).find((c) => c.id === activeId)?.title ?? null,
        stored,
        loadingThread: activeId != null && detail.data == null && !detail.isError,
        names,
        byRun,
        openCount: openProposals.data?.proposals.length ?? null,
        pending,
        showUserOverlay,
        showAnswerOverlay,
        failure,
        aiOff,
        typed,
        setTyped,
        asked,
        setAsked,
        phase,
        send: () => void send(typed),
        stop,
        pick,
        startNew,
        listOpen,
        setListOpen,
        input,
        end,
        bank: spine.data?.bank,
      }}
    />
  );
}

export interface AskModel {
  conversations: readonly AiConversation[];
  activeId: string | null;
  activeTitle: string | null;
  stored: readonly AiMessage[];
  loadingThread: boolean;
  names: ReadonlyMap<string, string>;
  byRun: ReadonlyMap<string, AgentProposal[]>;
  openCount: number | null;
  pending: Pending | null;
  showUserOverlay: boolean;
  showAnswerOverlay: boolean;
  failure: Failure | null;
  aiOff: boolean;
  typed: string;
  setTyped: (s: string) => void;
  asked: boolean;
  setAsked: (b: boolean) => void;
  phase: Phase;
  send: () => void;
  stop: () => void;
  pick: (id: string) => void;
  startNew: () => void;
  listOpen: boolean;
  setListOpen: (b: boolean) => void;
  input: RefObject<HTMLTextAreaElement | null>;
  end: RefObject<HTMLDivElement | null>;
  bank: Parameters<typeof FreshnessLine>[0]["bank"];
}

/** The page on a model it is handed. */
export function AskView({ m }: { m: AskModel }) {
  const { conversations, activeId, stored, loadingThread, names, byRun, pending, failure, aiOff, phase } = m;
  const empty = stored.length === 0 && pending == null;
  const index = <ConversationList conversations={conversations} activeId={activeId} onPick={m.pick} onNew={m.startNew} />;
  const busy = phase !== "idle";

  return (
    <div className="space-y-4" data-testid="ask">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-display font-semibold text-brand-navy">Ask</h1>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/review/suggestions" className={btnLink} data-testid="ask-suggestions-link">
            Suggestions{m.openCount ? ` (${m.openCount})` : ""}
          </Link>
          <Link href="/settings?tab=memory" className={btnLink} data-testid="ask-memory-link">
            What H2 remembers
          </Link>
        </div>
      </div>
      {m.bank?.stale && (
        <div className="text-micro text-neutral-500" data-testid="ask-fresh">
          <FreshnessLine bank={m.bank} />
        </div>
      )}

      <PageGrid className="items-start">
        <Panel title="Conversations" span={4} variant="static" className="hidden lg:block" data-testid="conversation-index">
          {index}
        </Panel>

        <Panel
          title={m.activeTitle?.trim() || (activeId ? "Conversation" : "New conversation")}
          span={8}
          variant={["static", "flush"]}
          data-testid="ask-thread-panel"
          actions={
            <button
              type="button"
              onClick={() => m.setListOpen(true)}
              className={`${btnSecondarySm} lg:hidden`}
              data-testid="open-conversations"
            >
              Conversations
            </button>
          }
        >
          <div className="flex min-h-48 flex-col gap-5 px-4 py-4" data-testid="thread" aria-live="polite">
            {loadingThread ? (
              <TabSkeleton testId="thread-skeleton" rows={2} />
            ) : empty ? (
              <p className="text-body text-neutral-600" data-testid="thread-empty">
                {HINT}
              </p>
            ) : null}
            {stored.map((msg) => (
              <Fragment key={msg.id}>
                {msg.role === "user" ? (
                  <Bubble who="you" testId="msg-user">
                    <p className="whitespace-pre-line">{textOf(msg)}</p>
                  </Bubble>
                ) : (
                  <Bubble who="h2" testId="msg-assistant">
                    <AnswerText text={textOf(msg)} />
                    {(msg.content as { grounded?: unknown }).grounded === false && (
                      <p className="mt-2 text-micro text-neutral-500">H2 could not check every figure in this answer.</p>
                    )}
                    {msg.runId && (byRun.get(msg.runId) ?? []).length > 0 && (
                      <div className="mt-3 space-y-2">
                        {(byRun.get(msg.runId) ?? []).map((p) => (
                          <ProposalCard key={p.id} proposal={p} categories={names} />
                        ))}
                      </div>
                    )}
                  </Bubble>
                )}
              </Fragment>
            ))}
            {pending && m.showUserOverlay && (
              <Bubble who="you" testId="msg-user-pending">
                <p className="whitespace-pre-line">{pending.question}</p>
              </Bubble>
            )}
            {pending && m.showAnswerOverlay && !failure && (
              <Bubble who="h2" testId="msg-assistant-pending">
                {pending.streamed ? <AnswerText text={pending.streamed} /> : null}
                {pending.tool ? (
                  <p className="text-micro text-neutral-500" data-testid="tool-line">
                    {toolLine(pending.tool)}
                  </p>
                ) : !pending.streamed ? (
                  <p className="text-micro text-neutral-500" data-testid="thinking">
                    Thinking…
                  </p>
                ) : null}
              </Bubble>
            )}
            {failure && (
              <div
                role="alert"
                className="flex flex-wrap items-center gap-3 rounded-control bg-bad-bg px-3 py-2 text-body text-bad ring-1 ring-bad/15"
                data-testid="ask-failure"
              >
                <span>{failure.message}</span>
                {failure.code === "budget_exceeded" && (
                  <Link href="/settings?tab=ai" className="font-semibold text-brand-navy underline underline-offset-2">
                    AI cost
                  </Link>
                )}
              </div>
            )}
            <div ref={m.end} />
          </div>

          {empty && !aiOff && (
            <ul className="flex flex-wrap gap-2 px-4 pb-3" aria-label="Suggested questions" data-testid="suggestions">
              {SUGGESTIONS.map((s) => (
                <li key={s}>
                  <button
                    type="button"
                    onClick={() => {
                      m.setTyped(s);
                      m.input.current?.focus();
                    }}
                    className="press rounded-control bg-white px-3 py-2 text-left text-micro text-neutral-600 ring-1 ring-brand-line hover:bg-platinum-2 hover:text-brand-navy"
                    data-testid="suggestion"
                  >
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form
            className="flex flex-col gap-2 border-t border-brand-line bg-platinum-1 px-4 py-3"
            onSubmit={(e) => {
              e.preventDefault();
              m.send();
            }}
            data-testid="composer"
          >
            {aiOff && (
              <p className="rounded-control bg-platinum-3 px-3 py-2 text-body text-neutral-600" data-testid="ask-ai-off">
                {AI_OFF}{" "}
                <Link href="/settings?tab=automation" className="font-semibold text-brand-navy underline underline-offset-2">
                  Settings › Automation
                </Link>
              </p>
            )}
            <label htmlFor="ask-input" className="sr-only">
              Your question
            </label>
            <textarea
              id="ask-input"
              ref={m.input}
              rows={2}
              maxLength={MAX_LEN}
              value={m.typed}
              disabled={aiOff || busy}
              onChange={(e) => m.setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  m.send();
                }
              }}
              className={`${input} resize-none disabled:bg-platinum-2 disabled:text-neutral-400`}
              placeholder={aiOff ? "" : "Ask a question"}
              data-testid="ask-input"
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-micro text-neutral-600">
                <input
                  type="checkbox"
                  checked={m.asked}
                  disabled={aiOff || busy}
                  onChange={(e) => m.setAsked(e.target.checked)}
                  className="size-4 accent-[var(--color-brand-navy)]"
                  data-testid="ask-may-change"
                />
                Let H2 file charges I name in this message
              </label>
              <span className="flex items-center gap-2">
                {busy && (
                  <button type="button" className={btnLink} onClick={m.stop} data-testid="ask-stop">
                    Stop
                  </button>
                )}
                <button
                  type="submit"
                  className={btn}
                  disabled={aiOff || busy || m.typed.trim() === ""}
                  data-testid="ask-send"
                >
                  {busy ? "Asking…" : "Ask"}
                </button>
              </span>
            </div>
            <p className="text-micro text-neutral-400">{HINT}</p>
          </form>
        </Panel>
      </PageGrid>

      <Sheet open={m.listOpen} onOpenChange={m.setListOpen}>
        <SheetContent side="left" data-testid="conversation-sheet">
          <SheetHeader>
            <SheetTitle>Conversations</SheetTitle>
          </SheetHeader>
          <div className="mt-4">{index}</div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
