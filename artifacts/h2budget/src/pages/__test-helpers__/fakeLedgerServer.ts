import { vi } from "vitest";
import type { LedgerRow } from "@workspace/api-client-react";

/**
 * (PR14) A fetch-level stand-in for the Chase ledger endpoints, so page tests
 * run the REAL generated hooks (infinite paging, bulk review, UI preferences)
 * against answers shaped like the server's.
 *
 * It follows the PR13 contract where the page depends on it:
 * - GET /api/transactions/ledger: filters (`from`, `to`, `pending`, `reviewed`,
 *   `categoryId`, `uncategorized`), newest first, `limit` (default 50) and an
 *   opaque cursor (here the offset). `matchingCount` counts every filter;
 *   `totals` and `review` every filter except `reviewed`; totals sum
 *   `balanceAmount`.
 * - GET /api/transactions/balances: the balance per date from `balanceByDate`,
 *   else null.
 * - POST /api/transactions/bulk-update: sets `reviewed`; `failReviewIds` answer
 *   ok:false, and `failBulkUpdateCall` (1-based) answers 500 for that request.
 * - POST /api/transactions/bulk-review-matching: 400 `too_many_rows` over
 *   1,000, 409 `matching_count_changed` when the count is not `expectedCount`,
 *   else marks the rows.
 * - GET/PUT /api/me/ui-preferences: a merged object.
 * - GET /api/transactions (the old list): answers [] and is recorded, so a test
 *   can prove nothing called it.
 *
 * Balances are fixed by the test (`balanceStart`/`balanceEnd`/`balanceToday`),
 * not computed: the page must show what the server says, not re-derive it.
 */

export type FakeRowInput = Partial<LedgerRow> & { id: string; occurredOn: string };

export function ledgerRow(r: FakeRowInput): LedgerRow {
  const amount = r.amount ?? "-10.00";
  return {
    description: r.id,
    occurredAt: null,
    account: null,
    categoryId: null,
    forecastFlag: false,
    weeklyAllowance: false,
    weeklyBucket: null,
    monthlyAllowance: false,
    unplannedAllowance: false,
    reimbursable: false,
    reimbursed: false,
    isTransfer: false,
    notes: null,
    source: "manual",
    member: null,
    owedBy: null,
    plaidTransactionId: null,
    plaidAccountId: null,
    debtId: null,
    matchedRuleId: null,
    pending: false,
    reviewed: false,
    runningBalance: null,
    balanceAmount: r.countsInBalance === false ? "0.00" : amount,
    countsInBalance: true,
    balanceReason: "counted",
    replacedPendingId: null,
    heldAhead: false,
    afterToday: false,
    stalePending: false,
    ...r,
    amount,
  } as unknown as LedgerRow;
}

export type FakeLedgerOptions = {
  rows: FakeRowInput[];
  today?: string;
  balanceStart?: string | null;
  balanceEnd?: string | null;
  balanceToday?: string | null;
  balanceByDate?: Record<string, string | null>;
  prefs?: Record<string, unknown>;
  failReviewIds?: string[];
  /** Answer 500 on this bulk-update request (1 = the first). */
  failBulkUpdateCall?: number;
  /** Answer every ledger GET with this status (and `ledgerErrorCode`). */
  ledgerStatus?: number;
  ledgerErrorCode?: string;
  /** (PR14 review H1) Answer the first N ledger GETs with 500, then normally. */
  ledgerFailures?: number;
  /**
   * (PR14 review H1) Accounts other than the snapshot's: `account=<id>` lists these
   * rows with every balance null and `balanceUnavailableReason: "not_snapshot_account"`.
   */
  otherAccounts?: Record<string, FakeRowInput[]>;
  /** (PR14 review H1) `account=<id>` answers 400 `account_not_ledger`. */
  refusedAccounts?: string[];
  /** Holds a ledger GET until the returned promise settles (to observe a loading state). */
  holdLedger?: (query: URLSearchParams) => Promise<void> | undefined;
};

export type FakeCall = {
  method: string;
  path: string;
  query: URLSearchParams;
  body: any;
};

type Filter = {
  from?: string;
  to?: string;
  pending?: boolean;
  reviewed?: boolean;
  categoryId?: string;
  uncategorized?: boolean;
};

const boolParam = (v: string | null): boolean | undefined =>
  v === "true" ? true : v === "false" ? false : undefined;

function newestFirst(a: LedgerRow, b: LedgerRow): number {
  if (a.occurredOn !== b.occurredOn) return a.occurredOn < b.occurredOn ? 1 : -1;
  const at = a.occurredAt ?? null;
  const bt = b.occurredAt ?? null;
  if (at !== bt) {
    if (at === null) return 1;
    if (bt === null) return -1;
    return at < bt ? 1 : -1;
  }
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

const cents = (s: string) => Math.round(Number(s) * 100);
const money = (c: number) => (c / 100).toFixed(2);

export function createFakeLedgerServer(opts: FakeLedgerOptions) {
  const rows: LedgerRow[] = opts.rows.map(ledgerRow);
  const otherRows = new Map<string, LedgerRow[]>(
    Object.entries(opts.otherAccounts ?? {}).map(([id, list]) => [
      id,
      list.map((r) => ({ ...ledgerRow(r), balanceAmount: null, runningBalance: null }) as unknown as LedgerRow),
    ]),
  );
  const allRows = () => [...rows, ...Array.from(otherRows.values()).flat()];
  let ledgerGetCount = 0;
  const prefs: Record<string, unknown> = { ...(opts.prefs ?? {}) };
  const calls: FakeCall[] = [];
  const today = opts.today ?? "2026-09-16";
  let bulkUpdateCalls = 0;

  const matches = (t: LedgerRow, f: Filter, ignoreReviewed = false) => {
    const day = t.occurredOn.slice(0, 10);
    if (f.from && day < f.from) return false;
    if (f.to && day > f.to) return false;
    if (f.pending !== undefined && !!t.pending !== f.pending) return false;
    if (!ignoreReviewed && f.reviewed !== undefined && !!t.reviewed !== f.reviewed) return false;
    if (f.categoryId && t.categoryId !== f.categoryId) return false;
    if (f.uncategorized && t.categoryId) return false;
    return true;
  };

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const anchor = () => ({
    today,
    todayBalance: opts.balanceToday ?? null,
    snapshotBalance: null,
    snapshotAt: null,
    snapshotDay: null,
  });
  const account = { via: "pointer", plaidAccountIds: [] as string[] };

  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw =
      typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const url = new URL(raw, "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, query: url.searchParams, body });
    const q = url.searchParams;

    if (url.pathname === "/api/transactions/ledger" && method === "GET") {
      ledgerGetCount += 1;
      const hold = opts.holdLedger?.(q);
      if (hold) await hold;
      if (opts.ledgerStatus) {
        return json(opts.ledgerStatus, { error: "refused", code: opts.ledgerErrorCode ?? "error" });
      }
      if (opts.ledgerFailures && ledgerGetCount <= opts.ledgerFailures) {
        return json(500, { error: "boom" });
      }
      const accountParam = q.get("account");
      if (accountParam && opts.refusedAccounts?.includes(accountParam)) {
        return json(400, { error: "not a ledger account", code: "account_not_ledger" });
      }
      const other = accountParam ? otherRows.get(accountParam) : undefined;
      const scopeRows = other ?? rows;
      const f: Filter = {
        from: q.get("from") ?? undefined,
        to: q.get("to") ?? undefined,
        pending: boolParam(q.get("pending")),
        reviewed: boolParam(q.get("reviewed")),
        categoryId: q.get("categoryId") ?? undefined,
        uncategorized: q.get("uncategorized") === "true",
      };
      const limit = Number(q.get("limit") ?? "50");
      const offset = Number(q.get("cursor") ?? "0");
      const matching = scopeRows.filter((t) => matches(t, f)).sort(newestFirst);
      const base = scopeRows.filter((t) => matches(t, f, true));
      let moneyIn = 0;
      let moneyOut = 0;
      for (const t of base) {
        const c =
          t.balanceAmount != null ? cents(t.balanceAmount) : t.countsInBalance ? cents(t.amount) : 0;
        if (c > 0) moneyIn += c;
        else moneyOut -= c;
      }
      const reviewed = base.filter((t) => t.reviewed).length;
      return json(200, {
        rows: matching.slice(offset, offset + limit),
        nextCursor: offset + limit < matching.length ? String(offset + limit) : null,
        limit,
        matchingCount: matching.length,
        totals: { count: base.length, moneyIn: money(moneyIn), moneyOut: money(moneyOut), net: money(moneyIn - moneyOut) },
        review: { reviewed, unreviewed: base.length - reviewed },
        balanceStart: other ? null : (opts.balanceStart ?? null),
        balanceEnd: other ? null : (opts.balanceEnd ?? null),
        balanceToday: other ? null : (opts.balanceToday ?? null),
        balanceUnavailableReason: other
          ? "not_snapshot_account"
          : opts.balanceToday == null
            ? "no_snapshot"
            : null,
        anchor: other ? { ...anchor(), todayBalance: null } : anchor(),
        account,
      });
    }

    if (url.pathname === "/api/transactions/balances" && method === "GET") {
      const dates = (q.get("dates") ?? "").split(",").filter(Boolean);
      return json(200, {
        balances: dates.map((date) => ({
          date,
          balance: q.get("account") && otherRows.has(q.get("account")!) ? null : (opts.balanceByDate?.[date] ?? null),
        })),
        balanceUnavailableReason:
          q.get("account") && otherRows.has(q.get("account")!)
            ? "not_snapshot_account"
            : opts.balanceToday == null
              ? "no_snapshot"
              : null,
        anchor: anchor(),
        account,
      });
    }

    if (url.pathname === "/api/transactions/bulk-update" && method === "POST") {
      bulkUpdateCalls += 1;
      if (opts.failBulkUpdateCall === bulkUpdateCalls) return json(500, { error: "boom" });
      const ids: string[] = body.ids;
      const results = ids.map((id) => {
        if (opts.failReviewIds?.includes(id)) return { id, ok: false, error: "retry" };
        const row = allRows().find((t) => t.id === id);
        if (row && body.patch?.reviewed !== undefined) row.reviewed = body.patch.reviewed;
        return { id, ok: true };
      });
      return json(200, {
        results,
        updated: results.filter((r) => r.ok).length,
        affectedMonths: [],
      });
    }

    if (url.pathname === "/api/transactions/bulk-review-matching" && method === "POST") {
      // (PR14 second review N1) As the server: reviewing by filter must exclude pending rows.
      if (body.reviewed === true && body.filter?.pending !== false) {
        return json(400, { error: "exclude pending rows", code: "pending_not_excluded" });
      }
      const scope = body.filter?.account ? (otherRows.get(body.filter.account) ?? rows) : rows;
      const matched = scope.filter((t) => matches(t, body.filter ?? {}));
      if (matched.length > 1000) {
        return json(400, { error: "too many", code: "too_many_rows" });
      }
      if (matched.length !== body.expectedCount) {
        return json(409, {
          error: "the matching rows changed",
          code: "matching_count_changed",
          matchingCount: matched.length,
        });
      }
      const updatedIds: string[] = [];
      for (const t of matched) {
        if (!!t.reviewed !== body.reviewed) {
          t.reviewed = body.reviewed;
          updatedIds.push(t.id);
        }
      }
      return json(200, { matched: matched.length, updated: updatedIds.length, updatedIds });
    }

    if (url.pathname === "/api/me/ui-preferences") {
      if (method === "PUT") Object.assign(prefs, body);
      return json(200, prefs);
    }

    if (url.pathname === "/api/transactions" && method === "GET") {
      return json(200, []);
    }

    return json(404, { error: `no fake for ${method} ${url.pathname}` });
  };

  return {
    fetch: vi.fn(handler),
    rows,
    prefs,
    calls,
    addRow: (r: FakeRowInput) => {
      rows.push(ledgerRow(r));
    },
    /** Ledger GETs, oldest first, optionally only those whose `from` is given. */
    /** GET /transactions/balances requests so far. */
    balanceGets: () => calls.filter((c) => c.path === "/api/transactions/balances"),
    ledgerGets: (from?: string) =>
      calls.filter(
        (c) =>
          c.path === "/api/transactions/ledger" &&
          c.method === "GET" &&
          (from === undefined || c.query.get("from") === from),
      ),
  };
}

export type FakeLedgerServer = ReturnType<typeof createFakeLedgerServer>;
