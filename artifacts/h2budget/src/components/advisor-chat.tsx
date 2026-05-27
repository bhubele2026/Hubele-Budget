import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import {
  postAdvisorChat,
  useGetAdvisorNudge,
  type AdvisorChatMessage,
} from "@workspace/api-client-react";
import { MessageSquare, X, Send, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface DisplayedMessage {
  role: "user" | "assistant";
  content: string;
}

const CLIENT_HISTORY_CAP = 12;

export function AdvisorChat() {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<DisplayedMessage[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reuse the nudge endpoint as a feature-flag check.
  const { data: nudge } = useGetAdvisorNudge();

  const mutation = useMutation({
    mutationFn: async (vars: { message: string; history: AdvisorChatMessage[] }) => {
      return postAdvisorChat({ message: vars.message, history: vars.history });
    },
    onSuccess: (res) => {
      setMessages((m) => [...m, { role: "assistant", content: res.message }]);
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

  if (!nudge?.enabled) return null;

  const send = () => {
    const text = draft.trim();
    if (!text || mutation.isPending) return;
    const next: DisplayedMessage[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setDraft("");
    const history: AdvisorChatMessage[] = messages.slice(-CLIENT_HISTORY_CAP).map((m) => ({
      role: m.role,
      content: m.content,
    }));
    mutation.mutate({ message: text, history });
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
          <MessageSquare className="w-5 h-5" />
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
              <MessageBubble key={i} role={m.role} content={m.content} />
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

function MessageBubble({ role, content }: DisplayedMessage) {
  return (
    <div className={cn("flex", role === "user" ? "justify-end" : "justify-start")}>
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
    </div>
  );
}
