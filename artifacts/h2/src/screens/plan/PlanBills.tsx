import { useRef, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { isEverydayFundingItem } from "@workspace/avalanche-core";
import {
  useCreateRecurringItem,
  useDeleteRecurringItem,
  useUpdateRecurringItem,
  type BillsSummary,
  type Category,
  type RecurringItem,
  type RecurringItemInput,
} from "@workspace/api-client-react";
import { Button } from "@/kit/Button";
import { Disclosure } from "@/kit/Disclosure";
import { Note } from "@/kit/Note";
import { Section } from "@/kit/Section";
import { Sheet } from "@/kit/Sheet";
import { SkeletonLine } from "@/kit/Skeleton";
import { cx } from "@/lib/cx";
import { shortDate } from "@/lib/dates";
import { centsValue, fmtMoney, toAmount } from "@/lib/money";
import { CADENCES, cadenceWords, errorWords, isISODate, parsePositiveDollars, plainDollars } from "./format";
import { Field, MoneyInput, PlanFrame, inputClass, useToast } from "./parts";
import { usePlanBillsData, usePlanInvalidate, type BillsData } from "./planData";

/** The form behind both the edit sheet and the add sheet. */
export interface ItemForm {
  name: string;
  kind: "income" | "bill";
  amount: string;
  estimate: boolean;
  frequency: string;
  dayOfMonth: string;
  anchorDate: string;
  oneTimeDate: string;
  categoryId: string;
  active: boolean;
}

export function blankForm(over: Partial<ItemForm> = {}): ItemForm {
  return {
    name: "",
    kind: "bill",
    amount: "",
    estimate: false,
    frequency: "monthly",
    dayOfMonth: "1",
    anchorDate: "",
    oneTimeDate: "",
    categoryId: "",
    active: true,
    ...over,
  };
}

export function formOf(item: RecurringItem): ItemForm {
  const once = item.frequency === "onetime";
  return {
    name: item.name,
    kind: item.kind === "income" ? "income" : "bill",
    amount: plainDollars(item.amount),
    estimate: item.amountKind === "estimate",
    frequency: item.frequency,
    dayOfMonth: item.dayOfMonth ? String(item.dayOfMonth) : "1",
    anchorDate: once ? "" : (item.anchorDate ?? ""),
    oneTimeDate: once ? (item.anchorDate ?? "") : "",
    categoryId: item.categoryId ?? "",
    active: item.active === "true",
  };
}

/** The words for each thing wrong with a form; empty when it can be saved. */
export function validateForm(f: ItemForm): Partial<Record<"name" | "amount" | "frequency" | "day" | "date", string>> {
  const e: Partial<Record<"name" | "amount" | "frequency" | "day" | "date", string>> = {};
  if (!f.name.trim()) e.name = "Give it a name.";
  if (!parsePositiveDollars(f.amount)) e.amount = "Enter an amount above $0, like 142 or 142.18.";
  if (!CADENCES.some((c) => c.value === f.frequency) && !["quarterly", "annual"].includes(f.frequency)) e.frequency = "Pick how often it repeats.";
  if (f.frequency === "monthly" || f.frequency === "semimonthly") {
    const d = Number(f.dayOfMonth);
    if (!Number.isInteger(d) || d < 1 || d > 31) e.day = "Pick a day from 1 to 31.";
  }
  if (f.frequency === "onetime" && !isISODate(f.oneTimeDate)) e.date = "Pick the date it is due.";
  return e;
}

export function payloadOf(f: ItemForm): RecurringItemInput {
  const monthly = f.frequency === "monthly" || f.frequency === "semimonthly";
  return {
    name: f.name.trim(),
    kind: f.kind,
    amount: parsePositiveDollars(f.amount) ?? "0.00",
    amountKind: f.estimate ? "estimate" : "fixed",
    frequency: f.frequency,
    dayOfMonth: monthly ? Number(f.dayOfMonth) : null,
    anchorDate: f.frequency === "onetime" ? f.oneTimeDate : f.anchorDate || null,
    categoryId: f.categoryId || null,
    active: f.active ? "true" : "false",
  };
}

/** An existing item as the update body, with one field changed. */
function inputOf(item: RecurringItem, over: Partial<RecurringItemInput> = {}): RecurringItemInput {
  return {
    name: item.name,
    kind: item.kind,
    amount: item.amount,
    amountKind: item.amountKind,
    frequency: item.frequency,
    dayOfMonth: item.dayOfMonth ?? null,
    anchorDate: item.anchorDate ?? null,
    categoryId: item.categoryId ?? null,
    debtId: item.debtId ?? null,
    active: item.active,
    ...over,
  };
}

function Amount({ value }: { value: string }) {
  const n = toAmount(value);
  if (n == null) return <span className="type-figure-sm text-ink-3">—</span>;
  return (
    <data value={centsValue(n)} className="type-figure-sm text-ink">
      {fmtMoney(n)}
    </data>
  );
}

function Switch({ on, label, onToggle, disabled }: { on: boolean; label: string; onToggle: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
      className={cx(
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border border-rule-strong disabled:opacity-50",
        on ? "bg-moss" : "bg-paper-2",
      )}
    >
      <span aria-hidden className={cx("inline-block size-4 rounded-full bg-paper-0 border border-rule-strong", on ? "translate-x-[1.25rem]" : "translate-x-[0.125rem]")} />
    </button>
  );
}

function ItemSheet({
  mode,
  item,
  initial,
  categories,
  open,
  onOpenChange,
  returnFocusRef,
  onSaved,
  onDeleted,
  onError,
}: {
  mode: "add" | "edit";
  item?: RecurringItem;
  initial: ItemForm;
  categories: Category[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
  returnFocusRef: React.RefObject<HTMLElement | null>;
  onSaved: (text: string) => void;
  onDeleted: (text: string) => void;
  onError: (text: string) => void;
}) {
  const create = useCreateRecurringItem();
  const update = useUpdateRecurringItem();
  const remove = useDeleteRecurringItem();
  const [form, setForm] = useState(initial);
  const [tried, setTried] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const errors = validateForm(form);
  const shown = tried ? errors : {};
  const set = <K extends keyof ItemForm>(k: K, v: ItemForm[K]) => setForm((f) => ({ ...f, [k]: v }));
  const wantKind = form.kind === "income" ? "income" : "expense";
  const options = categories.filter((c) => c.kind === wantKind);
  const busy = create.isPending || update.isPending || remove.isPending;

  const submit = () => {
    setTried(true);
    if (Object.keys(errors).length > 0) return;
    const data = payloadOf(form);
    const opts = {
      onSuccess: () => {
        onOpenChange(false);
        onSaved(mode === "add" ? "Added." : "Saved.");
      },
      onError: (e: unknown) => onError(errorWords(e)),
    };
    if (mode === "add") create.mutate({ data }, opts);
    else if (item) update.mutate({ id: item.id, data }, opts);
  };

  const del = () => {
    if (!item) return;
    remove.mutate(
      { id: item.id },
      {
        onSuccess: () => {
          onOpenChange(false);
          onDeleted(`Deleted ${item.name}.`);
        },
        onError: (e) => onError(errorWords(e, "Couldn't delete. Try again.")),
      },
    );
  };

  if (confirming && item) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange} title={`Delete ${item.name}?`} description="It leaves your plan and the forecast." returnFocusRef={returnFocusRef}>
        <div className="flex flex-col gap-3">
          <Button variant="danger" disabled={busy} onClick={del} data-testid="confirm-delete">
            Delete {item.name}
          </Button>
          <Button variant="quiet" onClick={() => setConfirming(false)}>
            Keep it
          </Button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={mode === "add" ? "Add to your plan" : item?.name ?? "Edit"} returnFocusRef={returnFocusRef}>
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Name" error={shown.name}>
          {(a) => <input {...a} className={inputClass} value={form.name} onChange={(e) => set("name", e.target.value)} data-testid="item-name" />}
        </Field>
        {mode === "add" && (
          <Field label="Kind">
            {(a) => (
              <select {...a} className={inputClass} value={form.kind} onChange={(e) => set("kind", e.target.value as ItemForm["kind"])}>
                <option value="bill">Bill</option>
                <option value="income">Income</option>
              </select>
            )}
          </Field>
        )}
        <MoneyInput label="Amount" value={form.amount} onChange={(v) => set("amount", v)} error={shown.amount} data-testid="item-amount" />
        <label className="flex items-center gap-2 type-body text-ink">
          <input type="checkbox" checked={form.estimate} onChange={(e) => set("estimate", e.target.checked)} data-testid="item-estimate" />
          This amount varies (an estimate)
        </label>
        <Field label="How often" error={shown.frequency}>
          {(a) => (
            <select {...a} className={inputClass} value={form.frequency} onChange={(e) => set("frequency", e.target.value)} data-testid="item-frequency">
              {CADENCES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
              {!CADENCES.some((c) => c.value === form.frequency) && <option value={form.frequency}>{cadenceWords(form.frequency)}</option>}
            </select>
          )}
        </Field>
        {(form.frequency === "monthly" || form.frequency === "semimonthly") && (
          <Field label="Day of the month" error={shown.day}>
            {(a) => (
              <input {...a} className={inputClass} inputMode="numeric" value={form.dayOfMonth} onChange={(e) => set("dayOfMonth", e.target.value)} data-testid="item-day" />
            )}
          </Field>
        )}
        {(form.frequency === "weekly" || form.frequency === "biweekly") && (
          <Field label="A date it falls on" hint="Any one date; the rest follow from it.">
            {(a) => <input {...a} type="date" className={inputClass} value={form.anchorDate} onChange={(e) => set("anchorDate", e.target.value)} />}
          </Field>
        )}
        {form.frequency === "onetime" && (
          <Field label="Date it is due" error={shown.date}>
            {(a) => <input {...a} type="date" className={inputClass} value={form.oneTimeDate} onChange={(e) => set("oneTimeDate", e.target.value)} data-testid="item-date" />}
          </Field>
        )}
        <Field label="Category">
          {(a) => (
            <select {...a} className={inputClass} value={form.categoryId} onChange={(e) => set("categoryId", e.target.value)} data-testid="item-category">
              <option value="">No category</option>
              {options.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        {mode === "edit" && (
          <label className="flex items-center gap-2 type-body text-ink">
            <input type="checkbox" checked={form.active} onChange={(e) => set("active", e.target.checked)} />
            Active
          </label>
        )}
        <div className="flex flex-wrap gap-3 pt-2">
          <Button type="submit" variant="primary" disabled={busy} data-testid="item-save">
            {mode === "add" ? "Add" : "Save"}
          </Button>
          {mode === "edit" && (
            <Button variant="danger" onClick={() => setConfirming(true)} data-testid="item-delete">
              Delete
            </Button>
          )}
        </div>
      </form>
    </Sheet>
  );
}

function nextDates(summary: BillsSummary | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of [...(summary?.income ?? []), ...(summary?.bills ?? [])]) {
    if (r.nextOccurrence) m.set(r.item.id, r.nextOccurrence);
  }
  return m;
}

/** Soonest first, undated last; paused items sink. A sort, not a sum. */
function ordered(items: RecurringItem[], next: Map<string, string>): RecurringItem[] {
  return [...items].sort((a, b) => {
    if ((a.active === "true") !== (b.active === "true")) return a.active === "true" ? -1 : 1;
    const da = next.get(a.id) ?? a.anchorDate ?? "9999";
    const db = next.get(b.id) ?? b.anchorDate ?? "9999";
    return da === db ? a.name.localeCompare(b.name) : da < db ? -1 : 1;
  });
}

export default function PlanBills() {
  const data = usePlanBillsData();
  return <BillsView data={data} />;
}

/**
 * ⭐ BILLS — what comes in and what goes out, by kind. A row says what it is,
 * what it costs (with the word "estimate" when it varies), how often, and when
 * it is next due; tap it to change it. The two funding items stay on the page
 * but read-only: their amount is the allowance, set on The week.
 */
export function BillsView({ data }: { data: BillsData }) {
  const { items, summary, categories } = data;
  const update = useUpdateRecurringItem();
  const invalidate = usePlanInvalidate();
  const { say, node: toast } = useToast();
  const [sheet, setSheet] = useState<
    { mode: "edit"; item: RecurringItem } | { mode: "add"; frequency: string } | null
  >(null);
  const returnRef = useRef<HTMLElement | null>(null);
  const addRef = useRef<HTMLButtonElement | null>(null);

  if (items.state === "cold" && !items.data) {
    return (
      <PlanFrame current="bills">
        <div className="flex flex-col gap-3" data-testid="plan-skeleton" aria-busy="true">
          <SkeletonLine className="w-48" />
          <SkeletonLine className="w-64" />
          <SkeletonLine className="w-56" />
        </div>
      </PlanFrame>
    );
  }
  if (!items.data) {
    return (
      <PlanFrame current="bills">
        <Note kind="error" onRetry={items.refetch} retrying={items.isFetching}>
          Couldn't load your bills.
        </Note>
      </PlanFrame>
    );
  }

  const next = nextDates(summary.data);
  const funding = items.data.filter((i) => isEverydayFundingItem(i.name));
  const rest = items.data.filter((i) => !isEverydayFundingItem(i.name));
  const groups: Array<{ label: string; rows: RecurringItem[] }> = [
    { label: "Income", rows: ordered(rest.filter((i) => i.kind === "income"), next) },
    { label: "Bills", rows: ordered(rest.filter((i) => i.kind !== "income" && i.kind !== "subscription"), next) },
    { label: "Subscriptions", rows: ordered(rest.filter((i) => i.kind === "subscription"), next) },
  ].filter((g) => g.rows.length > 0);

  const toggle = (item: RecurringItem) =>
    update.mutate(
      { id: item.id, data: inputOf(item, { active: item.active === "true" ? "false" : "true" }) },
      {
        onSuccess: () => {
          invalidate();
          say(item.active === "true" ? `${item.name} paused.` : `${item.name} is active.`);
        },
        onError: (e) => say(errorWords(e), "error"),
      },
    );

  const row = (item: RecurringItem): ReactNode => {
    const due = next.get(item.id) ?? (item.frequency === "onetime" ? item.anchorDate : null);
    const on = item.active === "true";
    return (
      <li key={item.id} className="flex items-center gap-3 border-t border-rule py-3 first:border-t-0" data-testid="bill-row">
        <button
          type="button"
          className="flex min-w-0 flex-1 flex-col gap-1 text-left"
          onClick={(e) => {
            returnRef.current = e.currentTarget;
            setSheet({ mode: "edit", item });
          }}
          aria-label={`Edit ${item.name}`}
        >
          <span className={cx("truncate type-body", on ? "text-ink" : "text-ink-3")}>{item.name}</span>
          <span className="flex flex-wrap gap-x-2 type-caption text-ink-3">
            <span>{cadenceWords(item.frequency, item.dayOfMonth)}</span>
            {due && <span>next {shortDate(due)}</span>}
            {item.amountKind === "estimate" && <span data-testid="estimate-word">estimate</span>}
            {!on && <span>paused</span>}
          </span>
        </button>
        <Amount value={item.amount} />
        <Switch on={on} label={`${item.name} active`} onToggle={() => toggle(item)} disabled={update.isPending} />
      </li>
    );
  };

  const cats = categories.data ?? [];
  const initial = sheet?.mode === "edit" ? formOf(sheet.item) : blankForm(sheet?.mode === "add" ? { frequency: sheet.frequency, dayOfMonth: "1" } : {});

  return (
    <PlanFrame current="bills">
      {items.state === "refresh-failed" && (
        <div className="mb-6">
          <Note kind="error" onRetry={items.refetch} retrying={items.isFetching}>
            Couldn't refresh. Showing your last bills.
          </Note>
        </div>
      )}
      <div className="mb-6 flex flex-wrap gap-3">
        <Button
          ref={addRef}
          variant="primary"
          onClick={() => {
            returnRef.current = addRef.current;
            setSheet({ mode: "add", frequency: "monthly" });
          }}
          data-testid="add-item"
        >
          Add
        </Button>
        <Button
          variant="quiet"
          onClick={(e) => {
            returnRef.current = e.currentTarget;
            setSheet({ mode: "add", frequency: "onetime" });
          }}
          data-testid="add-one-time"
        >
          Add a one-time bill
        </Button>
      </div>

      {groups.length === 0 && funding.length === 0 && <Note kind="empty">Nothing in your plan yet. Add your pay and your first bill.</Note>}

      {groups.map((g) => (
        <Section key={g.label} label={g.label} data-testid={`group-${g.label.toLowerCase()}`}>
          <ul className="flex flex-col">{g.rows.map(row)}</ul>
        </Section>
      ))}

      {funding.length > 0 && (
        <Section label="Everyday spending" data-testid="group-funding">
          <ul className="flex flex-col">
            {funding.map((i) => (
              <li key={i.id} className="flex items-center gap-3 border-t border-rule py-3 first:border-t-0" data-testid="funding-row">
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate type-body text-ink">{i.name}</span>
                  <span className="type-caption text-ink-3">allowance hook</span>
                </span>
                <Amount value={i.amount} />
              </li>
            ))}
          </ul>
          <Disclosure summary="Why can't I edit these?">
            These two lines carry your weekly and monthly spending into the forecast. Their amount is your allowance, so it is set on{" "}
            <Link href="/plan" className="text-moss underline decoration-1 underline-offset-4 hover:text-moss-ink">
              The week
            </Link>
            , not here.
          </Disclosure>
        </Section>
      )}

      {sheet && (
        <ItemSheet
          key={sheet.mode === "edit" ? sheet.item.id : `add-${sheet.frequency}`}
          mode={sheet.mode}
          item={sheet.mode === "edit" ? sheet.item : undefined}
          initial={initial}
          categories={cats}
          open
          onOpenChange={(o) => !o && setSheet(null)}
          returnFocusRef={returnRef}
          onSaved={(t) => {
            invalidate();
            say(t);
          }}
          onDeleted={(t) => {
            invalidate();
            say(t);
          }}
          onError={(t) => say(t, "error")}
        />
      )}
      {toast}
    </PlanFrame>
  );
}
