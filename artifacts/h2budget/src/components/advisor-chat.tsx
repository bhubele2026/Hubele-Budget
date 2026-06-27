import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import {
  postAdvisorChat,
  postAdvisorUndo,
  postAdvisorProposalConfirm,
  postAdvisorProposalCancel,
  useGetAdvisorNudge,
  type AdvisorChatMessage,
  type AdvisorToolCall,
} from "@workspace/api-client-react";
import { X, Send, Loader2, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { subscribeOpenWithContext } from "@/lib/advisorChatBridge";

function AnthropicLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 92 65"
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M66.04 0L92 65h-19.5l-5.3-13.92H40.5L35.21 65H15.7L41.66 0h24.39zm-11.5 35.99l-5.34-13.9-5.32 13.9h10.66z" />
      <path d="M0 65L25.96 0h13.32L13.32 65H0z" />
    </svg>
  );
}

interface DisplayedMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls?: AdvisorToolCall[];
  // For undo state, we need to know when the message was added so we can
  // expire the Undo button after 5 minutes.
  createdAt?: number;
}

const CLIENT_HISTORY_CAP = 12;
const UNDO_WINDOW_MS = 5 * 60 * 1000;

export function AdvisorChat() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<DisplayedMessage[]>([]);
  // (#802 — Phase E) Context block prepended to the NEXT user
  // message we send. Set when another part of the app opened the
  // chat with `openAdvisorChatWithContext` (e.g. "Dig deeper" on the
  // Weekly Debrief). Cleared after the first send so it doesn't
  // contaminate every subsequent turn.
  const [pendingContext, setPendingContext] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reuse the nudge endpoint as a feature-flag check.
  const { data: nudge } = useGetAdvisorNudge();

  const mutation = useMutation({
    mutationFn: async (vars: { message: string; history: AdvisorChatMessage[] }) => {
      return postAdvisorChat({ message: vars.message, history: vars.history });
    },
    onSuccess: (res) => {
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: res.message,
          toolCalls: res.toolCalls,
          createdAt: Date.now(),
        },
      ]);
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Something went wrong";
      setMessages((m) => [
        ...m,
        { role: "assistant", content: `Sorry — ${msg}. Try again in a moment.` },
      ]);
    },
  });

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, mutation.isPending]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // (#802 — Phase E) Listen for external "open the chat with this
  // context" requests. Opens the panel, stages the context block,
  // and pre-fills the composer so the user can edit-and-send.
  useEffect(() => {
    return subscribeOpenWithContext((ctx) => {
      setOpen(true);
      if (ctx.contextBlock) setPendingContext(ctx.contextBlock);
      if (ctx.prompt) setDraft(ctx.prompt);
      // Focus runs in the next tick once the panel mounts.
      setTimeout(() => inputRef.current?.focus(), 0);
    });
  }, []);

  if (!nudge?.enabled) return null;

  const send = () => {
    const text = draft.trim();
    if (!text || mutation.isPending) return;
    // If a context block was staged (Dig deeper from the debrief),
    // prepend it once to the OUTGOING message only. We still show
    // the user's plain text in the bubble so the transcript stays
    // readable; the model sees both.
    const outgoing = pendingContext
      ? `Context:\n${pendingContext}\n\nQuestion: ${text}`
      : text;
    const next: DisplayedMessage[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setDraft("");
    setPendingContext(null);
    const history: AdvisorChatMessage[] = messages.slice(-CLIENT_HISTORY_CAP).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    mutation.mutate({ message: outgoing, history });
  };

  return (
    <>
      {!open && (
        <Button
          onClick={() => setOpen(true)}
          style={{ position: "fixed", bottom: "1.5rem", right: "1.5rem", zIndex: 40 }}
          className="h-12 w-12 rounded-full shadow-lg"
          aria-label="Open advisor"
          data-testid="advisor-launcher"
        >
          <AnthropicLogo className="w-5 h-5" />
        </Button>
      )}

      {open && (
        <Card
          style={{ position: "fixed", bottom: "1.5rem", right: "1.5rem", zIndex: 40 }}
          className="shadow-2xl flex flex-col
                     w-[calc(100vw-3rem)] max-w-md
                     h-[min(70vh,640px)]"
          data-testid="advisor-panel"
        >
          <div className="flex items-center justify-between px-4 py-3 border-b">
            <div className="flex flex-col leading-tight">
              <span className="font-semibold text-sm">Budget Advisor</span>
              <span className="text-[11px] text-muted-foreground">
                Sees your live numbers
              </span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setOpen(false)}
              aria-label="Close advisor"
              data-testid="advisor-close"
            >
              <X className="w-4 h-4" />
            </Button>
          </div>

          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto px-4 py-3 space-y-3"
            data-testid="advisor-messages"
          >
            {messages.length === 0 && (
              <div className="text-sm text-muted-foreground space-y-2">
                <p>Ask anything about your household's budget. For example:</p>
                <ul className="list-disc pl-5 space-y-1 text-xs">
                  <li>Where are we overspending this month?</li>
                  <li>Can we afford a $400 unplanned expense this week?</li>
                  <li>Which debt should we kill first?</li>
                  <li>On pace for what net by month-end?</li>
                </ul>
              </div>
            )}
            {messages.map((m, i) => (
              <MessageBubble
                key={i}
                role={m.role}
                content={m.content}
                toolCalls={m.toolCalls}
                createdAt={m.createdAt}
              />
            ))}
            {mutation.isPending && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>Thinking…</span>
              </div>
            )}
          </div>

          <div className="border-t px-3 py-3 flex items-end gap-2">
            <Input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder="Ask about your budget…"
              maxLength={4000}
              disabled={mutation.isPending}
              data-testid="advisor-input"
            />
            <Button
              onClick={send}
              disabled={!draft.trim() || mutation.isPending}
              size="icon"
              aria-label="Send"
              data-testid="advisor-send"
            >
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </Card>
      )}
    </>
  );
}

function MessageBubble({ role, content, toolCalls, createdAt }: DisplayedMessage) {
  return (
    <div className={cn("flex flex-col", role === "user" ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap",
          role === "user"
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-foreground",
        )}
      >
        {content}
      </div>
      {toolCalls && toolCalls.length > 0 && (
        <div
          className="flex flex-wrap gap-1.5 mt-1.5 max-w-[85%]"
          data-testid="advisor-tool-pills"
        >
          {toolCalls.map((tc, i) => (
            <ToolCallPill key={i} call={tc} messageCreatedAt={createdAt ?? Date.now()} />
          ))}
        </div>
      )}
    </div>
  );
}

type LocalPillState =
  | { kind: "pending_proposal" } // model proposed, awaiting user
  | { kind: "confirming" }       // user clicked Confirm, in-flight
  | { kind: "cancelling" }       // user clicked Cancel, in-flight
  | { kind: "confirmed"; auditLogId?: string; executedSummary?: string } // after confirm succeeded
  | { kind: "cancelled" }
  | { kind: "expired" }          // 15 min passed without action
  | { kind: "undone" }
  | { kind: "idle" };            // non-proposal pill, default

function ToolCallPill({
  call,
  messageCreatedAt,
}: {
  call: AdvisorToolCall;
  messageCreatedAt: number;
}) {
  // Initial state: proposal → pending_proposal; else idle.
  const initialState: LocalPillState = call.proposal
    ? { kind: "pending_proposal" }
    : { kind: "idle" };
  const [state, setState] = useState<LocalPillState>(initialState);
  const [now, setNow] = useState(() => Date.now());

  // Effective auditLogId may come from the original call OR from a
  // successful confirmation; resolve here so the undo button can use it.
  const effectiveAuditLogId =
    state.kind === "confirmed" ? state.auditLogId : call.auditLogId;
  const effectiveSummary =
    state.kind === "confirmed" && state.executedSummary
      ? state.executedSummary
      : call.summary;

  const undoMutation = useMutation({
    mutationFn: async () => {
      if (!effectiveAuditLogId) throw new Error("No auditLogId");
      return postAdvisorUndo(effectiveAuditLogId);
    },
    onSuccess: () => setState({ kind: "undone" }),
  });

  const confirmMutation = useMutation({
    mutationFn: async () => {
      if (!call.proposal) throw new Error("No proposal");
      return postAdvisorProposalConfirm(call.proposal.id);
    },
    onMutate: () => setState({ kind: "confirming" }),
    onSuccess: (res) => {
      setState({
        kind: "confirmed",
        auditLogId: res.auditLogId,
      });
    },
    onError: () => setState({ kind: "pending_proposal" }), // let user retry
  });

  const cancelMutation = useMutation({
    mutationFn: async () => {
      if (!call.proposal) throw new Error("No proposal");
      return postAdvisorProposalCancel(call.proposal.id);
    },
    onMutate: () => setState({ kind: "cancelling" }),
    onSuccess: () => setState({ kind: "cancelled" }),
    onError: () => setState({ kind: "pending_proposal" }),
  });

  // Tick once a second so the undo / proposal-expiry windows update live.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);

  // Auto-expire pending proposals at the 15-minute server-side deadline.
  // We use the message createdAt as the anchor since the proposal was
  // created during the chat turn that produced this message.
  const PROPOSAL_EXPIRY_MS = 15 * 60 * 1000;
  useEffect(() => {
    if (state.kind !== "pending_proposal") return;
    if (now - messageCreatedAt > PROPOSAL_EXPIRY_MS) {
      setState({ kind: "expired" });
    }
  }, [state.kind, now, messageCreatedAt]);

  // ----- Render: pending proposal → confirmation card -----
  if (state.kind === "pending_proposal" || state.kind === "confirming" || state.kind === "cancelling") {
    return (
      <div
        className="w-full max-w-md p-3 rounded-md border border-warning/30 bg-warning/10 text-foreground"
        data-testid="advisor-proposal-card"
      >
        <div className="text-[11px] uppercase tracking-widest font-semibold mb-1">
          Confirm action
        </div>
        <div className="text-sm leading-relaxed mb-3">
          {call.proposal?.summary ?? call.summary}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="px-3 py-1 text-xs rounded-md bg-warning text-warning-foreground hover:bg-warning/90 disabled:opacity-50"
            disabled={state.kind !== "pending_proposal"}
            onClick={() => confirmMutation.mutate()}
            data-testid="advisor-proposal-confirm"
          >
            {state.kind === "confirming" ? "Confirming…" : "Confirm"}
          </button>
          <button
            type="button"
            className="px-3 py-1 text-xs rounded-md border border-warning/50 text-foreground hover:bg-warning/10 disabled:opacity-50"
            disabled={state.kind !== "pending_proposal"}
            onClick={() => cancelMutation.mutate()}
            data-testid="advisor-proposal-cancel"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (state.kind === "cancelled") {
    return (
      <div
        className="inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-full border bg-muted border-muted text-muted-foreground"
        data-testid="advisor-tool-pill"
      >
        <X className="w-3 h-3" />
        <span>Cancelled: {call.name}</span>
      </div>
    );
  }
  if (state.kind === "expired") {
    return (
      <div
        className="inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-full border bg-muted border-muted text-muted-foreground"
        data-testid="advisor-tool-pill"
      >
        <X className="w-3 h-3" />
        <span>Expired: {call.name}</span>
      </div>
    );
  }

  // ----- Render: executed pill (idle or confirmed) with optional undo -----
  const undone = state.kind === "undone";
  const inUndoWindow = now - messageCreatedAt < UNDO_WINDOW_MS;
  const canUndo = call.ok && !!effectiveAuditLogId && inUndoWindow && !undone;
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-full border",
        undone
          ? "bg-muted text-muted-foreground border-muted line-through"
          : call.ok
          ? "bg-positive/10 border-positive/30 text-positive"
          : "bg-destructive/5 border-destructive/30 text-destructive",
      )}
      title={call.name}
      data-testid="advisor-tool-pill"
    >
      {call.ok ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
      <span>{effectiveSummary}</span>
      {canUndo && (
        <button
          type="button"
          className="ml-1 underline underline-offset-2 hover:text-positive disabled:opacity-50"
          disabled={undoMutation.isPending}
          onClick={() => undoMutation.mutate()}
          data-testid="advisor-tool-undo"
        >
          {undoMutation.isPending ? "undoing…" : "undo"}
        </button>
      )}
      {undone && <span>(undone)</span>}
    </div>
  );
}
