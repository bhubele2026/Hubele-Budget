import type { BankingCheckExplain, BankingCheckExplainRow } from "@workspace/api-client-react/features";
import { dayOf } from "@/lib/accountFreshness";
import { dayTimeOf } from "@/lib/checkingWords";
import { formatCurrency } from "@/lib/utils";

/**
 * ⭐ (T2) "REVIEW DIFFERENCE", IN WORDS — what the last balance check compared,
 * and what H2 can and cannot explain about it. Every figure is
 * `GET /banking/check-explain`'s; this file only chooses words (no sums: the
 * "between" net is the server's own `counted.net`). Pure, so the exact lines
 * are pinned in `checkExplainWords.test.ts`.
 */

export interface ExplainRowLine {
  id: string;
  /** "CARD PAYMENT (logged) · −$432.00 · Oct 14" */
  text: string;
}

export interface ExplainLine {
  key: "previous" | "bank" | "expected" | "difference" | "excluded" | "added" | "manual" | "since" | "counted";
  label: string;
  value: string;
  rows: ExplainRowLine[];
  /** A short note under the value (e.g. why a row list matters). */
  note?: string | null;
}

export interface ExplainWords {
  /** "Balance check · Oct 15, 7:02 AM" */
  title: string;
  lines: ExplainLine[];
  /** The plain verdict; null when there is no difference to explain. */
  verdict: string | null;
  /** The account, named: "Sample Bank Everyday Checking ••0001" */
  account: string | null;
}

/** "−$432.00" / "+$12.00" for a signed row amount. */
export function signedMoney(v: string | number): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n === 0 ? formatCurrency(0) : `${n < 0 ? "−" : "+"}${formatCurrency(Math.abs(n))}`;
}

const NONE = "none";

function rowLines(rows: readonly BankingCheckExplainRow[], tail?: string): ExplainRowLine[] {
  return rows.map((r) => ({
    id: r.id,
    text: [r.description?.trim() || "Row", signedMoney(r.amount), dayOf(r.date), r.pending ? "pending" : null, tail ?? null]
      .filter(Boolean)
      .join(" · "),
  }));
}

/** "(bank, available)": where the reading came from, in the bank's own field. */
function fieldWords(field: string | null | undefined): string {
  return field ? ` (bank, ${field})` : "";
}

/** "$432.00 · Oct 14, 7:00 AM" */
function readingWords(r: { balance: string; at: string } | null | undefined): string {
  if (!r) return "—";
  const when = dayTimeOf(r.at);
  return `${formatCurrency(r.balance)}${when ? ` · ${when}` : ""}`;
}

export function checkExplainWords(e: BankingCheckExplain): ExplainWords {
  const rec = e.record;
  const at = rec?.bank?.at ?? rec?.checkedAt ?? e.check.checkedAt;
  const when = dayTimeOf(at);
  const title = `Balance check${when ? ` · ${when}` : ""}`;
  const name = [e.account.institution, e.account.name].filter(Boolean).join(" ");
  const account = name ? `${name}${e.account.mask ? ` ••${e.account.mask.slice(-4)}` : ""}` : null;

  if (!rec) {
    return { title, account, lines: [], verdict: null };
  }

  const lines: ExplainLine[] = [];
  lines.push({
    key: "previous",
    label: "Previous reading",
    value: `${readingWords(rec.prevAnchor)}${fieldWords(rec.prevAnchor?.field)}`,
    rows: [],
  });
  lines.push({ key: "bank", label: "Bank reading at the check", value: readingWords(rec.bank), rows: [] });

  if (rec.predicted != null) {
    const n = e.counted.rowCount;
    const between = e.counted.listed
      ? ` = previous reading + ${n} bank ${n === 1 ? "row" : "rows"} between (${signedMoney(e.counted.net).replace(/^\+/, "")})`
      : "";
    const addedAmt = e.added.amount != null && Number(e.added.amount) !== 0 ? ` + deposits added (${formatCurrency(e.added.amount)})` : "";
    lines.push({
      key: "expected",
      label: "H2 expected",
      value: `${formatCurrency(rec.predicted)}${between}${e.counted.listed ? addedAmt : ""}`,
      rows: rowLines(e.counted.rows),
      note: e.counted.addsUp === false ? "Rows changed since the check, so these no longer add up to what H2 expected then." : null,
    });
  }

  if (e.check.difference != null && rec.status !== "not_checked") {
    const way = e.check.direction === "bank_lower" ? " — bank lower" : e.check.direction === "bank_higher" ? " — bank higher" : "";
    lines.push({ key: "difference", label: "Difference", value: `${formatCurrency(e.check.difference)}${way}`, rows: [] });
  }

  const listOrNone = (amount: string | null, rows: BankingCheckExplainRow[]): string =>
    rows.length === 0 && (amount == null || Number(amount) === 0) ? NONE : amount != null ? signedMoney(amount) : `${rows.length}`;

  lines.push({
    key: "excluded",
    label: "Left out (pending deposits the bank's figure does not hold)",
    value: listOrNone(e.excluded.amount, e.excluded.rows),
    rows: rowLines(e.excluded.rows),
  });
  lines.push({
    key: "added",
    label: "Added (deposits that posted since the previous reading)",
    value: listOrNone(e.added.amount, e.added.rows),
    rows: rowLines(e.added.rows),
  });
  lines.push({
    key: "manual",
    label: "Rows H2 recorded itself (not from the bank)",
    value: listOrNone(e.manualRows.amount, e.manualRows.rows),
    rows: rowLines(e.manualRows.rows, "counts in H2's balance, not in the bank's rows"),
  });
  lines.push({
    key: "since",
    label: "Arrived since the check",
    value: e.rowsSince.count === 0 ? NONE : `${e.rowsSince.count} ${e.rowsSince.count === 1 ? "row" : "rows"}`,
    rows: rowLines(e.rowsSince.rows),
  });

  return { title, account, lines, verdict: verdictWords(e) };
}

/** The plain verdict, from the server's `verdict` and its figures. */
export function verdictWords(e: BankingCheckExplain): string | null {
  const diff = e.check.difference != null ? formatCurrency(e.check.difference) : null;
  switch (e.verdict) {
    case "late_rows_tie":
      return "Rows that arrived after the check explain it (Resolved since).";
    case "manual_rows_match":
      return "The rows H2 recorded itself add up to the difference. They count in H2's balance today; the bank's own rows did not show them at the check.";
    case "unknown": {
      const day = dayOf(e.check.checkedAt);
      const t = e.today;
      const agree =
        t.sameMoment && t.h2Balance != null && t.bankReading != null && Math.round(Number(t.h2Balance) * 100) === Math.round(Number(t.bankReading) * 100);
      const now = agree ? ` H2 now starts from the bank's ${formatCurrency(t.bankReading!)} reading, so today's balances agree.` : "";
      const history = diff ? ` The next Sync checks again from the bank's current figure; if they agree then, this check stays in history as "was off by ${diff}${day ? ` on ${day}` : ""}".` : "";
      return `H2 can't find what explains ${diff ? `this ${diff}` : "this difference"}.${now}${history}`;
    }
    default:
      return null;
  }
}
