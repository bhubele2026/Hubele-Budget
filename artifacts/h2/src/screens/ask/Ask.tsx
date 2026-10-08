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
} from "@workspace/api-client-react";
import { pollForAnswer, streamAnswer } from "@/data/aiStream";
import { invalidateAfterWrite } from "@/data/mutationInvalidation";
import { useSpine } from "@/data/useSpine";
import { Button } from "@/kit/Button";
import { FreshnessBadge, type BankFreshness } from "@/kit/FreshnessBadge";
import type { DataState } from "@/lib/queryState";
import { Note } from "@/kit/Note";
import { Sheet } from "@/kit/Sheet";
import { SkeletonLine } from "@/kit/Skeleton";
import { relativeTime } from "@/lib/dates";
import { cx } from "@/lib/cx";
import { AskFrame } from "./askParts";
import { PROPOSALS_PREFIX, useAiHealth, useAllProposals, useCategoryNames, useConversation, useConversations } from "./askData";
import { BASED_ON, paragraphs, refHref, splitRefs, toolLine } from "./askWords";
import { ProposalCard } from "./ProposalCard";

export const HINT = "Ask about your money. H2 answers from your own records.";
export const SUGGESTIONS = [
  "How much did we spend eating out last month?",
  "Can we spend $300 this weekend and still cover bills?",
  "Which subscriptions haven't I looked at lately?",
] as const;
export const AI_OFF = "Ask needs AI turned on — ";
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
      {based && <span className="type-label text-ink-2">Based on </span>}
      {splitRefs(body).map((p, i) =>
        p.kind === "text" ? (
          <Fragment key={i}>{based ? p.text.replace(/^[\s,;]+|[\s,;]+$/g, " ") : p.text}</Fragment>
        ) : (
          <Link key={i} href={refHref(p.id)} className="type-label text-moss underline decoration-1 underline-offset-4 hover:text-moss-ink" data-testid="answer-ref">
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
    <div className="flex flex-col gap-3 type-body text-ink" data-testid="answer-text">
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
    <div className={cx("flex flex-col gap-1", who === "you" && "items-end")} data-testid={testId}>
      <span className="type-caption text-ink-3">{who === "you" ? "You" : "H2"}</span>
      <div className={cx("max-w-full", who === "you" && "rounded-2 border border-rule-strong bg-paper-1 px-3 py-2 type-body text-ink")}>{children}</div>
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
    <div className="flex flex-col gap-3" data-testid="conversation-list">
      <Button variant="quiet" size="sm" onClick={onNew} className="self-start" data-testid="new-conversation">
        New conversation
      </Button>
      {conversations.length === 0 ? (
        <p className="type-caption text-ink-3">Nothing asked yet.</p>
      ) : (
        <ul>
          {conversations.map((c) => (
            <li key={c.id} className="border-t border-rule first:border-t-0">
              <button
                type="button"
                onClick={() => onPick(c.id)}
                aria-current={c.id === activeId ? "true" : undefined}
                className={cx("flex w-full flex-col gap-0.5 py-2 text-left hover:bg-paper-1", c.id === activeId && "bg-moss-wash")}
                data-testid="conversation-item"
              >
                <span className="truncate type-label text-ink">{c.title?.trim() || "New conversation"}</span>
                <span className="type-caption text-ink-3">{relativeTime(c.lastMessageAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * ⭐ ASK — a question, an answer that streams in, and the records it rests on.
 * H2 answers from your own data through tools; every `$` figure is checked on
 * the server, and a change it suggests is a proposal you approve below the
 * answer. The browser never works out a figure.
 */
export default function Ask() {
  const qc = useQueryClient();
  const health = useAiHealth();
  const spine = useSpine();
  const list = useConversations();
  const createConversation = useCreateAiConversation();
  const proposals = useAllProposals();
  const cats = useCategoryNames();

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
  const listButton = useRef<HTMLButtonElement>(null);

  const aiOff = health.data?.ai?.enabled === false;
  const stored = useMemo(
    () => (detail.data?.messages ?? []).filter((m) => m.role === "user" || m.role === "assistant"),
    [detail.data],
  );
  const names = useMemo(() => new Map((cats.data ?? []).map((c) => [c.id, c.name] as const)), [cats.data]);
  const byRun = useMemo(() => {
    const m = new Map<string, AgentProposal[]>();
    for (const p of proposals.data?.proposals ?? []) m.set(p.runId, [...(m.get(p.runId) ?? []), p]);
    return m;
  }, [proposals.data]);

  const storedAssistants = stored.filter((m) => m.role === "assistant").length;
  const showUserOverlay = pending != null && stored.length <= pending.baseCount;
  const showAnswerOverlay = pending != null && storedAssistants <= pending.assistantBefore;

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
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

    const result = await streamAnswer({
      conversationId: id,
      text: question,
      userAskedToChange: changeAsked,
      onToken: (t) => setPending((p) => (p ? { ...p, streamed: p.streamed + t } : p)),
      onTool: (name, status) => setPending((p) => (p ? { ...p, tool: status === "running" ? name : null } : p)),
    });

    setPhase("finishing");
    if (result.kind === "done") {
      setPending((p) => (p ? { ...p, streamed: result.done.text, tool: null } : p));
      if (changeAsked) invalidateAfterWrite(qc);
    } else if (result.kind === "error") {
      setFailure({ message: result.message, code: result.code });
    } else {
      setPending((p) => (p ? { ...p, tool: null } : p));
      const convId = id;
      const found = await pollForAnswer({ assistantBefore, getDetail: () => getAiConversation(convId) });
      if (!found) setFailure({ message: "H2 lost the connection before the answer arrived. Open the conversation again in a moment.", code: "dropped" });
    }
    await Promise.all([
      qc.refetchQueries({ queryKey: getGetAiConversationQueryKey(id) }),
      qc.invalidateQueries({ queryKey: getListAiConversationsQueryKey({ limit: 20 }) }),
      qc.invalidateQueries({ queryKey: PROPOSALS_PREFIX }),
    ]);
    setPending(null);
    setPhase("idle");
  };

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

  const conversations = list.data?.conversations ?? [];
  const bank = spine.data?.bank;
  const model: AskModel = {
    conversations,
    activeId,
    stored,
    loadingThread: activeId != null && detail.data == null && !detail.isError,
    names,
    byRun,
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
    pick,
    startNew,
    listOpen,
    setListOpen,
    input,
    end,
    listButton,
    bank,
    spineState: spine.state,
  };
  return <AskView m={model} />;
}

export interface AskModel {
  conversations: readonly AiConversation[];
  activeId: string | null;
  stored: readonly AiMessage[];
  loadingThread: boolean;
  names: ReadonlyMap<string, string>;
  byRun: ReadonlyMap<string, AgentProposal[]>;
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
  pick: (id: string) => void;
  startNew: () => void;
  listOpen: boolean;
  setListOpen: (b: boolean) => void;
  input: RefObject<HTMLTextAreaElement | null>;
  end: RefObject<HTMLDivElement | null>;
  listButton: RefObject<HTMLButtonElement | null>;
  bank: BankFreshness | null | undefined;
  spineState: DataState;
}

/** The screen on a model it is handed: the real page and the public sample both render this. */
export function AskView({ m }: { m: AskModel }) {
  const { conversations, activeId, stored, loadingThread, names, byRun, pending, showUserOverlay, showAnswerOverlay, failure, aiOff, typed, setTyped, asked, setAsked, phase, pick, startNew, listOpen, setListOpen, input, end, listButton, bank, spineState } = m;
  const empty = stored.length === 0 && pending == null;
  const index = <ConversationList conversations={conversations} activeId={activeId} onPick={pick} onNew={startNew} />;
  const send = (_: string) => m.send();
  const spine = { state: spineState };

  return (
    <AskFrame current="ask">
      <div className="flex flex-col gap-4" data-testid="ask">
        {bank?.stale && (
          <div data-testid="ask-fresh">
            <FreshnessBadge bank={bank} state={spine.state} />
          </div>
        )}
        <div className="md:grid md:grid-cols-[12rem_1fr] md:gap-8">
          <aside className="hidden md:block" aria-label="Conversations" data-testid="conversation-index">
            {index}
          </aside>
          <div className="flex min-w-0 flex-col gap-6">
            <div className="md:hidden">
              <Button ref={listButton} variant="quiet" size="sm" onClick={() => setListOpen(true)} data-testid="open-conversations">
                Conversations
              </Button>
              <Sheet open={listOpen} onOpenChange={setListOpen} title="Conversations" returnFocusRef={listButton}>
                {index}
              </Sheet>
            </div>

            <div className="flex min-h-48 flex-col gap-6" data-testid="thread" aria-live="polite">
              {loadingThread ? (
                <div aria-busy="true" className="flex flex-col gap-3" data-testid="thread-skeleton">
                  <SkeletonLine className="w-64" />
                  <SkeletonLine className="w-48" />
                </div>
              ) : empty ? (
                <p className="type-body text-ink-2" data-testid="thread-empty">
                  {HINT}
                </p>
              ) : null}
              {stored.map((m) => (
                <Fragment key={m.id}>
                  {m.role === "user" ? (
                    <Bubble who="you" testId="msg-user">
                      <p className="whitespace-pre-line">{textOf(m)}</p>
                    </Bubble>
                  ) : (
                    <Bubble who="h2" testId="msg-assistant">
                      <AnswerText text={textOf(m)} />
                      {(m.content as { grounded?: unknown }).grounded === false && (
                        <p className="mt-2 type-caption text-ink-3">H2 could not check every figure in this answer.</p>
                      )}
                      {m.runId && (byRun.get(m.runId) ?? []).map((p) => <ProposalCard key={p.id} proposal={p} categories={names} />)}
                    </Bubble>
                  )}
                </Fragment>
              ))}
              {pending && showUserOverlay && (
                <Bubble who="you" testId="msg-user-pending">
                  <p className="whitespace-pre-line">{pending.question}</p>
                </Bubble>
              )}
              {pending && showAnswerOverlay && !failure && (
                <Bubble who="h2" testId="msg-assistant-pending">
                  {pending.streamed ? <AnswerText text={pending.streamed} /> : null}
                  {pending.tool ? (
                    <p className="type-caption text-ink-3" data-testid="tool-line">
                      {toolLine(pending.tool)}
                    </p>
                  ) : !pending.streamed ? (
                    <p className="type-caption text-ink-3" data-testid="thinking">
                      Thinking…
                    </p>
                  ) : null}
                </Bubble>
              )}
              {failure && (
                <Note
                  kind="error"
                  data-testid="ask-failure"
                  action={
                    failure.code === "budget_exceeded" ? (
                      <Link href="/household/ai" className="type-label text-moss underline decoration-1 underline-offset-4">
                        AI cost
                      </Link>
                    ) : undefined
                  }
                >
                  {failure.message}
                </Note>
              )}
              <div ref={end} />
            </div>

            {empty && !aiOff && (
              <ul className="flex flex-wrap gap-2" aria-label="Suggested questions" data-testid="suggestions">
                {SUGGESTIONS.map((s) => (
                  <li key={s}>
                    <button
                      type="button"
                      onClick={() => {
                        setTyped(s);
                        input.current?.focus();
                      }}
                      className="rounded-1 border border-rule-strong px-3 py-2 text-left type-caption text-ink-2 hover:bg-paper-1"
                      data-testid="suggestion"
                    >
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <form
              className="flex flex-col gap-2 border-t border-rule pt-4"
              onSubmit={(e) => {
                e.preventDefault();
                void send(typed);
              }}
              data-testid="composer"
            >
              {aiOff && (
                <Note kind="empty" data-testid="ask-ai-off">
                  {AI_OFF}
                  <Link href="/household/ai" className="text-moss underline decoration-1 underline-offset-4">
                    Household › AI
                  </Link>
                </Note>
              )}
              <label htmlFor="ask-input" className="sr-only">
                Your question
              </label>
              <textarea
                id="ask-input"
                ref={input}
                rows={2}
                maxLength={MAX_LEN}
                value={typed}
                disabled={aiOff || phase !== "idle"}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send(typed);
                  }
                }}
                className="w-full resize-none rounded-1 border border-rule-strong bg-paper-0 px-3 py-2 type-body text-ink placeholder:text-ink-3 disabled:bg-paper-1 disabled:text-ink-3"
                placeholder={aiOff ? "" : "Ask a question"}
                data-testid="ask-input"
              />
              <p className="type-caption text-ink-3">{HINT}</p>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <label className="flex items-center gap-2 type-caption text-ink-2">
                  <input
                    type="checkbox"
                    checked={asked}
                    disabled={aiOff || phase !== "idle"}
                    onChange={(e) => setAsked(e.target.checked)}
                    data-testid="ask-may-change"
                  />
                  Let H2 file charges I name in this message
                </label>
                <Button type="submit" variant="primary" disabled={aiOff || phase !== "idle" || typed.trim() === ""} data-testid="ask-send">
                  {phase === "idle" ? "Ask" : "Asking…"}
                </Button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </AskFrame>
  );
}
