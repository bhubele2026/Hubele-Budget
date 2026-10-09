import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListWishlistQueryKey,
  useCreateWishlistItem,
  useEvaluateWishlistItem,
  useListWishlist,
  useUpdateWishlistItem,
  type WishlistEvaluation,
  type WishlistItem,
} from "@workspace/api-client-react/features";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PageGrid, Panel } from "@/components/next";
import { AffordLauncher } from "@/components/afford/AffordLauncher";
import { btn, btnLink, btnSecondary, emptyNote, fieldLabel, input } from "@/ui";
import { OWN_INVALIDATION } from "@/lib/mutationInvalidation";
import { useToast } from "@/hooks/use-toast";
import { shortDate, shortDateOfInstant } from "@/lib/dates";
import { centsValue, fmtMoney, toAmount } from "@/lib/money";
import { DECISION, VERDICT, apiMessage, isWebAddress, parseAmount } from "@/lib/afford";

/** A list row may carry the server's stored check (`lastEvaluation`); a check made here shows at once. */
type Row = WishlistItem & { lastEvaluation?: WishlistEvaluation | null };

/**
 * ⭐ WISH LIST — things the household wants, each with the waiting period the
 * server set. Mark one Bought or Dropped when it is decided; a yes waits out
 * its period. Every date and amount is read as the server sent it. (F6)
 */
export default function WishlistPage() {
  const qc = useQueryClient();
  const list = useListWishlist({ query: { queryKey: getListWishlistQueryKey(), staleTime: 60_000, gcTime: 10 * 60_000 } });
  const create = useCreateWishlistItem({ mutation: { meta: OWN_INVALIDATION } });
  const update = useUpdateWishlistItem({ mutation: { meta: OWN_INVALIDATION } });
  const evaluate = useEvaluateWishlistItem({ mutation: { meta: OWN_INVALIDATION } });
  const { toast } = useToast();
  const [checks, setChecks] = useState<Record<string, WishlistEvaluation>>({});
  const [checking, setChecking] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [url, setUrl] = useState("");
  const [tried, setTried] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: getListWishlistQueryKey() });
  const say = (t: string, bad = false) => toast({ title: t, ...(bad ? { variant: "destructive" as const } : {}) });

  const items = list.data?.items ?? [];
  const active = items.filter((i) => i.decision === "pending" || i.decision === "approved");
  const decided = items.filter((i) => i.decision === "bought" || i.decision === "declined");

  const parsed = parseAmount(amount);
  const errors = {
    title: title.trim() ? null : "Say what it is.",
    amount: parsed === "bad" ? "Use dollars, like 120 or 120.50." : null,
    url: url.trim() && !isWebAddress(url.trim()) ? "Use a full web address, starting with https://" : null,
  };
  const add = async () => {
    setTried(true);
    if (errors.title || errors.amount || errors.url) return;
    try {
      await create.mutateAsync({
        data: {
          title: title.trim(),
          ...(typeof parsed === "number" ? { amount: parsed } : {}),
          ...(url.trim() ? { url: url.trim() } : {}),
        },
      });
      setAdding(false);
      setTitle("");
      setAmount("");
      setUrl("");
      setTried(false);
      say("Added. The waiting period has started.");
      refresh();
    } catch (e) {
      say(apiMessage(e, "Couldn't add that. Nothing changed."), true);
    }
  };
  const decide = async (item: WishlistItem, decision: "bought" | "declined") => {
    try {
      await update.mutateAsync({ id: item.id, data: { decision } });
      say(decision === "bought" ? "Marked bought." : "Dropped.");
      refresh();
    } catch (e) {
      const status = (e as { status?: number } | null)?.status;
      say(
        status === 409
          ? `Still in the waiting period. Wait until ${shortDate(item.waitingUntil)}.`
          : apiMessage(e, "Couldn't save that. Nothing changed."),
        true,
      );
    }
  };
  const check = async (item: WishlistItem) => {
    setChecking(item.id);
    try {
      const r = await evaluate.mutateAsync({ id: item.id });
      setChecks((c) => ({ ...c, [item.id]: r.lastEvaluation }));
    } catch (e) {
      say(apiMessage(e, "Couldn't check that. Nothing changed."), true);
    } finally {
      setChecking(null);
    }
  };

  const row = (i: WishlistItem, live: boolean) => {
    const amt = toAmount(i.amount);
    const d = DECISION[i.decision];
    const ev = checks[i.id] ?? (i as Row).lastEvaluation ?? null;
    const evAfter = toAmount(ev?.availableUntilPaydayAfter);
    return (
      <li
        key={i.id}
        className="flex flex-col gap-1 border-t border-brand-line px-4 py-3 first:border-t-0"
        data-testid="wish-item"
        data-decision={i.decision}
      >
        <div className="flex items-baseline justify-between gap-4">
          <span className="min-w-0 truncate text-body font-medium text-brand-navy">{i.title}</span>
          {amt == null ? (
            <span className="text-label text-neutral-400">—</span>
          ) : (
            <data value={centsValue(amt)} className="shrink-0 font-mono text-label font-semibold tabular-nums text-brand-navy">
              {fmtMoney(amt)}
            </data>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-micro text-neutral-500">
          <span data-testid="wish-asked">Asked {shortDateOfInstant(i.requestedAt)}</span>
          {live &&
            (i.waitingDaysLeft > 0 ? (
              <span data-testid="wish-wait">Wait until {shortDate(i.waitingUntil)}</span>
            ) : (
              <span data-testid="wish-wait">Waiting period over</span>
            ))}
          {i.url && isWebAddress(i.url) && (
            <a href={i.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
              Link
            </a>
          )}
          <span className={`chip ${d.chip}`}>{d.word}</span>
        </div>
        {ev && (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-neutral-600" data-testid="wish-eval" data-verdict={ev.verdict}>
            <span className={`chip ${VERDICT[ev.verdict].chip}`} data-testid="wish-eval-word">
              {VERDICT[ev.verdict].word}
            </span>
            <span data-testid="wish-eval-date">evaluated {shortDateOfInstant(ev.evaluatedAt)}</span>
            {evAfter != null && (
              <span data-testid="wish-eval-after">
                free until payday after{" "}
                <data value={centsValue(evAfter)} className="font-mono tabular-nums">
                  {fmtMoney(evAfter)}
                </data>
              </span>
            )}
          </p>
        )}
        {live && (
          <div className="mt-1 flex gap-2">
            {i.decision === "pending" && amt != null && (
              <button type="button" className={btnLink} onClick={() => void check(i)} disabled={checking === i.id} data-testid="wish-check">
                Check now
              </button>
            )}
            <button type="button" className={btnLink} onClick={() => void decide(i, "bought")} disabled={update.isPending} data-testid="wish-bought">
              Bought
            </button>
            <button type="button" className={btnLink} onClick={() => void decide(i, "declined")} disabled={update.isPending} data-testid="wish-dropped">
              Dropped
            </button>
          </div>
        )}
      </li>
    );
  };

  const cold = list.isLoading && !list.data;
  return (
    <div className="space-y-4" data-testid="wishlist">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-display font-semibold text-brand-navy">Wish list</h1>
        <AffordLauncher />
      </div>
      <PageGrid>
        <Panel
          title="Wish list"
          span={12}
          variant={["static", "flush"]}
          actions={
            <button type="button" className={btnLink} onClick={() => setAdding(true)} data-testid="wish-add">
              Add
            </button>
          }
        >
          {cold ? (
            <div className={emptyNote} aria-busy="true" data-testid="wishlist-skeleton">
              Loading…
            </div>
          ) : list.isError ? (
            <div className={emptyNote} role="alert">
              Couldn't load the wish list.{" "}
              <button type="button" className={btnLink} onClick={() => void list.refetch()}>
                Try again
              </button>
            </div>
          ) : active.length === 0 ? (
            <div className={emptyNote} data-testid="wishlist-note">
              Nothing on the list. Add what you are thinking of buying.
            </div>
          ) : (
            <ul data-testid="wish-active">{active.map((i) => row(i, true))}</ul>
          )}
        </Panel>
        {decided.length > 0 && (
          <Panel title="Decided" span={12} variant={["static", "flush"]}>
            <ul data-testid="wish-decided">{decided.map((i) => row(i, false))}</ul>
          </Panel>
        )}
      </PageGrid>

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Add to the wish list</DialogTitle>
            <DialogDescription>H2 starts the waiting period when you add it.</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
            data-testid="wish-form"
          >
            <label className="flex flex-col gap-1">
              <span className={fieldLabel}>What is it</span>
              <input type="text" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} className={input} data-testid="wish-title" />
              {tried && errors.title && <span className="text-micro text-bad" role="alert">{errors.title}</span>}
            </label>
            <label className="flex flex-col gap-1">
              <span className={fieldLabel}>How much (optional)</span>
              <input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={`${input} font-mono tabular-nums`} data-testid="wish-amount" />
              {tried && errors.amount && <span className="text-micro text-bad" role="alert">{errors.amount}</span>}
            </label>
            <label className="flex flex-col gap-1">
              <span className={fieldLabel}>Link (optional)</span>
              <input type="url" inputMode="url" maxLength={500} value={url} onChange={(e) => setUrl(e.target.value)} className={input} data-testid="wish-url" />
              {tried && errors.url && <span className="text-micro text-bad" role="alert">{errors.url}</span>}
            </label>
            <div className="flex gap-3">
              <button type="submit" className={btn} disabled={create.isPending} data-testid="wish-save">
                Add
              </button>
              <button type="button" className={btnSecondary} onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
