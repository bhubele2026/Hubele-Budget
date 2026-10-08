import { useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { getListMemoryQueryKey, useDeleteMemory, usePutMemory, type MemoryItem } from "@workspace/api-client-react";
import { readOf, type Read } from "@/data/todayData";
import { OWN_INVALIDATION } from "@/data/mutationInvalidation";
import { Button } from "@/kit/Button";
import { Note } from "@/kit/Note";
import { Section } from "@/kit/Section";
import { Sheet } from "@/kit/Sheet";
import { SkeletonLine } from "@/kit/Skeleton";
import { StatusWord } from "@/kit/StatusWord";
import { relativeTime } from "@/lib/dates";
import { apiMessage } from "@/screens/household/words";
import { Field, inputClass, useToast } from "@/screens/plan/parts";
import { AskFrame } from "./askParts";
import { useMemoryList } from "./askData";
import { keyWords, refHref, SCOPE_ORDER, SCOPE_WORD, SOURCE_WORD } from "./askWords";

export const NEVER_STORED = "H2 never stores account numbers or balances here.";
const MAX = 300;

const textOf = (m: MemoryItem): string => {
  const t = (m.value as { text?: unknown }).text;
  return typeof t === "string" ? t : "";
};
/** Evidence the server attached to a note: charge ids it was drawn from. */
const evidenceOf = (m: MemoryItem): string[] => {
  const e = (m.value as { evidence?: unknown; refs?: unknown }).evidence ?? (m.value as { refs?: unknown }).refs;
  return Array.isArray(e) ? e.filter((x): x is string => typeof x === "string") : [];
};

export default function AskMemory() {
  const q = useMemoryList();
  const r = readOf(q);
  return <MemoryView memories={{ ...r, data: q.data?.memories }} />;
}

/**
 * ⭐ WHAT H2 REMEMBERS — every note it keeps, by topic, in words. Edit one and
 * H2 uses the new words; forget one and it leaves every answer. Nothing here is
 * an account number or a balance.
 */
export function MemoryView({ memories, now }: { memories: Read<MemoryItem[]>; now?: Date }) {
  const qc = useQueryClient();
  const put = usePutMemory({ mutation: { meta: OWN_INVALIDATION } });
  const del = useDeleteMemory({ mutation: { meta: OWN_INVALIDATION } });
  const { say, node: toast } = useToast();
  const [editing, setEditing] = useState<MemoryItem | null>(null);
  const [draft, setDraft] = useState("");
  const [forgetting, setForgetting] = useState<MemoryItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const returnRef = useRef<HTMLElement | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: getListMemoryQueryKey() });

  const groups = SCOPE_ORDER.map((scope) => ({ scope, items: (memories.data ?? []).filter((m) => m.scope === scope) })).filter((g) => g.items.length > 0);

  const startEdit = (m: MemoryItem, el: HTMLElement) => {
    returnRef.current = el;
    setEditing(m);
    setDraft(textOf(m));
    setError(null);
  };
  const save = async () => {
    const m = editing;
    const value = draft.trim();
    if (!m) return;
    if (!value) return setError("Write something, or forget this note instead.");
    if (value.length > MAX) return setError(`Keep it to ${MAX} characters.`);
    try {
      await put.mutateAsync({ scope: m.scope, key: m.key, data: { value, ...(m.memberUserId ? { mine: true } : {}) } });
      setEditing(null);
      say("Saved. H2 will use your words.");
      refresh();
    } catch (e) {
      setError(apiMessage(e, "Couldn't save that. Nothing changed."));
    }
  };
  const forget = async () => {
    const m = forgetting;
    if (!m) return;
    try {
      await del.mutateAsync({ id: m.id });
      setForgetting(null);
      say("Forgotten.");
      refresh();
    } catch (e) {
      setForgetting(null);
      say(apiMessage(e, "Couldn't forget that. Nothing changed."), "error");
    }
  };

  return (
    <AskFrame current="memory">
      <div className="flex flex-col" data-testid="memory">
        {memories.state === "cold" ? (
          <div aria-busy="true" className="flex flex-col gap-3" data-testid="memory-skeleton">
            <SkeletonLine className="w-48" />
            <SkeletonLine className="w-64" />
          </div>
        ) : memories.state === "failed" ? (
          <Note kind="error" onRetry={memories.refetch} retrying={memories.isFetching}>
            Couldn't load what H2 remembers.
          </Note>
        ) : groups.length === 0 ? (
          <Note kind="empty" data-testid="memory-empty">
            H2 hasn't kept any notes yet. Tell it a preference in{" "}
            <Link href="/ask" className="text-moss underline decoration-1 underline-offset-4">
              Ask
            </Link>
            .
          </Note>
        ) : (
          groups.map((g) => (
            <Section key={g.scope} label={SCOPE_WORD[g.scope]} data-testid={`memory-${g.scope}`}>
              <ul>
                {g.items.map((m) => (
                  <li key={m.id} className="flex flex-col gap-1 border-t border-rule py-3 first:border-t-0" data-testid="memory-item">
                    <div className="flex items-baseline justify-between gap-4">
                      <span className="type-label text-ink-2">{keyWords(m.key)}</span>
                      <StatusWord tone={m.source === "user_stated" ? "fresh" : "neutral"}>{SOURCE_WORD[m.source]}</StatusWord>
                    </div>
                    <p className="type-body text-ink" data-testid="memory-value">
                      {textOf(m)}
                    </p>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      <span className="type-caption text-ink-3">Updated {relativeTime(m.updatedAt, now)}</span>
                      {evidenceOf(m).map((id, i) => (
                        <Link key={id} href={refHref(id)} className="type-caption text-moss underline decoration-1 underline-offset-4" data-testid="memory-evidence">
                          {`Charge ${i + 1}`}
                        </Link>
                      ))}
                      <Button variant="link" size="sm" onClick={(e) => startEdit(m, e.currentTarget)} data-testid="memory-edit">
                        Edit
                      </Button>
                      <Button variant="link" size="sm" onClick={() => setForgetting(m)} data-testid="memory-delete">
                        Forget
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          ))
        )}
        <p className="border-t border-rule pt-4 type-caption text-ink-3" data-testid="memory-foot">
          {NEVER_STORED}
        </p>
      </div>

      <Sheet open={editing != null} onOpenChange={(o) => !o && setEditing(null)} title={editing ? keyWords(editing.key) : "Edit"} description="H2 uses these words from now on." returnFocusRef={returnRef}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          data-testid="memory-edit-form"
        >
          <Field label="What H2 remembers" error={error} hint={`${MAX} characters at most.`}>
            {(a) => (
              <textarea {...a} rows={4} maxLength={MAX} value={draft} onChange={(e) => setDraft(e.target.value)} className={`${inputClass} h-auto py-2`} data-testid="memory-edit-input" />
            )}
          </Field>
          <div className="flex gap-3">
            <Button type="submit" variant="primary" disabled={put.isPending} data-testid="memory-save">
              Save
            </Button>
            <Button variant="quiet" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </form>
      </Sheet>
      <Sheet open={forgetting != null} onOpenChange={(o) => !o && setForgetting(null)} title="Forget this?" description={forgetting ? `${keyWords(forgetting.key)}: ${textOf(forgetting)}` : undefined}>
        <div className="flex flex-col gap-4" data-testid="memory-forget-confirm">
          <p className="type-body text-ink-2">H2 stops using it in every answer.</p>
          <div className="flex gap-3">
            <Button variant="danger" onClick={forget} disabled={del.isPending} data-testid="memory-forget-yes">
              Forget it
            </Button>
            <Button variant="quiet" onClick={() => setForgetting(null)}>
              Keep it
            </Button>
          </div>
        </div>
      </Sheet>
      {toast}
    </AskFrame>
  );
}
