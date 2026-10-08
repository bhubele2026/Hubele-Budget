import { useRef, useState } from "react";
import { Link } from "wouter";
import { householdToday } from "@workspace/avalanche-core/householdTime";
import {
  useCreateDebt,
  useCreateDebtPayment,
  useUpdateAvalancheSettings,
  useUpdateDebt,
  type Debt,
  type DebtInput,
  type DebtPlan,
} from "@workspace/api-client-react";
import { Button } from "@/kit/Button";
import { Disclosure } from "@/kit/Disclosure";
import { Figure } from "@/kit/Figure";
import { Note, RefreshNote } from "@/kit/Note";
import { Section } from "@/kit/Section";
import { Sheet } from "@/kit/Sheet";
import { SkeletonFigure, SkeletonLine } from "@/kit/Skeleton";
import { shortDate, weekdayDate } from "@/lib/dates";
import { centsValue, fmtMoney, toAmount } from "@/lib/money";
import {
  aprToPercentInput,
  aprWords,
  errorWords,
  isISODate,
  monthWords,
  ordinal,
  parseDollars,
  parsePositiveDollars,
  pctWords,
  percentToApr,
  plainDollars,
} from "./format";
import { Field, MoneyInput, PlanFrame, Segmented, inputClass, useToast } from "./parts";
import { usePlanDebtData, usePlanInvalidate, type DebtData } from "./planData";

export const LOGGED_TOAST = "Logged. It counts as paid once the bank shows it.";

function Money({ value }: { value: string | number | null | undefined }) {
  const n = toAmount(value);
  if (n == null) return <span className="text-ink-3">—</span>;
  return (
    <data value={centsValue(n)} className="tnum">
      {fmtMoney(n)}
    </data>
  );
}

function PaymentSheet({
  debt,
  amount: startAmount,
  today,
  onClose,
  onLogged,
  onError,
  returnFocusRef,
}: {
  debt: { id: string; name: string };
  amount: string;
  today: string;
  onClose: () => void;
  onLogged: (text: string) => void;
  onError: (text: string) => void;
  returnFocusRef: React.RefObject<HTMLElement | null>;
}) {
  const pay = useCreateDebtPayment();
  const [amount, setAmount] = useState(startAmount);
  const [date, setDate] = useState(today);
  const [tried, setTried] = useState(false);
  const parsed = parsePositiveDollars(amount);
  const submit = () => {
    setTried(true);
    if (!parsed || !isISODate(date)) return;
    pay.mutate(
      { id: debt.id, data: { amount: parsed, occurredOn: date } },
      {
        onSuccess: (r) => {
          onClose();
          onLogged(r?.killed ? `${LOGGED_TOAST} ${debt.name} is paid off.` : LOGGED_TOAST);
        },
        onError: (e) => onError(errorWords(e, "Couldn't log that payment. Try again.")),
      },
    );
  };
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={`Log a payment to ${debt.name}`} description="Tell H2 you paid. The bank's row confirms it later." returnFocusRef={returnFocusRef}>
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <MoneyInput label="Amount" value={amount} onChange={setAmount} error={tried && !parsed ? "Enter an amount above $0." : null} data-testid="pay-amount" />
        <Field label="Date paid" error={tried && !isISODate(date) ? "Pick the date you paid." : null}>
          {(a) => <input {...a} type="date" className={inputClass} value={date} onChange={(e) => setDate(e.target.value)} data-testid="pay-date" />}
        </Field>
        <Button type="submit" variant="primary" disabled={pay.isPending} data-testid="pay-submit">
          Log payment
        </Button>
      </form>
    </Sheet>
  );
}

function srcWord(s: string) {
  return s === "plaid" ? "from the bank" : "entered by you";
}

function DebtSheet({
  debt,
  onClose,
  onDone,
  onError,
  returnFocusRef,
}: {
  debt: Debt | null;
  onClose: () => void;
  onDone: (text: string) => void;
  onError: (text: string) => void;
  returnFocusRef: React.RefObject<HTMLElement | null>;
}) {
  const create = useCreateDebt();
  const update = useUpdateDebt();
  const [name, setName] = useState(debt?.name ?? "");
  const [apr, setApr] = useState(debt ? aprToPercentInput(debt.apr) : "");
  const [min, setMin] = useState(debt ? plainDollars(debt.minPayment) : "");
  const [due, setDue] = useState(debt?.dueDay ? String(debt.dueDay) : "");
  const [balance, setBalance] = useState("");
  const [tried, setTried] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const aprLocked = debt?.aprSource === "plaid";
  const minLocked = debt?.minPaymentSource === "plaid";

  const aprOut = percentToApr(apr);
  const minOut = parseDollars(min);
  const dueNum = due.trim() === "" ? null : Number(due);
  const dueOk = dueNum === null || (Number.isInteger(dueNum) && dueNum >= 1 && dueNum <= 31);
  const errs = {
    name: name.trim() ? null : "Give it a name.",
    apr: aprLocked || aprOut ? null : "Enter the rate as a percent, like 24.99.",
    min: minLocked || minOut ? null : "Enter the minimum payment, like 35.",
    due: dueOk ? null : "Pick a day from 1 to 31, or leave it blank.",
    balance: debt || parsePositiveDollars(balance) ? null : "Enter the balance today, in dollars.",
  };
  const bad = Object.values(errs).some(Boolean);
  const shown = tried ? errs : { name: null, apr: null, min: null, due: null, balance: null };

  const opts = (text: string) => ({
    onSuccess: () => {
      onClose();
      onDone(text);
    },
    onError: (e: unknown) => onError(errorWords(e)),
  });

  const save = () => {
    setTried(true);
    if (bad) return;
    if (!debt) {
      create.mutate(
        { data: { name: name.trim(), apr: aprOut!, minPayment: minOut!, balance: parsePositiveDollars(balance)!, dueDay: dueNum } },
        opts("Debt added."),
      );
      return;
    }
    // Only what changed, and never a field the bank owns.
    const patch: DebtInput = {};
    if (name.trim() !== debt.name) patch.name = name.trim();
    if (!aprLocked && aprOut && aprOut !== Number(debt.apr).toFixed(4)) patch.apr = aprOut;
    if (!minLocked && minOut && Number(minOut) !== Number(debt.minPayment)) patch.minPayment = minOut;
    if (dueNum !== (debt.dueDay ?? null)) patch.dueDay = dueNum;
    if (Object.keys(patch).length === 0) return onClose();
    update.mutate({ id: debt.id, data: patch }, opts("Saved."));
  };

  if (confirming && debt) {
    return (
      <Sheet open onOpenChange={(o) => !o && onClose()} title={`Archive ${debt.name}?`} description="It leaves the plan. You can bring it back from the classic app." returnFocusRef={returnFocusRef}>
        <div className="flex flex-col gap-3">
          <Button variant="danger" disabled={update.isPending} onClick={() => update.mutate({ id: debt.id, data: { status: "archived" } }, opts(`${debt.name} archived.`))} data-testid="confirm-archive">
            Archive {debt.name}
          </Button>
          <Button variant="quiet" onClick={() => setConfirming(false)}>
            Keep it
          </Button>
        </div>
      </Sheet>
    );
  }

  const bal = toAmount(debt?.balance);
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()} title={debt ? debt.name : "Add a debt"} returnFocusRef={returnFocusRef}>
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {debt && bal != null && (
          <p className="type-body text-ink-2" data-testid="debt-sheet-balance">
            Balance <Money value={bal} /> · {srcWord(debt.balanceSource)}
          </p>
        )}
        <Field label="Name" error={shown.name}>
          {(a) => <input {...a} className={inputClass} value={name} onChange={(e) => setName(e.target.value)} data-testid="debt-name" />}
        </Field>
        {!debt && <MoneyInput label="Balance today" value={balance} onChange={setBalance} error={shown.balance} data-testid="debt-balance" />}
        <Field label="Interest rate, percent" error={shown.apr} hint={aprLocked ? "From the bank." : undefined}>
          {(a) => <input {...a} className={inputClass} inputMode="decimal" value={apr} disabled={aprLocked} onChange={(e) => setApr(e.target.value)} data-testid="debt-apr" />}
        </Field>
        <MoneyInput label="Minimum payment" value={min} onChange={setMin} error={shown.min} disabled={minLocked} hint={minLocked ? "From the bank." : undefined} data-testid="debt-min" />
        <Field label="Due day of the month" error={shown.due}>
          {(a) => <input {...a} className={inputClass} inputMode="numeric" value={due} onChange={(e) => setDue(e.target.value)} data-testid="debt-due" />}
        </Field>
        <div className="flex flex-wrap gap-3 pt-2">
          <Button type="submit" variant="primary" disabled={create.isPending || update.isPending} data-testid="debt-save">
            {debt ? "Save" : "Add debt"}
          </Button>
          {debt && (
            <Button variant="danger" onClick={() => setConfirming(true)} data-testid="debt-archive">
              Archive
            </Button>
          )}
        </div>
      </form>
    </Sheet>
  );
}

function ComparisonTable({ plan, chosen, debtName }: { plan: DebtPlan; chosen: "avalanche" | "snowball"; debtName: (id: string) => string }) {
  const cols = [
    { key: "avalanche" as const, label: "Avalanche", s: plan.comparison.avalanche },
    { key: "snowball" as const, label: "Snowball", s: plan.comparison.snowball },
  ];
  const rows: Array<[string, (s: (typeof cols)[number]["s"]) => React.ReactNode]> = [
    ["Months to go", (s) => (s.monthsToFreedom == null ? "—" : s.monthsToFreedom)],
    ["Debt-free around", (s) => (s.debtFreeMonth ? monthWords(s.debtFreeMonth) : "—")],
    ["Projected interest", (s) => (s.totalInterest == null ? "—" : <Money value={s.totalInterest} />)],
    ["First one cleared", (s) => (s.firstKill ? `${debtName(s.firstKill.debtId)}, ${monthWords(s.firstKill.month)}` : "—")],
  ];
  return (
    <table className="w-full border-collapse type-body" data-testid="comparison">
      <caption className="sr-only">Avalanche and snowball side by side</caption>
      <thead>
        <tr>
          <th scope="col" className="py-2 pr-2 text-left type-label text-ink-2">
            <span className="sr-only">Measure</span>
          </th>
          {cols.map((c) => (
            <th key={c.key} scope="col" className="py-2 pl-2 text-right type-label text-ink" aria-current={c.key === chosen ? "true" : undefined}>
              {c.label}
              {c.key === chosen && <span className="block type-caption font-normal text-moss-ink">your plan</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, cell]) => (
          <tr key={label} className="border-t border-rule">
            <th scope="row" className="py-2 pr-2 text-left type-body font-normal text-ink-2">
              {label}
            </th>
            {cols.map((c) => (
              <td key={c.key} className="py-2 pl-2 text-right tnum text-ink">
                {cell(c.s)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function PlanDebt({ now }: { now?: Date }) {
  const data = usePlanDebtData();
  return <DebtView data={data} now={now} />;
}

/**
 * ⭐ DEBT — how far along, and when it ends, as a RANGE. The hero is the
 * percent paid, never an amount owed; per-debt balances appear only inside a
 * debt's own sheet. "Debt-free around Mar 2028 to Aug 2028" is the server's
 * `range`; the comparison, milestones and the next 60 days are its plan.
 *
 * ⚠️ NO ONE DATE: this page never says "debt-free on <day>".
 */
export function DebtView({ data, now }: { data: DebtData; now?: Date }) {
  const { spine, plan, settings, extra, debts } = data;
  const today = householdToday(now);
  const invalidate = usePlanInvalidate();
  const putSettings = useUpdateAvalancheSettings();
  const { say, node: toast } = useToast();
  const [extraText, setExtraText] = useState<string | null>(null);
  const [extraError, setExtraError] = useState<string | null>(null);
  const [pay, setPay] = useState<{ id: string; name: string; amount: string } | null>(null);
  const [edit, setEdit] = useState<{ debt: Debt | null } | null>(null);
  const returnRef = useRef<HTMLElement | null>(null);

  const payoffPct = spine.data?.debt?.payoffPct ?? null;
  const p = plan.data;
  const active = (debts.data ?? []).filter((d) => d.status === "active");
  const debtName = (id: string) => debts.data?.find((d) => d.id === id)?.name ?? p?.comparison.detail.debts.find((d) => d.debtId === id)?.name ?? "A debt";
  const strategy = settings.data?.strategy ?? p?.strategy ?? "avalanche";

  const open = (e: React.MouseEvent<HTMLElement>, s: () => void) => {
    returnRef.current = e.currentTarget;
    s();
  };

  const setStrategy = (s: "avalanche" | "snowball") =>
    putSettings.mutate(
      { data: { strategy: s } },
      {
        onSuccess: () => {
          invalidate();
          say(s === "avalanche" ? "Using avalanche." : "Using snowball.");
        },
        onError: (e) => say(errorWords(e), "error"),
      },
    );

  const saveExtra = () => {
    const v = parseDollars(extraText ?? "");
    if (!v) return setExtraError("Enter a dollar amount, like 250. Use 0 for none.");
    setExtraError(null);
    putSettings.mutate(
      { data: { manualExtra: v, ...(settings.data && settings.data.extraSource !== "manual" ? { extraSource: "manual" as const } : {}) } },
      {
        onSuccess: () => {
          invalidate();
          setExtraText(null);
          say("Extra payment saved.");
        },
        onError: (e) => say(errorWords(e), "error"),
      },
    );
  };

  if (spine.state === "cold" && plan.state === "cold") {
    return (
      <PlanFrame current="debt">
        <div className="flex flex-col gap-2 pb-8" data-testid="plan-skeleton" aria-busy="true">
          <SkeletonLine className="w-24" />
          <SkeletonFigure size="xl" />
          <SkeletonLine className="w-48" />
        </div>
      </PlanFrame>
    );
  }

  const range = p?.range;
  const planned = p?.planned60d ?? [];
  const paidDown = toAmount(p?.paidDownGenuineMtd);
  const safe = toAmount(extra.data?.availableMoney);
  const typedExtra = parseDollars(extraText ?? "");
  const overSafe = typedExtra != null && safe != null && Number(typedExtra) > safe;
  const noBalances = payoffPct == null;

  return (
    <PlanFrame current="debt">
      {(plan.state === "failed" || plan.state === "refresh-failed") && (
        <div className="mb-6">
          <RefreshNote state={plan.state} updatedAt={spine.updatedAt} onRetry={plan.refetch} retrying={plan.isFetching} now={now} />
        </div>
      )}

      <div className="pb-8" data-testid="debt-hero">
        <Figure
          size="xl"
          label="Toward debt-free"
          amount={payoffPct}
          state={spine.state}
          format={pctWords}
          suffix="paid"
          sub={noBalances && spine.state !== "cold" ? "No debt has a starting balance yet." : undefined}
          data-testid="figure-hero"
        />
      </div>

      <Section label="When it ends" data-testid="section-range">
        {plan.state === "cold" && !p ? (
          <SkeletonLine className="w-64" />
        ) : !range || range.earliestMonth == null ? (
          <Note kind="empty">Not enough on file to project a finish yet.</Note>
        ) : (
          <>
            <p className="type-figure text-ink" data-testid="range-line">
              Debt-free around {monthWords(range.earliestMonth)}
              {range.latestMonth ? ` to ${monthWords(range.latestMonth)}` : " or later"}
            </p>
            {range.interestLow != null && range.interestHigh != null && (
              <p className="mt-1 type-body text-ink-2" data-testid="interest-range">
                Projected interest <Money value={range.interestLow} />
                {" to "}
                <Money value={range.interestHigh} />
              </p>
            )}
            {range.assumptions.length > 0 && (
              <div className="mt-3">
                <Disclosure summary="What this assumes">
                  <ul className="flex flex-col gap-1">
                    {range.assumptions.map((a) => (
                      <li key={a.key}>{a.text}</li>
                    ))}
                  </ul>
                </Disclosure>
              </div>
            )}
          </>
        )}
      </Section>

      <Section label="Your strategy" data-testid="section-strategy">
        <Segmented
          label="Payoff strategy"
          value={strategy}
          options={[
            { value: "avalanche", label: "Avalanche" },
            { value: "snowball", label: "Snowball" },
          ]}
          onChange={setStrategy}
          disabled={putSettings.isPending}
          data-testid="strategy"
        />
        <p className="mt-2 type-caption text-ink-3">Avalanche pays the highest rate first. Snowball clears the smallest balance first.</p>
        {p && (
          <div className="mt-4">
            <ComparisonTable plan={p} chosen={strategy} debtName={debtName} />
          </div>
        )}
      </Section>

      <Section label="Extra each month" data-testid="section-extra">
        <div className="flex items-end gap-3">
          <div className="min-w-0 flex-1">
            <MoneyInput
              label="Extra toward debt"
              value={extraText ?? plainDollars(settings.data?.manualExtra ?? p?.extraMonthly)}
              onChange={(v) => {
                setExtraText(v);
                setExtraError(null);
              }}
              error={extraError}
              hint={
                <>
                  {safe != null && (
                    <span data-testid="safe-cap">
                      safe up to <Money value={safe} />
                    </span>
                  )}
                  {overSafe && <span data-testid="over-safe"> · that is over the safe amount</span>}
                  {settings.data && settings.data.extraSource !== "manual" && " · saving here switches the extra to a fixed amount"}
                </>
              }
              data-testid="input-extra"
            />
          </div>
          <Button variant="quiet" disabled={putSettings.isPending || extraText == null} onClick={saveExtra} data-testid="save-extra">
            Save
          </Button>
        </div>
      </Section>

      <Section label="Milestones" data-testid="section-milestones">
        {!p || (p.milestones.achieved.length === 0 && !p.milestones.next) ? (
          <Note kind="empty">Milestones show up here as you pay down.</Note>
        ) : (
          <ul className="flex flex-col gap-2 type-body">
            {p.milestones.achieved.map((m) => (
              <li key={m.key} className="flex items-baseline justify-between gap-4" data-testid="milestone-achieved">
                <span className="text-ink">{m.label}</span>
                <span className="type-caption text-ink-3">reached {shortDate(m.achievedOn)}</span>
              </li>
            ))}
            {p.milestones.next && (
              <li className="flex items-baseline justify-between gap-4" data-testid="milestone-next">
                <span className="text-ink">Next: {p.milestones.next.label}</span>
                <span className="type-caption text-ink-3">around {monthWords(p.milestones.next.estimatedMonth)}</span>
              </li>
            )}
          </ul>
        )}
      </Section>

      <Section label="Paid down" data-testid="section-paid">
        <p className="type-body text-ink" data-testid="paid-down">
          {paidDown != null && paidDown > 0 ? (
            <>
              Paid down <Money value={paidDown} /> this month
            </>
          ) : (
            "Nothing paid down yet this month."
          )}
        </p>
        <h3 className="mt-4 type-label text-ink-2">Planned next 60 days</h3>
        {planned.length === 0 ? (
          <p className="mt-2 type-body text-ink-2">Nothing planned in the next 60 days.</p>
        ) : (
          <ul className="mt-2 flex flex-col" data-testid="planned-list">
            {planned.map((it, i) => (
              <li key={`${it.itemId}-${it.date}-${i}`} className="flex items-center justify-between gap-3 border-t border-rule py-2 first:border-t-0">
                <span className="flex min-w-0 flex-col">
                  <span className="truncate type-body text-ink">{it.label}</span>
                  <span className="type-caption text-ink-3">{weekdayDate(it.date)}</span>
                </span>
                <span className="flex items-center gap-3">
                  <span className="type-figure-sm text-ink">
                    <Money value={it.amount} />
                  </span>
                  {it.debtId && (
                    <Button variant="link" size="sm" onClick={(e) => open(e, () => setPay({ id: it.debtId!, name: debtName(it.debtId!), amount: plainDollars(it.amount) }))}>
                      Log a payment
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        label="Your debts"
        data-testid="section-debts"
        action={
          <Button variant="link" size="sm" onClick={(e) => open(e, () => setEdit({ debt: null }))} data-testid="add-debt">
            Add a debt
          </Button>
        }
        foot={
          <>
            Linking a bank account for debts is coming to{" "}
            <Link href="/household" className="text-moss underline decoration-1 underline-offset-4 hover:text-moss-ink">
              Household
            </Link>
            .
          </>
        }
      >
        {debts.state === "failed" ? (
          <Note kind="error" onRetry={debts.refetch} retrying={debts.isFetching}>
            Couldn't load your debts.
          </Note>
        ) : active.length === 0 ? (
          <Note kind="empty">No debts on the plan yet. Add one to see your payoff.</Note>
        ) : (
          <ul className="flex flex-col">
            {active.map((d) => (
              <li key={d.id} className="flex items-start justify-between gap-3 border-t border-rule py-3 first:border-t-0" data-testid="debt-row">
                <button type="button" className="flex min-w-0 flex-1 flex-col gap-1 text-left" onClick={(e) => open(e, () => setEdit({ debt: d }))} aria-label={`Edit ${d.name}`}>
                  <span className="truncate type-body text-ink">{d.name}</span>
                  <span className="type-caption text-ink-3">
                    {aprWords(d.apr)} APR ({srcWord(d.aprSource)}) · minimum <Money value={d.minPayment} /> ({srcWord(d.minPaymentSource)})
                    {d.dueDay ? ` · due the ${ordinal(d.dueDay)}` : ""}
                  </span>
                </button>
                <Button variant="quiet" size="sm" onClick={(e) => open(e, () => setPay({ id: d.id, name: d.name, amount: "" }))} aria-label={`Log a payment to ${d.name}`}>
                  Log a payment
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {pay && (
        <PaymentSheet
          key={`${pay.id}-${pay.amount}`}
          debt={pay}
          amount={pay.amount}
          today={today}
          onClose={() => setPay(null)}
          onLogged={(t) => {
            invalidate();
            say(t);
          }}
          onError={(t) => say(t, "error")}
          returnFocusRef={returnRef}
        />
      )}
      {edit && (
        <DebtSheet
          key={edit.debt?.id ?? "new"}
          debt={edit.debt}
          onClose={() => setEdit(null)}
          onDone={(t) => {
            invalidate();
            say(t);
          }}
          onError={(t) => say(t, "error")}
          returnFocusRef={returnRef}
        />
      )}
      {toast}
    </PlanFrame>
  );
}
