import { useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { getListWishlistQueryKey, useCreateWishlistItem, useUpdateWishlistItem, type WishlistItem, type WishlistList } from "@workspace/api-client-react";
import { OWN_INVALIDATION } from "@/data/mutationInvalidation";
import { readOf, type Read } from "@/data/todayData";
import { Button } from "@/kit/Button";
import { Note } from "@/kit/Note";
import { Section } from "@/kit/Section";
import { Sheet } from "@/kit/Sheet";
import { SkeletonLine } from "@/kit/Skeleton";
import { StatusWord, type StatusTone } from "@/kit/StatusWord";
import { shortDate, shortDateOfInstant } from "@/lib/dates";
import { centsValue, fmtMoney, toAmount } from "@/lib/money";
import { apiMessage } from "@/screens/household/words";
import { useWishlist } from "@/screens/ask/askData";
import { Field, MoneyInput, PlanFrame, inputClass, useToast } from "./parts";

const DECISION: Record<WishlistItem["decision"], { word: string; tone: StatusTone }> = {
  pending: { word: "Waiting", tone: "tight" },
  approved: { word: "Approved", tone: "fresh" },
  bought: { word: "Bought", tone: "fresh" },
  declined: { word: "Dropped", tone: "stale" },
};

export const AFFORD_LINE = "The Afford check arrives with the scenario package.";

/** Dollars typed by a person: "$1,200.50" → 1200.5; blank is no amount; anything else is null. */
export function parseAmount(raw: string): number | null | "bad" {
  const s = raw.replace(/[$,\s]/g, "");
  if (s === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return "bad";
  const n = Number(s);
  return n > 1_000_000 ? "bad" : n;
}

const isWebAddress = (s: string): boolean => {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
};

export default function PlanWishlist() {
  const q = useWishlist();
  return <WishlistView list={readOf(q) as Read<WishlistList>} />;
}

/**
 * ⭐ WISH LIST — things the household wants, each with the waiting period the
 * server set. Mark one Bought or Dropped when it is decided; a yes waits out
 * its period. Every date and amount is read as the server sent it.
 */
export function WishlistView({ list }: { list: Read<WishlistList> }) {
  const qc = useQueryClient();
  const create = useCreateWishlistItem({ mutation: { meta: OWN_INVALIDATION } });
  const update = useUpdateWishlistItem({ mutation: { meta: OWN_INVALIDATION } });
  const { say, node: toast } = useToast();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [url, setUrl] = useState("");
  const [tried, setTried] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: getListWishlistQueryKey() });

  const items = list.data?.items ?? [];
  const active = items.filter((i) => i.decision === "pending" || i.decision === "approved");
  const decided = items.filter((i) => i.decision === "bought" || i.decision === "declined");

  const parsed = parseAmount(amount);
  const errors = {
    title: title.trim() ? null : "Say what it is.",
    amount: parsed === "bad" ? "Use dollars, like 120 or 120.50." : null,
    url: url.trim() && !isWebAddress(url.trim()) ? "Use a full web address, starting with https://" : null,
  };
  const reset = () => {
    setTitle("");
    setAmount("");
    setUrl("");
    setTried(false);
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
      reset();
      say("Added. The waiting period has started.");
      refresh();
    } catch (e) {
      say(apiMessage(e, "Couldn't add that. Nothing changed."), "error");
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
        status === 409 ? `Still in the waiting period. Wait until ${shortDate(item.waitingUntil)}.` : apiMessage(e, "Couldn't save that. Nothing changed."),
        "error",
      );
    }
  };

  const row = (i: WishlistItem, live: boolean) => {
    const amt = toAmount(i.amount);
    const d = DECISION[i.decision];
    return (
      <li key={i.id} className="flex flex-col gap-1 border-t border-rule py-3 first:border-t-0" data-testid="wish-item" data-decision={i.decision}>
        <div className="flex items-baseline justify-between gap-4">
          <span className="min-w-0 truncate type-body text-ink">{i.title}</span>
          {amt == null ? (
            <span className="type-figure-sm text-ink-3">—</span>
          ) : (
            <data value={centsValue(amt)} className="shrink-0 type-figure-sm text-ink">
              {fmtMoney(amt)}
            </data>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 type-caption text-ink-3">
          <span data-testid="wish-asked">Asked {shortDateOfInstant(i.requestedAt)}</span>
          {live &&
            (i.waitingDaysLeft > 0 ? (
              <span data-testid="wish-wait">Wait until {shortDate(i.waitingUntil)}</span>
            ) : (
              <span data-testid="wish-wait">Waiting period over</span>
            ))}
          {i.url && isWebAddress(i.url) && (
            <a href={i.url} target="_blank" rel="noopener noreferrer" className="text-moss underline decoration-1 underline-offset-4">
              Link
            </a>
          )}
          <StatusWord tone={d.tone}>{d.word}</StatusWord>
        </div>
        {live && (
          <div className="flex gap-3">
            <Button variant="quiet" size="sm" onClick={() => decide(i, "bought")} disabled={update.isPending} data-testid="wish-bought">
              Bought
            </Button>
            <Button variant="quiet" size="sm" onClick={() => decide(i, "declined")} disabled={update.isPending} data-testid="wish-dropped">
              Dropped
            </Button>
          </div>
        )}
      </li>
    );
  };

  return (
    <PlanFrame current="wishlist">
      <div className="flex flex-col" data-testid="wishlist">
        <Section
          label="Wish list"
          action={
            <Button ref={addButton} variant="quiet" size="sm" onClick={() => setAdding(true)} data-testid="wish-add">
              Add
            </Button>
          }
        >
          {list.state === "cold" ? (
            <div aria-busy="true" data-testid="wishlist-skeleton">
              <SkeletonLine className="w-64" />
            </div>
          ) : list.state === "failed" ? (
            <Note kind="error" onRetry={list.refetch} retrying={list.isFetching}>
              Couldn't load the wish list.
            </Note>
          ) : active.length === 0 ? (
            <Note kind="empty" data-testid="wishlist-note">
              Nothing on the list. Add what you are thinking of buying.
            </Note>
          ) : (
            <ul data-testid="wish-active">{active.map((i) => row(i, true))}</ul>
          )}
        </Section>
        {decided.length > 0 && (
          <Section label="Decided">
            <ul data-testid="wish-decided">{decided.map((i) => row(i, false))}</ul>
          </Section>
        )}
        <p className="type-caption text-ink-3" data-testid="afford-note">
          {AFFORD_LINE}
        </p>
      </div>

      <Sheet open={adding} onOpenChange={setAdding} title="Add to the wish list" description="H2 starts the waiting period when you add it." returnFocusRef={addButton}>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
          data-testid="wish-form"
        >
          <Field label="What is it" error={tried ? errors.title : null}>
            {(a) => <input {...a} type="text" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} className={inputClass} data-testid="wish-title" />}
          </Field>
          <MoneyInput label="How much (optional)" value={amount} onChange={setAmount} error={tried ? errors.amount : null} data-testid="wish-amount" />
          <Field label="Link (optional)" error={tried ? errors.url : null}>
            {(a) => <input {...a} type="url" inputMode="url" maxLength={500} value={url} onChange={(e) => setUrl(e.target.value)} className={inputClass} data-testid="wish-url" />}
          </Field>
          <div className="flex gap-3">
            <Button type="submit" variant="primary" disabled={create.isPending} data-testid="wish-save">
              Add
            </Button>
            <Button variant="quiet" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </Sheet>
      {toast}
    </PlanFrame>
  );
}
