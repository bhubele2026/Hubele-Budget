import { and, asc, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import {
  db,
  budgetCategoriesTable,
  forecastSettingsTable,
  merchantAliasesTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import {
  classifyCashRows,
  inForecast,
  isInSnapshot,
  type CashRow,
  type CashRowOutcome,
} from "@workspace/avalanche-core";
import { computeCashSignal } from "./cashSignal";
import { addDaysISO, householdDayOf, householdTodayISO } from "./householdClock";
import {
  resolveSnapshotAccount,
  type SnapshotAccountResolution,
} from "./resolveSnapshotAccount";
import { findMatchedRuleId, loadUserRules } from "./autoCategorize";
import { cleanMerchant, merchantSignature } from "./merchantNameExtract";

/**
 * ⭐ THE BANK LEDGER, PAGED ON THE SERVER (PR13).
 *
 * The Chase page used to pull up to 1,000 rows for the whole household and
 * derive its totals and running balances from whatever arrived. This module
 * answers the same questions over EVERY row of the account, one page at a time.
 *
 *   1. SCOPE IS SETTLED HERE. A row is on the ledger when the bank balance reads
 *      it (`isBankRow`): its Plaid account is the one the snapshot resolves to,
 *      or it has no Plaid account and its source is neither "amex" nor "plaid:*".
 *      Plus that account's mask twins (same institution, mask, type and subtype),
 *      which the Chase page has always shown as one account (#462). Manual rows
 *      are in because the bank balance counts them; a client that hides rows the
 *      register counts breaks the running-balance chain, so it must not.
 *
 *   2. WHAT EACH ROW MOVES — `classifyCashRows` (PR4e), the cash rule the bank
 *      balance uses, run over the account's WHOLE history with no anchor. A
 *      counted row moves the register by its amount. A pending row its posted
 *      row replaced, a repeated Plaid transaction id, and a mask-twin row (not
 *      the snapshot's account) move it by 0. `totals` sum the same amounts.
 *      Pairing reads the rows the bank balance reads: every row dated through
 *      today and, after today, only rows flagged for the forecast.
 *
 *   3. ONE REGISTER, THROUGH TODAY. The balance after a row is the opening
 *      balance plus the running sum of those amounts in ledger order (oldest
 *      first: occurred_on, occurred_at nulls first, id). The opening balance is
 *      chosen so the end of today IS `computeCashSignal().bankToday`, the
 *      spine's bank balance, from the same call the spine makes. Rows dated
 *      after today are listed and labelled, but carry no balance, and no day
 *      after today has one: a register is not a projection.
 *
 *   4. FILTERS IN SQL. Paging, counts and totals never see a partial list.
 *
 * ⚠️ OPEN, AND NOT RULES HERE: two double counts, both Brad's decisions
 * (CLAUDE.md §1). `registerAmount` below is where a rule would go.
 *   - A manual "Payment — <debt>" row that `routes/debts.ts` writes beside the
 *     bank's own debit for the same payment counts twice in history, as both
 *     count in the bank balance today.
 *   - A pending row its posted row cannot replace (a hold that posts lower, a
 *     posting above the pairing cap, a merchant name that changes) counts
 *     beside it. Only a row categorised while pending survives the sync's
 *     sweeps to do this. While the snapshot is fresh both rows are inside it, so
 *     cash today does not move, but the register counts both. Such a row is
 *     labelled `stalePending` once it is more than STALE_PENDING_DAYS old.
 *
 * ⚠️ WHAT THE REGISTER IS NOT: a replay of the bank's `available` balance. The
 * bank balance decides some rows by the instant the snapshot was read, and the
 * register puts every row on its own date:
 *   - a charge the snapshot already held but dated after the snapshot day
 *     (`heldAhead`): the days between the snapshot and its date read higher
 *     than the bank showed, by that charge;
 *   - a posting that adds only its tip in the bank balance (PR4c): the register
 *     takes the posted row in full and the pending row at 0;
 *   - pairing over the whole history can pair a posted row with a different
 *     pending row than the bank balance's shorter window does.
 * Today's balance is exact in every case.
 */

export const LEDGER_BALANCE_DATES_MAX = 120;
export const BULK_REVIEW_MATCHING_MAX = 1000;
/** The horizon `/spine` passes to `computeCashSignal`. `bankToday` does not depend on it; matching it keeps the call identical. */
const SPINE_HORIZON_DAYS = 90;
/**
 * A pending row dated more than this many days before the household's today is
 * labelled `stalePending` (PR13 second review, R1). A label only: it moves no
 * number. PR14 flags these rows.
 */
export const STALE_PENDING_DAYS = 14;

/** Still pending, and dated more than STALE_PENDING_DAYS days before `today`. */
export function isStalePending(pending: boolean, occurredOn: string, today: string): boolean {
  return pending && occurredOn < addDaysISO(today, -STALE_PENDING_DAYS);
}

export class LedgerRequestError extends Error {
  constructor(
    readonly status: 400 | 409,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

const bad = (code: string, message: string) => new LedgerRequestError(400, code, message);

// ── Money in cents ──────────────────────────────────────────────────────────

/** `numeric(12,2)` text to integer cents. Exact: at most 12 digits. */
function toCents(amount: string | number): number {
  return Math.round(Number(amount) * 100);
}

function money(cents: number): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

// ── Input checks ────────────────────────────────────────────────────────────

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** A NUL byte: Postgres refuses it in text, so it must never reach a query. */
export function hasNul(s: string): boolean {
  return s.includes("\u0000");
}

/**
 * A real calendar day as YYYY-MM-DD from year 1000, so 2026-02-30 and 0000-01-01
 * (JavaScript has a year 0; Postgres does not) are refused before Postgres sees them.
 */
export function isCalendarDay(s: string): boolean {
  if (!ISO_DAY.test(s) || Number(s.slice(0, 4)) < 1000) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function isUuid(s: string): boolean {
  return UUID.test(s);
}

/** A query-string boolean: exactly "true" or "false". `zod.coerce.boolean()` reads "false" as true. */
export function parseBoolParam(raw: string | undefined, name: string): boolean | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw bad("invalid_filter", `${name} must be "true" or "false"`);
}

export type LedgerFilter = {
  from?: string;
  to?: string;
  search?: string;
  reviewed?: boolean;
  pending?: boolean;
  /** Only `true` filters (rows with no category), as on GET /transactions. */
  uncategorized?: boolean;
  categoryId?: string;
  source?: string;
  member?: string;
};

/** Every key a bulk-review filter may carry. An unknown key is refused, never ignored. */
export const LEDGER_FILTER_KEYS: readonly string[] = [
  "account",
  "from",
  "to",
  "search",
  "reviewed",
  "pending",
  "uncategorized",
  "categoryId",
  "source",
  "member",
];

/** Validates a filter and drops empty values. Throws a 400 `LedgerRequestError`. */
export function checkLedgerFilter(f: LedgerFilter): LedgerFilter {
  for (const key of ["from", "to", "search", "categoryId", "source", "member"] as const) {
    const v = f[key];
    if (typeof v === "string" && hasNul(v)) throw bad("invalid_filter", `${key} must not contain a NUL byte`);
  }
  const out: LedgerFilter = {};
  for (const key of ["from", "to"] as const) {
    const v = f[key];
    if (v === undefined || v === "") continue;
    if (!isCalendarDay(v)) throw bad("invalid_filter", `${key} must be a YYYY-MM-DD date from year 1000`);
    out[key] = v;
  }
  if (out.from && out.to && out.from > out.to) {
    throw bad("invalid_filter", "from must be on or before to");
  }
  const search = f.search?.trim();
  if (search) out.search = search;
  if (f.reviewed !== undefined) out.reviewed = f.reviewed;
  if (f.pending !== undefined) out.pending = f.pending;
  if (f.uncategorized === true) out.uncategorized = true;
  if (f.categoryId !== undefined && f.categoryId !== "") {
    if (!isUuid(f.categoryId)) throw bad("invalid_filter", "categoryId must be a uuid");
    out.categoryId = f.categoryId;
  }
  if (out.uncategorized && out.categoryId) {
    throw bad("invalid_filter", "uncategorized and categoryId cannot be combined");
  }
  if (f.source !== undefined && f.source !== "") out.source = f.source;
  if (f.member !== undefined && f.member !== "") out.member = f.member;
  return out;
}

// ── Cursor ──────────────────────────────────────────────────────────────────

/** The last row of a page: its day, its institution time (UTC, microseconds) or null, and its id. */
export type LedgerCursor = { d: string; t: string | null; i: string };

export function encodeLedgerCursor(c: LedgerCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, d: c.d, t: c.t, i: c.i }), "utf8").toString("base64url");
}

export function decodeLedgerCursor(raw: string): LedgerCursor {
  const invalid = bad("invalid_cursor", "cursor is not a cursor from this endpoint");
  if (hasNul(raw)) throw invalid;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalid;
  }
  if (!parsed || typeof parsed !== "object") throw invalid;
  const { v, d, t, i } = parsed as Record<string, unknown>;
  if (v !== 1) throw invalid;
  if (typeof d !== "string" || !isCalendarDay(d)) throw invalid;
  if (typeof i !== "string" || !isUuid(i)) throw invalid;
  if (t !== null) {
    if (typeof t !== "string" || !CURSOR_TIME.test(t) || Number(t.slice(0, 4)) < 1000) throw invalid;
    // Round-trip to the millisecond: 2026-02-30T… would roll into March.
    const ms = `${t.slice(0, 23)}Z`;
    const at = new Date(ms);
    if (Number.isNaN(at.getTime()) || at.toISOString() !== ms) throw invalid;
  }
  return { d, t: t as string | null, i };
}

/**
 * Rows strictly after the cursor in `occurred_on desc, occurred_at desc nulls
 * last, id desc`. A null time sorts after every real time on its day, so a
 * timed cursor continues into that day's untimed rows and an untimed cursor
 * never goes back to the timed ones.
 */
function afterCursor(c: LedgerCursor): SQL {
  if (c.t === null) {
    return sql`(r.occurred_on < ${c.d}::date or (r.occurred_on = ${c.d}::date and r.occurred_at is null and r.id < ${c.i}::uuid))`;
  }
  return sql`(r.occurred_on < ${c.d}::date or (r.occurred_on = ${c.d}::date and (r.occurred_at < ${c.t}::timestamptz or r.occurred_at is null or (r.occurred_at = ${c.t}::timestamptz and r.id < ${c.i}::uuid))))`;
}

// ── Scope and anchor ────────────────────────────────────────────────────────

export type LedgerAccounts = {
  householdId: string;
  /** The Plaid account the bank balance reads, or null when none resolves. */
  accountExternalId: string | null;
  /** The Plaid account ids on the ledger: that account and its mask twins. */
  plaidAccountIds: string[];
  via: SnapshotAccountResolution["via"];
};

export type LedgerAnchor = {
  /** The household's today (America/Chicago): the day `todayBalance` closes. */
  today: string;
  /** The spine's bank balance, the balance at the end of `today`. Null without a bank snapshot. */
  todayBalance: string | null;
  snapshotBalance: string | null;
  snapshotAt: string | null;
  snapshotDay: string | null;
};

export type LedgerScope = LedgerAccounts & { anchor: LedgerAnchor };

type AccountRow = {
  id: string;
  accountId: string;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  institutionName: string | null;
};

/** The same physical account on a second `plaid_accounts` row (#462): one institution, one mask, one kind of account. */
function isMaskTwin(a: AccountRow, b: AccountRow): boolean {
  if (!a.mask || !b.mask || a.mask !== b.mask || !b.accountId) return false;
  const ai = (a.institutionName ?? "").trim().toLowerCase();
  const bi = (b.institutionName ?? "").trim().toLowerCase();
  if (!ai || ai !== bi) return false;
  return (a.type ?? null) === (b.type ?? null) && (a.subtype ?? null) === (b.subtype ?? null);
}

/**
 * Which rows are on the ledger. `account` (a `plaid_accounts.id`) is optional;
 * when given it must be the resolved account or one of its twins, so a page
 * that asks for one account is never silently answered for another.
 */
export async function resolveLedgerAccounts(
  householdId: string,
  ownerUserId: string,
  account: string | undefined,
): Promise<LedgerAccounts> {
  if (account !== undefined && !isUuid(account)) {
    throw bad("invalid_account", "account must be a uuid");
  }
  const [settings] = await db
    .select({
      bankSnapshotAccountId: forecastSettingsTable.bankSnapshotAccountId,
      bankSnapshotMask: forecastSettingsTable.bankSnapshotMask,
    })
    .from(forecastSettingsTable)
    .where(eq(forecastSettingsTable.userId, ownerUserId));
  const resolved = await resolveSnapshotAccount({
    householdId,
    bankSnapshotAccountId: settings?.bankSnapshotAccountId ?? null,
    bankSnapshotMask: settings?.bankSnapshotMask ?? null,
  });

  const accounts: AccountRow[] = resolved.rowId
    ? await db
        .select({
          id: plaidAccountsTable.id,
          accountId: plaidAccountsTable.accountId,
          mask: plaidAccountsTable.mask,
          type: plaidAccountsTable.type,
          subtype: plaidAccountsTable.subtype,
          institutionName: plaidItemsTable.institutionName,
        })
        .from(plaidAccountsTable)
        .leftJoin(plaidItemsTable, eq(plaidItemsTable.id, plaidAccountsTable.itemId))
        .where(eq(plaidAccountsTable.householdId, householdId))
    : [];
  const anchorRow = accounts.find((a) => a.id === resolved.rowId) ?? null;
  const members = anchorRow
    ? accounts.filter((a) => a.id === anchorRow.id || isMaskTwin(anchorRow, a))
    : [];
  if (account !== undefined && !members.some((m) => m.id === account)) {
    throw bad("account_not_ledger", "account is not the bank snapshot's account; only that account has a ledger");
  }
  return {
    householdId,
    accountExternalId: resolved.externalId,
    plaidAccountIds: resolved.externalId
      ? Array.from(new Set([resolved.externalId, ...members.map((m) => m.accountId)]))
      : [],
    via: resolved.via,
  };
}

/** Today's bank balance and the snapshot it rolls from, exactly as the spine reads them. */
export async function readLedgerAnchor(householdId: string, ownerUserId: string): Promise<LedgerAnchor> {
  const [[settings], signal] = await Promise.all([
    db
      .select({ bankSnapshotBalance: forecastSettingsTable.bankSnapshotBalance })
      .from(forecastSettingsTable)
      .where(eq(forecastSettingsTable.userId, ownerUserId)),
    // ⚠️ The spine's call, unchanged: its `bank.balance` IS this `bankToday`.
    computeCashSignal(householdId, ownerUserId, { horizonDays: SPINE_HORIZON_DAYS }),
  ]);
  const snapshotBalance = settings?.bankSnapshotBalance ?? null;
  // Without a snapshot the cash signal's `bankToday` is the starting balance,
  // which belongs to no day, so there is nothing to anchor a register on.
  const hasSnapshot = snapshotBalance !== null && signal.snapshotAt !== null;
  return {
    today: signal.fromDate ?? householdTodayISO(),
    todayBalance: hasSnapshot ? signal.bankToday : null,
    snapshotBalance,
    snapshotAt: signal.snapshotAt,
    snapshotDay: signal.snapshotAt ? householdDayOf(signal.snapshotAt) : null,
  };
}

export async function resolveLedgerScope(
  householdId: string,
  ownerUserId: string,
  account: string | undefined,
): Promise<LedgerScope> {
  const accounts = await resolveLedgerAccounts(householdId, ownerUserId, account);
  const anchor = await readLedgerAnchor(householdId, ownerUserId);
  return { ...accounts, anchor };
}

// ── The register ────────────────────────────────────────────────────────────

/**
 * Why a row moves the register by what it does:
 * - `counted`: by its amount;
 * - `superseded`: 0 — a pending row its posted row replaced (PR4c);
 * - `duplicate`: 0 — a second row with the same Plaid transaction id;
 * - `not_bank`: 0 — a mask-twin row; the bank balance reads only the snapshot's account.
 */
export type BalanceReason = "counted" | "superseded" | "duplicate" | "not_bank";

export type RegisterRow = {
  id: string;
  occurredOn: string;
  balanceCents: number;
  countsInBalance: boolean;
  balanceReason: BalanceReason;
  /** For a posted row that replaced a pending row: that pending row's id. */
  replacedPendingId: string | null;
  /** Dated after the snapshot day, but already inside the snapshot balance. */
  heldAhead: boolean;
  /** Running sum of `balanceCents` through this row, in ledger order. */
  cumCents: number;
};

export type Register = {
  byId: Map<string, RegisterRow>;
  /** Ledger order, oldest first. */
  ordered: RegisterRow[];
  /** The balance before the account's first row. Null without a bank snapshot. */
  openingCents: number | null;
  today: string;
};

/**
 * ⭐ WHAT ONE ROW MOVES THE REGISTER BY. `classifyCashRows` ran with no anchor,
 * so no row is `held` and none is `adjusted`: every row the cash rule counts
 * moves the register by its full amount, and every other row by 0.
 *
 * ⚠️ OPEN — Brad's decisions (CLAUDE.md §1), two of them:
 *   - a manual "Payment — <debt>" row logged beside the bank's own debit for
 *     that payment. Both count today, here and in the bank balance;
 *   - a leftover pending row its posted row cannot replace (`stalePending`
 *     after STALE_PENDING_DAYS). Both count here; the proposal is to count a
 *     stale one as 0.
 * A rule for either belongs here, as one more reason that moves a row by 0, and
 * in the bank balance's rule at the same time.
 */
function registerAmount(
  outcome: CashRowOutcome,
  amountCents: number,
): { cents: number; counts: boolean; reason: BalanceReason } {
  switch (outcome.reason) {
    case "counted":
      return { cents: amountCents, counts: true, reason: "counted" };
    case "superseded":
    case "duplicate":
    case "not_bank":
      return { cents: 0, counts: false, reason: outcome.reason };
    case "held":
    case "adjusted":
      throw new Error(`classifyCashRows returned "${outcome.reason}" without an anchor`);
  }
}

/**
 * Loads every row of the account, in ledger order, and works out what each moves
 * the register by and the running sum through it. The register reads the whole
 * history because a double count anywhere in it moves every balance before it.
 */
export async function loadRegister(scope: LedgerScope): Promise<Register> {
  const t = transactionsTable;
  const rows = await db
    .select({
      id: t.id,
      occurredOn: t.occurredOn,
      occurredAt: t.occurredAt,
      amount: t.amount,
      createdAt: t.createdAt,
      pending: t.pending,
      description: t.description,
      source: t.source,
      plaidAccountId: t.plaidAccountId,
      plaidTransactionId: t.plaidTransactionId,
      forecastFlag: t.forecastFlag,
    })
    .from(t)
    .where(and(eq(t.householdId, scope.householdId), bankRowWhere(scope.plaidAccountIds)))
    .orderBy(asc(t.occurredOn), sql`${t.occurredAt} asc nulls first`, asc(t.id));

  // The fields `toCashRow` (lib/ledgerCashRows.ts) maps, read from the columns selected above.
  const cashRows: CashRow[] = rows.map((r) => ({
    id: r.id,
    occurredOn: r.occurredOn,
    amount: Number(r.amount) || 0,
    createdAt: r.createdAt,
    occurredAt: r.occurredAt ? new Date(r.occurredAt) : null,
    pending: !!r.pending,
    description: r.description ?? null,
    source: r.source ?? null,
    plaidAccountId: r.plaidAccountId ?? null,
    plaidTransactionId: r.plaidTransactionId ?? null,
  }));
  const today = scope.anchor.today;

  // ⭐ WHICH ROWS PAIR (second review, R2). `bankToday` reads every row dated
  // through today and, after today, only rows flagged for the forecast
  // (`inForecast`). A posted row it does not read cannot replace a pending row
  // for it, so that pending row counts today. The register pairs the same rows:
  // the rows the bank balance reads go through one `classifyCashRows` run, and
  // the unflagged rows after today through a run of their own, so none of them
  // replaces a row the bank balance counts. Each row is classified once, and
  // each run keeps ledger order.
  const readByBank: number[] = [];
  const unreadAfterToday: number[] = [];
  rows.forEach((r, i) => (inForecast(r, today) ? readByBank : unreadAfterToday).push(i));
  const outcomes: CashRowOutcome[] = new Array(rows.length);
  for (const part of [readByBank, unreadAfterToday]) {
    if (part.length === 0) continue;
    classifyCashRows(
      part.map((i) => cashRows[i]!),
      { anchor: null, accountExternalId: scope.accountExternalId, todayISO: today },
    ).rows.forEach((outcome, k) => {
      outcomes[part[k]!] = outcome;
    });
  }

  // `heldAhead` (R3): the anchored cash rule's `held`, for a row dated after the
  // snapshot day. That rule holds a row when `isInSnapshot` holds it and, for a
  // posted row that replaced a pending row, holds that pending row too. Pairing
  // does not depend on the anchor, so the pairs above serve; a second, anchored
  // `classifyCashRows` run over the whole history is not needed.
  const anchor =
    scope.anchor.snapshotAt && scope.anchor.snapshotDay
      ? { at: new Date(scope.anchor.snapshotAt), day: scope.anchor.snapshotDay }
      : null;
  const indexById = new Map(rows.map((r, i) => [r.id, i] as const));
  const held = (i: number): boolean => anchor !== null && isInSnapshot(cashRows[i]!, anchor.at, anchor.day);

  const ordered: RegisterRow[] = [];
  let cum = 0;
  let throughToday = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const outcome = outcomes[i]!;
    const { cents, counts, reason } = registerAmount(outcome, toCents(row.amount));
    cum += cents;
    if (row.occurredOn <= today) throughToday += cents;
    const replacedIndex = outcome.replacedId === null ? undefined : indexById.get(outcome.replacedId);
    ordered.push({
      id: row.id,
      occurredOn: row.occurredOn,
      balanceCents: cents,
      countsInBalance: counts,
      balanceReason: reason,
      replacedPendingId: outcome.replacedId,
      heldAhead:
        anchor !== null &&
        row.occurredOn > anchor.day &&
        held(i) &&
        (replacedIndex === undefined || held(replacedIndex)),
      cumCents: cum,
    });
  }
  const tb = scope.anchor.todayBalance;
  return {
    byId: new Map(ordered.map((r) => [r.id, r])),
    ordered,
    openingCents: tb === null ? null : toCents(tb) - throughToday,
    today,
  };
}

/** The balance at the end of `day`: null without a snapshot, or for a day after today. */
export function balanceAtEndOf(reg: Register, day: string): string | null {
  if (reg.openingCents === null || day > reg.today) return null;
  let lo = 0;
  let hi = reg.ordered.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (reg.ordered[mid]!.occurredOn <= day) lo = mid + 1;
    else hi = mid;
  }
  return money(reg.openingCents + (lo === 0 ? 0 : reg.ordered[lo - 1]!.cumCents));
}

function runningBalanceOf(reg: Register, row: RegisterRow): string | null {
  if (reg.openingCents === null || row.occurredOn > reg.today) return null;
  return money(reg.openingCents + row.cumCents);
}

// ── SQL ─────────────────────────────────────────────────────────────────────

/** SQL twin of `isBankRow`, widened to the mask twins. An empty plaid_account_id is "no Plaid account", as in JavaScript. */
function bankRowWhere(plaidAccountIds: string[]): SQL {
  const t = transactionsTable;
  const onAccount = plaidAccountIds.length > 0 ? inArray(t.plaidAccountId, plaidAccountIds) : sql`false`;
  return sql`(${onAccount} or (nullif(${t.plaidAccountId}, '') is null and lower(${t.source}) <> 'amex' and lower(${t.source}) not like 'plaid:%'))`;
}

/**
 * `acct`: the account's rows. `bal`: the same rows with `balance_amount`, what
 * each moves the register by — its amount, except the rows `overrides` names
 * (from `loadRegister`).
 */
function ledgerCtes(accounts: LedgerAccounts, overrides: Array<{ id: string; amount: string }>): SQL {
  const t = transactionsTable;
  return sql`
    acct as (
      select
        ${t.id} as id,
        ${t.occurredOn} as occurred_on,
        ${t.occurredAt} as occurred_at,
        ${t.amount} as amount,
        ${t.reviewed} as reviewed,
        ${t.pending} as pending,
        ${t.source} as source,
        ${t.member} as member,
        ${t.categoryId} as category_id,
        ${t.description} as description
      from ${t}
      where ${t.householdId} = ${accounts.householdId}::uuid
        and ${bankRowWhere(accounts.plaidAccountIds)}
    ),
    overrides as (
      select (e->>'id')::uuid as id, (e->>'amount')::numeric as amount
      from jsonb_array_elements(${JSON.stringify(overrides)}::jsonb) as e
    ),
    bal as (
      select acct.*, coalesce(o.amount, acct.amount) as balance_amount
      from acct
      left join overrides o on o.id = acct.id
    )`;
}

function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/** The filter over alias `r` (acct or bal), with categories joined as `c`. */
function filterWhere(f: LedgerFilter, withReviewed: boolean): SQL {
  const parts: SQL[] = [sql`true`];
  if (f.from) parts.push(sql`r.occurred_on >= ${f.from}::date`);
  if (f.to) parts.push(sql`r.occurred_on <= ${f.to}::date`);
  if (f.pending !== undefined) parts.push(sql`r.pending = ${f.pending}`);
  if (f.uncategorized) parts.push(sql`r.category_id is null`);
  if (f.categoryId) parts.push(sql`r.category_id = ${f.categoryId}::uuid`);
  if (f.source !== undefined) parts.push(sql`r.source = ${f.source}`);
  if (f.member !== undefined) parts.push(sql`coalesce(r.member, '') = ${f.member}`);
  if (f.search) {
    parts.push(sql`(r.description || ' ' || coalesce(c.name, '')) ilike ${likePattern(f.search)}`);
  }
  if (withReviewed && f.reviewed !== undefined) parts.push(sql`r.reviewed = ${f.reviewed}`);
  return sql.join(parts, sql` and `);
}

function rowsOf<T>(result: unknown): T[] {
  return ((result as { rows?: T[] }).rows ?? (result as T[])) as T[];
}

// ── Reads ───────────────────────────────────────────────────────────────────

export type LedgerPageRow = Record<string, unknown> & {
  runningBalance: string | null;
  balanceAmount: string;
  countsInBalance: boolean;
  balanceReason: BalanceReason;
  replacedPendingId: string | null;
  heldAhead: boolean;
  afterToday: boolean;
  /** Still pending and dated more than STALE_PENDING_DAYS before today. A label only. */
  stalePending: boolean;
};

export type LedgerPage = {
  rows: LedgerPageRow[];
  nextCursor: string | null;
  limit: number;
  matchingCount: number;
  totals: { count: number; moneyIn: string; moneyOut: string; net: string };
  review: { reviewed: number; unreviewed: number };
  balanceStart: string | null;
  balanceEnd: string | null;
  balanceToday: string | null;
  anchor: LedgerAnchor;
  account: { via: string; plaidAccountIds: string[] };
};

export async function readLedgerPage(
  scope: LedgerScope,
  filter: LedgerFilter,
  limit: number,
  cursor: LedgerCursor | null,
): Promise<LedgerPage> {
  const cats = budgetCategoriesTable;
  const today = scope.anchor.today;

  const pageQuery = db.execute(sql`
    with ${ledgerCtes(scope, [])}
    select
      r.id::text as id,
      r.occurred_on::text as occurred_on,
      r.amount::text as amount,
      case when r.occurred_at is null then null
        else to_char(r.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end as occurred_at_key
    from acct r
    left join ${cats} c on c.id = r.category_id
    where ${filterWhere(filter, true)}
      and ${cursor ? afterCursor(cursor) : sql`true`}
    order by r.occurred_on desc, r.occurred_at desc nulls last, r.id desc
    limit ${limit + 1}
  `);
  const [register, pageResult] = await Promise.all([loadRegister(scope), pageQuery]);

  const overrides = register.ordered
    .filter((r) => !r.countsInBalance)
    .map((r) => ({ id: r.id, amount: money(r.balanceCents) }));
  const withoutReviewed = filterWhere(filter, false);
  const aggregateQuery = db.execute(sql`
    with ${ledgerCtes(scope, overrides)}
    select
      count(*) filter (where ${filterWhere(filter, true)})::int as matching_count,
      count(*) filter (where ${withoutReviewed})::int as total_count,
      round(coalesce(sum(r.balance_amount) filter (where ${withoutReviewed} and r.balance_amount > 0), 0), 2)::text as money_in,
      round(coalesce(-sum(r.balance_amount) filter (where ${withoutReviewed} and r.balance_amount < 0), 0), 2)::text as money_out,
      round(coalesce(sum(r.balance_amount) filter (where ${withoutReviewed}), 0), 2)::text as net,
      count(*) filter (where ${withoutReviewed} and r.reviewed)::int as reviewed_count,
      count(*) filter (where ${withoutReviewed} and not r.reviewed)::int as unreviewed_count
    from bal r
    left join ${cats} c on c.id = r.category_id
  `);

  const pageRows = rowsOf<{ id: string; occurred_on: string; amount: string; occurred_at_key: string | null }>(
    pageResult,
  );
  const hasMore = pageRows.length > limit;
  const pageSlice = hasMore ? pageRows.slice(0, limit) : pageRows;
  const last = pageSlice[pageSlice.length - 1];
  const nextCursor =
    hasMore && last ? encodeLedgerCursor({ d: last.occurred_on, t: last.occurred_at_key, i: last.id }) : null;

  const [aggregateResult, full] = await Promise.all([
    aggregateQuery,
    loadAnnotatedRows(scope.householdId, pageSlice.map((r) => r.id)),
  ]);
  const [agg] = rowsOf<{
    matching_count: number;
    total_count: number;
    money_in: string;
    money_out: string;
    net: string;
    reviewed_count: number;
    unreviewed_count: number;
  }>(aggregateResult);

  const rows: LedgerPageRow[] = [];
  for (const r of pageSlice) {
    const row = full.get(r.id);
    // A row deleted between the reads is dropped, not invented.
    if (!row) continue;
    const reg = register.byId.get(r.id);
    rows.push({
      ...row,
      // A row written after the register was read has no balance in this response.
      runningBalance: reg ? runningBalanceOf(register, reg) : null,
      balanceAmount: reg ? money(reg.balanceCents) : money(toCents(r.amount)),
      countsInBalance: reg ? reg.countsInBalance : true,
      balanceReason: reg ? reg.balanceReason : "counted",
      replacedPendingId: reg?.replacedPendingId ?? null,
      heldAhead: reg?.heldAhead ?? false,
      afterToday: r.occurred_on > today,
      stalePending: isStalePending(row.pending === true, r.occurred_on, today),
    });
  }

  let balanceStart: string | null = null;
  if (register.openingCents !== null) {
    balanceStart = filter.from
      ? balanceAtEndOf(register, addDaysISO(filter.from, -1))
      : money(register.openingCents);
  }

  return {
    rows,
    nextCursor,
    limit,
    matchingCount: Number(agg?.matching_count ?? 0),
    totals: {
      count: Number(agg?.total_count ?? 0),
      moneyIn: agg?.money_in ?? "0.00",
      moneyOut: agg?.money_out ?? "0.00",
      net: agg?.net ?? "0.00",
    },
    review: {
      reviewed: Number(agg?.reviewed_count ?? 0),
      unreviewed: Number(agg?.unreviewed_count ?? 0),
    },
    balanceStart,
    balanceEnd: balanceAtEndOf(register, filter.to ?? today),
    balanceToday: scope.anchor.todayBalance,
    anchor: scope.anchor,
    account: { via: scope.via, plaidAccountIds: scope.plaidAccountIds },
  };
}

/**
 * The full rows, annotated as GET /transactions annotates them (matchedRuleId,
 * merchantSignature, displayName), keyed by id. GET /transactions keeps its own
 * copy of this block: that route is deliberately untouched in PR13.
 */
async function loadAnnotatedRows(
  householdId: string,
  ids: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (ids.length === 0) return out;
  const [rows, userRules, aliasRows] = await Promise.all([
    db
      .select()
      .from(transactionsTable)
      .where(and(eq(transactionsTable.householdId, householdId), inArray(transactionsTable.id, ids))),
    loadUserRules(householdId),
    db
      .select({ signature: merchantAliasesTable.signature, alias: merchantAliasesTable.alias })
      .from(merchantAliasesTable)
      .where(eq(merchantAliasesTable.householdId, householdId)),
  ]);
  const aliasBySignature = new Map(aliasRows.map((a) => [a.signature, a.alias]));
  for (const r of rows) {
    const sig = merchantSignature(r.description);
    const alias = sig ? aliasBySignature.get(sig) : undefined;
    out.set(r.id, {
      ...r,
      matchedRuleId: findMatchedRuleId(r.description, r.categoryId, userRules),
      merchantSignature: sig,
      displayName: alias ?? cleanMerchant(r.description),
    });
  }
  return out;
}

/** Parses `dates` (comma-separated YYYY-MM-DD). Throws a 400 `LedgerRequestError`. */
export function parseBalanceDates(raw: string): string[] {
  const dates = raw.split(",").map((d) => d.trim());
  if (dates.some((d) => d === "")) {
    throw bad("invalid_dates", "dates must be a comma-separated list of YYYY-MM-DD dates");
  }
  if (dates.length > LEDGER_BALANCE_DATES_MAX) {
    throw bad("too_many_dates", `at most ${LEDGER_BALANCE_DATES_MAX} dates per request`);
  }
  for (const d of dates) {
    if (!isCalendarDay(d)) throw bad("invalid_dates", "every date must be a YYYY-MM-DD date from year 1000");
  }
  return dates;
}

/** End-of-day balances on the ledger's register, in the order asked. Null after today and without a snapshot. */
export async function readLedgerBalances(
  scope: LedgerScope,
  dates: string[],
): Promise<Array<{ date: string; balance: string | null }>> {
  if (scope.anchor.todayBalance === null) return dates.map((date) => ({ date, balance: null }));
  const register = await loadRegister(scope);
  return dates.map((date) => ({ date, balance: balanceAtEndOf(register, date) }));
}

// ── Write ───────────────────────────────────────────────────────────────────

/**
 * Sets `reviewed` on every ledger row matching `filter`, all or nothing.
 *
 * 1. Lock the matching rows in id order. The locking statement picks them from
 *    its own snapshot, so a row changed by a transaction it waited for is still
 *    locked even if it no longer matches.
 * 2. Pick the matching rows again, in a new statement that sees that change. A
 *    different set is a 409: something moved while we waited.
 * 3. Only then compare the count with `expectedCount`, and write.
 */
export async function bulkReviewMatching(
  accounts: LedgerAccounts,
  filter: LedgerFilter,
  reviewed: boolean,
  expectedCount: number,
): Promise<{ matched: number; updated: number; updatedIds: string[] }> {
  const t = transactionsTable;
  const matching = sql`
    with ${ledgerCtes(accounts, [])}
    select r.id
    from acct r
    left join ${budgetCategoriesTable} c on c.id = r.category_id
    where ${filterWhere(filter, true)}`;
  return db.transaction(async (tx) => {
    const locked = await tx.execute(sql`
      select ${t.id}::text as id
      from ${t}
      where ${t.householdId} = ${accounts.householdId}::uuid
        and ${t.id} in (${matching})
      order by ${t.id}
      limit ${BULK_REVIEW_MATCHING_MAX + 1}
      for update
    `);
    const ids = rowsOf<{ id: string }>(locked).map((r) => r.id);
    if (ids.length > BULK_REVIEW_MATCHING_MAX) {
      throw bad("too_many_rows", `more than ${BULK_REVIEW_MATCHING_MAX} rows match; narrow the filter`);
    }
    const again = rowsOf<{ id: string }>(
      await tx.execute(sql`
        select m.id::text as id from (${matching}) m
        order by m.id
        limit ${BULK_REVIEW_MATCHING_MAX + 1}
      `),
    ).map((r) => r.id);
    if (again.length !== ids.length || again.some((id, k) => id !== ids[k])) {
      throw new LedgerRequestError(
        409,
        "matching_rows_changed",
        "the matching rows changed while the request waited; nothing was changed",
        { matchingCount: again.length },
      );
    }
    if (ids.length !== expectedCount) {
      throw new LedgerRequestError(
        409,
        "matching_count_changed",
        `${ids.length} rows match now, not ${expectedCount}; nothing was changed`,
        { matchingCount: ids.length },
      );
    }
    if (ids.length === 0) return { matched: 0, updated: 0, updatedIds: [] };
    const updated = await tx
      .update(t)
      .set({ reviewed })
      .where(and(eq(t.householdId, accounts.householdId), inArray(t.id, ids), ne(t.reviewed, reviewed)))
      .returning({ id: t.id });
    return { matched: ids.length, updated: updated.length, updatedIds: updated.map((r) => r.id) };
  });
}
