import { and, eq, inArray, ne, sql, type SQL } from "drizzle-orm";
import {
  db,
  budgetCategoriesTable,
  forecastSettingsTable,
  merchantAliasesTable,
  plaidAccountsTable,
  plaidItemsTable,
  transactionsTable,
} from "@workspace/db";
import { computeCashSignal } from "./cashSignal";
import { householdDayOf, householdTodayISO } from "./householdClock";
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
 * Three rules hold it together:
 *
 *   1. SCOPE = THE BANK BALANCE'S OWN RULE. A row is on the ledger when the bank
 *      balance counts it (`isBankRow` in lib/forecastLedger.ts): its Plaid
 *      account is the one the snapshot resolves to, or it has no Plaid account
 *      and its source is neither "amex" nor "plaid:*". Plus the resolved
 *      account's mask twins (same institution, mask, type and subtype), which
 *      the Chase page has always collapsed into one account (#462). A register
 *      that left out a row the balance counts could never reconcile.
 *
 *   2. ONE REGISTER. Every balance here is an anchor plus a running sum over the
 *      account's rows in ledger order (oldest first: occurred_on, occurred_at
 *      nulls first, id). The anchor is chosen so the balance at the end of today
 *      IS `computeCashSignal().bankToday`, the spine's bank balance, from the
 *      same call the spine makes: the snapshot rule (`isInSnapshot`) is reused,
 *      never re-derived. By construction a row's running balance is the previous
 *      row's plus its amount, `balanceStart` plus the range's amounts is
 *      `balanceEnd`, and none of it depends on the non-date filters or the page.
 *
 *   3. FILTERS IN SQL. Paging, counts and totals never see a partial list.
 *
 * ⚠️ WHAT THE REGISTER IS NOT: a replay of the bank's `available` balance on past
 * days. Every row sits on its own date at its full amount, so wherever the bank
 * balance counts a row differently, the days before that row move and today does
 * not:
 *   - a charge the snapshot already held but dated after the snapshot day
 *     (`isInSnapshot` rule 3): the days in between read higher than `available`;
 *   - a pending row its posted row replaced, or a posting that adds only its tip
 *     (PR4c, `pairPendingWithPosted`): the balance counts the charge once, the
 *     register lists both rows;
 *   - a mask-twin row, which the bank balance does not count at all.
 * Today's balance is exact in every case; the earlier days are a register.
 */

export const LEDGER_BALANCE_DATES_MAX = 120;
export const BULK_REVIEW_MATCHING_MAX = 1000;
/** The horizon `/spine` passes to `computeCashSignal`. `bankToday` does not depend on it; matching it keeps the call identical. */
const SPINE_HORIZON_DAYS = 90;

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

// ── Input checks ────────────────────────────────────────────────────────────

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** A real calendar day as YYYY-MM-DD, so 2026-02-30 is refused before Postgres sees it. */
export function isCalendarDay(s: string): boolean {
  if (!ISO_DAY.test(s)) return false;
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
  const out: LedgerFilter = {};
  for (const key of ["from", "to"] as const) {
    const v = f[key];
    if (v === undefined || v === "") continue;
    if (!isCalendarDay(v)) throw bad("invalid_filter", `${key} must be a YYYY-MM-DD date`);
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
  if (t !== null && (typeof t !== "string" || !CURSOR_TIME.test(t) || Number.isNaN(Date.parse(t)))) {
    throw invalid;
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
  /** The Plaid account ids on the ledger: the resolved account and its mask twins. */
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

// ── SQL ─────────────────────────────────────────────────────────────────────

/**
 * `acct`: the account's rows, one copy per Plaid transaction id (the bank
 * balance skips a repeated id too; `transactions_plaid_txn_uq` makes both
 * defensive). `reg`: `acct` plus `cum`, the running sum in ledger order.
 * Postgres inlines CTEs, so a query that never reads `reg` never pays for the
 * window.
 */
function ledgerCtes(accounts: LedgerAccounts): SQL {
  const t = transactionsTable;
  const onAccount =
    accounts.plaidAccountIds.length > 0 ? inArray(t.plaidAccountId, accounts.plaidAccountIds) : sql`false`;
  // SQL twin of `isBankRow` (lib/forecastLedger.ts). An empty plaid_account_id
  // is falsy there, so it means "no Plaid account" here too.
  const bankRow = sql`(${onAccount} or (nullif(${t.plaidAccountId}, '') is null and lower(${t.source}) <> 'amex' and lower(${t.source}) not like 'plaid:%'))`;
  return sql`
    copies as (
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
        ${t.description} as description,
        row_number() over (
          partition by coalesce(nullif(${t.plaidTransactionId}, ''), ${t.id}::text)
          order by ${t.id}
        ) as copy_rank
      from ${t}
      where ${t.householdId} = ${accounts.householdId}::uuid
        and ${bankRow}
    ),
    acct as (
      select id, occurred_on, occurred_at, amount, reviewed, pending, source, member, category_id, description
      from copies
      where copy_rank = 1
    ),
    reg as (
      select acct.*,
        sum(amount) over (
          order by occurred_on, occurred_at nulls first, id
          rows between unbounded preceding and current row
        ) as cum
      from acct
    )`;
}

function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/** The filter over alias `r` (acct or reg), with categories joined as `c`. */
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

export type LedgerPage = {
  rows: Array<Record<string, unknown> & { runningBalance: string | null }>;
  nextCursor: string | null;
  limit: number;
  matchingCount: number;
  totals: { count: number; moneyIn: string; moneyOut: string; net: string };
  review: { reviewed: number; unreviewed: number };
  balanceStart: string | null;
  balanceEnd: string | null;
  anchor: LedgerAnchor;
  account: { via: string; plaidAccountIds: string[] };
};

export async function readLedgerPage(
  scope: LedgerScope,
  filter: LedgerFilter,
  limit: number,
  cursor: LedgerCursor | null,
): Promise<LedgerPage> {
  const tb = scope.anchor.todayBalance;
  const today = scope.anchor.today;
  const cats = budgetCategoriesTable;

  // Balance after a row = today's balance − the sum through today + the running sum.
  const running = tb === null ? sql`null::text` : sql`(${tb}::numeric - s.through_today + r.cum)::text`;
  const pageQuery = db.execute(sql`
    with ${ledgerCtes(scope)},
    sums as (
      select coalesce(sum(amount) filter (where occurred_on <= ${today}::date), 0) as through_today
      from acct
    )
    select
      r.id::text as id,
      r.occurred_on::text as occurred_on,
      case when r.occurred_at is null then null
        else to_char(r.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end as occurred_at_key,
      ${running} as running_balance
    from reg r
    cross join sums s
    left join ${cats} c on c.id = r.category_id
    where ${filterWhere(filter, true)}
      and ${cursor ? afterCursor(cursor) : sql`true`}
    order by r.occurred_on desc, r.occurred_at desc nulls last, r.id desc
    limit ${limit + 1}
  `);

  const withoutReviewed = filterWhere(filter, false);
  const balanceAfter = (through: SQL) =>
    tb === null
      ? sql`null::text`
      : sql`(${tb}::numeric - coalesce(sum(r.amount) filter (where r.occurred_on <= ${today}::date), 0) + ${through})::text`;
  const startThrough = filter.from
    ? sql`coalesce(sum(r.amount) filter (where r.occurred_on < ${filter.from}::date), 0)`
    : sql`0`;
  const endThrough = filter.to
    ? sql`coalesce(sum(r.amount) filter (where r.occurred_on <= ${filter.to}::date), 0)`
    : sql`coalesce(sum(r.amount), 0)`;
  const aggregateQuery = db.execute(sql`
    with ${ledgerCtes(scope)}
    select
      count(*) filter (where ${filterWhere(filter, true)})::int as matching_count,
      count(*) filter (where ${withoutReviewed})::int as total_count,
      round(coalesce(sum(r.amount) filter (where ${withoutReviewed} and r.amount >= 0), 0), 2)::text as money_in,
      round(coalesce(-sum(r.amount) filter (where ${withoutReviewed} and r.amount < 0), 0), 2)::text as money_out,
      round(coalesce(sum(r.amount) filter (where ${withoutReviewed}), 0), 2)::text as net,
      count(*) filter (where ${withoutReviewed} and r.reviewed)::int as reviewed_count,
      count(*) filter (where ${withoutReviewed} and not r.reviewed)::int as unreviewed_count,
      ${balanceAfter(startThrough)} as balance_start,
      ${balanceAfter(endThrough)} as balance_end
    from acct r
    left join ${cats} c on c.id = r.category_id
  `);

  const [pageResult, aggregateResult] = await Promise.all([pageQuery, aggregateQuery]);
  const pageRows = rowsOf<{
    id: string;
    occurred_on: string;
    occurred_at_key: string | null;
    running_balance: string | null;
  }>(pageResult);
  const [agg] = rowsOf<{
    matching_count: number;
    total_count: number;
    money_in: string;
    money_out: string;
    net: string;
    reviewed_count: number;
    unreviewed_count: number;
    balance_start: string | null;
    balance_end: string | null;
  }>(aggregateResult);

  const hasMore = pageRows.length > limit;
  const pageSlice = hasMore ? pageRows.slice(0, limit) : pageRows;
  const last = pageSlice[pageSlice.length - 1];
  const nextCursor =
    hasMore && last ? encodeLedgerCursor({ d: last.occurred_on, t: last.occurred_at_key, i: last.id }) : null;

  const full = await loadAnnotatedRows(scope.householdId, pageSlice.map((r) => r.id));
  const rows: LedgerPage["rows"] = [];
  for (const r of pageSlice) {
    const row = full.get(r.id);
    // A row deleted between the two reads is dropped, not invented.
    if (row) rows.push({ ...row, runningBalance: r.running_balance });
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
    balanceStart: agg?.balance_start ?? null,
    balanceEnd: agg?.balance_end ?? null,
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
    if (!isCalendarDay(d)) throw bad("invalid_dates", `${d} is not a YYYY-MM-DD date`);
  }
  return dates;
}

/** End-of-day balances on the ledger's register, in the order asked (repeats allowed). */
export async function readLedgerBalances(
  scope: LedgerScope,
  dates: string[],
): Promise<Array<{ date: string; balance: string | null }>> {
  const tb = scope.anchor.todayBalance;
  if (tb === null) return dates.map((date) => ({ date, balance: null }));
  const values = sql.join(
    Array.from(new Set(dates)).map((d) => sql`(${d}::date)`),
    sql`, `,
  );
  const result = await db.execute(sql`
    with ${ledgerCtes(scope)},
    sums as (
      select coalesce(sum(amount) filter (where occurred_on <= ${scope.anchor.today}::date), 0) as through_today
      from acct
    ),
    days(d) as (values ${values})
    select
      days.d::text as date,
      (${tb}::numeric - (select through_today from sums) + coalesce(sum(a.amount), 0))::text as balance
    from days
    left join acct a on a.occurred_on <= days.d
    group by days.d
  `);
  const byDate = new Map(rowsOf<{ date: string; balance: string }>(result).map((r) => [r.date, r.balance]));
  return dates.map((date) => ({ date, balance: byDate.get(date) ?? null }));
}

// ── Write ───────────────────────────────────────────────────────────────────

/**
 * Sets `reviewed` on every ledger row matching `filter`, all or nothing.
 *
 * The matching rows are locked (in id order) before they are counted, so the
 * count the 409 compares and the rows the update touches are the same rows: a
 * row inserted after the lock is neither counted nor changed.
 */
export async function bulkReviewMatching(
  accounts: LedgerAccounts,
  filter: LedgerFilter,
  reviewed: boolean,
  expectedCount: number,
): Promise<{ matched: number; updated: number; updatedIds: string[] }> {
  const t = transactionsTable;
  return db.transaction(async (tx) => {
    const locked = await tx.execute(sql`
      select ${t.id}::text as id
      from ${t}
      where ${t.householdId} = ${accounts.householdId}::uuid
        and ${t.id} in (
          with ${ledgerCtes(accounts)}
          select r.id
          from acct r
          left join ${budgetCategoriesTable} c on c.id = r.category_id
          where ${filterWhere(filter, true)}
        )
      order by ${t.id}
      limit ${BULK_REVIEW_MATCHING_MAX + 1}
      for update
    `);
    const ids = rowsOf<{ id: string }>(locked).map((r) => r.id);
    if (ids.length > BULK_REVIEW_MATCHING_MAX) {
      throw bad("too_many_rows", `more than ${BULK_REVIEW_MATCHING_MAX} rows match; narrow the filter`);
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
