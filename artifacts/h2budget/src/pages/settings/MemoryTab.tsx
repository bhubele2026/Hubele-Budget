import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListMemoryQueryKey,
  useDeleteMemory,
  useListMemory,
  usePutMemory,
  type MemoryItem,
} from "@workspace/api-client-react/features";
import { PageGrid, Panel } from "@/components/next";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { OWN_INVALIDATION } from "@/lib/mutationInvalidation";
import { dataState, type DataState } from "@/lib/queryState";
import { relativeTime } from "@/lib/dates";
import { apiMessage } from "@/lib/apiMessage";
import { SCOPE_ORDER, SCOPE_WORD, SOURCE_WORD, keyWords, refHref } from "@/lib/askWords";
import { Foot, btn, btnDanger, btnLink, btnLinkDanger, btnSecondary, emptyNote, fieldLabel, input } from "@/ui";
import { RetryNote, StatusChip, TabSkeleton } from "./parts";

export const NEVER_STORED = "H2 never stores account numbers or balances here.";
const MAX = 300;
const LIVE = { staleTime: 30_000, gcTime: 10 * 60_000 } as const;

const textOf = (m: MemoryItem): string => {
  const t = (m.value as { text?: unknown }).text;
  return typeof t === "string" ? t : "";
};
/** Evidence the server attached to a note: charge ids it was drawn from. */
const evidenceOf = (m: MemoryItem): string[] => {
  const e = (m.value as { evidence?: unknown; refs?: unknown }).evidence ?? (m.value as { refs?: unknown }).refs;
  return Array.isArray(e) ? e.filter((x): x is string => typeof x === "string") : [];
};

export interface MemoryRead {
  data: MemoryItem[] | undefined;
  state: DataState;
  isFetching: boolean;
  refetch: () => unknown;
}

export default function MemoryTab() {
  const q = useListMemory({ query: { queryKey: getListMemoryQueryKey(), ...LIVE } });
  return (
    <MemoryView memories={{ data: q.data?.memories, state: dataState(q), isFetching: q.isFetching, refetch: q.refetch }} />
  );
}

/**
 * ⭐ (F8) SETTINGS › MEMORY — what H2 remembers: every note it keeps, by
 * topic, in words. Edit one and H2 uses the new words; forget one and it
 * leaves every answer. Nothing here is an account number or a balance. Both
 * writes move no money and opt out of the app-wide refresh. Ported from h2's
 * `ask/AskMemory.tsx`.
 */
export function MemoryView({ memories, now }: { memories: MemoryRead; now?: Date }) {
  const qc = useQueryClient();
  const put = usePutMemory({ mutation: { meta: OWN_INVALIDATION } });
  const del = useDeleteMemory({ mutation: { meta: OWN_INVALIDATION } });
  const { toast } = useToast();
  const [editing, setEditing] = useState<MemoryItem | null>(null);
  const [draft, setDraft] = useState("");
  const [forgetting, setForgetting] = useState<MemoryItem | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: getListMemoryQueryKey() });

  const groups = SCOPE_ORDER.map((scope) => ({
    scope,
    items: (memories.data ?? []).filter((m) => m.scope === scope),
  })).filter((g) => g.items.length > 0);

  const startEdit = (m: MemoryItem) => {
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
      toast({ title: "Saved. H2 will use your words." });
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
      toast({ title: "Forgotten." });
      refresh();
    } catch (e) {
      setForgetting(null);
      toast({ title: apiMessage(e, "Couldn't forget that. Nothing changed."), variant: "destructive" });
    }
  };

  let body;
  if (memories.state === "cold") {
    body = (
      <Panel title="What H2 remembers" span={12} variant={["static", "flush"]}>
        <TabSkeleton testId="memory-skeleton" rows={2} />
      </Panel>
    );
  } else if (memories.state === "failed") {
    body = (
      <Panel title="What H2 remembers" span={12} variant={["static", "flush"]}>
        <RetryNote onRetry={() => void memories.refetch()} retrying={memories.isFetching} data-testid="memory-error">
          Couldn't load what H2 remembers.
        </RetryNote>
      </Panel>
    );
  } else if (groups.length === 0) {
    body = (
      <Panel title="What H2 remembers" span={12} variant={["static", "flush"]}>
        <p className={emptyNote} data-testid="memory-empty">
          H2 hasn't kept any notes yet. Tell it a preference in{" "}
          <Link href="/ask" className="font-semibold text-brand-navy underline underline-offset-2">
            Ask
          </Link>
          .
        </p>
      </Panel>
    );
  } else {
    body = groups.map((g) => (
      <Panel
        key={g.scope}
        title={SCOPE_WORD[g.scope]}
        span={6}
        variant={["static", "flush"]}
        data-testid={`memory-${g.scope}`}
      >
        <ul className="divide-y divide-brand-line/70">
          {g.items.map((m) => (
            <li key={m.id} className="flex flex-col gap-1 px-4 py-3" data-testid="memory-item">
              <div className="flex items-baseline justify-between gap-4">
                <span className={fieldLabel}>{keyWords(m.key)}</span>
                <StatusChip tone={m.source === "user_stated" ? "fresh" : "neutral"}>{SOURCE_WORD[m.source]}</StatusChip>
              </div>
              <p className="text-body text-brand-ink" data-testid="memory-value">
                {textOf(m)}
              </p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="text-micro text-neutral-500">Updated {relativeTime(m.updatedAt, now)}</span>
                {evidenceOf(m).map((id, i) => (
                  <Link
                    key={id}
                    href={refHref(id)}
                    className="text-micro font-semibold text-brand-navy underline underline-offset-2"
                    data-testid="memory-evidence"
                  >
                    {`Charge ${i + 1}`}
                  </Link>
                ))}
                <button type="button" className={btnLink} onClick={() => startEdit(m)} data-testid="memory-edit">
                  Edit
                </button>
                <button type="button" className={btnLinkDanger} onClick={() => setForgetting(m)} data-testid="memory-delete">
                  Forget
                </button>
              </div>
            </li>
          ))}
        </ul>
      </Panel>
    ));
  }

  return (
    <PageGrid className="items-start" data-testid="memory">
      {body}
      <div className="span-12">
        <Foot className="border-t-0 px-0" data-testid="memory-foot">
          {NEVER_STORED}
        </Foot>
      </div>

      <Dialog open={editing != null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent data-testid="memory-edit-dialog">
          <DialogHeader>
            <DialogTitle>{editing ? keyWords(editing.key) : "Edit"}</DialogTitle>
            <DialogDescription>H2 uses these words from now on.</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
            data-testid="memory-edit-form"
          >
            <label className="flex flex-col gap-1">
              <span className={fieldLabel}>What H2 remembers</span>
              <textarea
                rows={4}
                maxLength={MAX}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className={`${input} resize-none`}
                aria-invalid={error ? true : undefined}
                data-testid="memory-edit-input"
              />
              {error ? (
                <span className="text-micro text-bad" role="alert">
                  {error}
                </span>
              ) : (
                <span className="text-micro text-neutral-500">{MAX} characters at most.</span>
              )}
            </label>
            <div className="flex gap-2">
              <button type="submit" className={btn} disabled={put.isPending} data-testid="memory-save">
                Save
              </button>
              <button type="button" className={btnSecondary} onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={forgetting != null} onOpenChange={(o) => !o && setForgetting(null)}>
        <AlertDialogContent data-testid="memory-forget-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Forget this?</AlertDialogTitle>
            <AlertDialogDescription>
              {forgetting ? `${keyWords(forgetting.key)}: ${textOf(forgetting)}. ` : ""}H2 stops using it in every answer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <button
              type="button"
              className={btnDanger}
              onClick={() => void forget()}
              disabled={del.isPending}
              data-testid="memory-forget-yes"
            >
              Forget it
            </button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageGrid>
  );
}
