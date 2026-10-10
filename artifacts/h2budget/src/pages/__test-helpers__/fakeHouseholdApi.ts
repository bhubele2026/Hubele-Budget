import { vi } from "vitest";
import {
  createFakeLedgerServer,
  ledgerRow,
  type FakeCall,
  type FakeLedgerServer,
  type FakeRowInput,
} from "./fakeLedgerServer";

/**
 * (WP7d) A fetch-level stand-in for ONE household, so the account pages run
 * with the REAL generated hooks and the REAL embedded ledgers (the Chase and
 * Amex pages), answered like the server would answer them.
 *
 * It composes `createFakeLedgerServer` for the bank ledger (GET
 * /transactions/ledger and /balances, the bulk writes, UI preferences) and adds
 * what the account pages read around it:
 *   - GET /plaid/items: the household's items and accounts;
 *   - GET /transactions (the list): `from`, `to`, `source` (comma list),
 *     `plaidAccountId` (exact; a row with no Plaid account never matches and an
 *     empty value matches nothing — WP7a's contract) and `limit`, newest first;
 *   - GET /spine and GET /forecast: the bank balance, its snapshot account and
 *     the linked depository accounts (`listCheckingAccounts` with its twin
 *     collapse);
 *   - debts, weekly payoff, liabilities, categories, mapping rules, settings and
 *     the Amex anchor: empty, the shapes the pages expect — except (WP8b) a
 *     card named in `cardBalances`, whose Plaid liability balance GET
 *     /plaid/liability-accounts lists and the per-card GET /amex/anchor answers.
 * Anything else answers 404 and is recorded (`unknown()`), so a test can see an
 * endpoint it did not plan for.
 *
 * The bank ledger's scope is the server's (`bankLedger.ts`): the snapshot's
 * account, its mask twins and the rows with no Plaid account whose source names
 * no card (manual rows). Any other DEPOSITORY account lists its own rows with no
 * balance (`otherAccounts`); a card, a loan, an investment account and every
 * account in `refuse` answer 400 `account_not_ledger`.
 */

export type FakeAccountType = "depository" | "credit" | "loan" | "investment";

export type FakeItem = { id: string; institutionName: string; institutionSlug: string };

export type FakeAccount = {
  /** The test's name for the account. */
  key: string;
  /** `plaid_accounts.id` (the internal row id). */
  id: string;
  /** Plaid's external `account_id` (what a transaction carries). */
  accountId: string;
  /** The item's `id` (an entry of `items`). */
  item: string;
  name: string;
  mask: string | null;
  type: FakeAccountType;
  subtype: string;
};

export type FakeHouseholdRow = Omit<FakeRowInput, "plaidAccountId"> & {
  /** The account's `key`, or null for a row with no Plaid account. */
  account: string | null;
  /** A raw external id for a row on an account that is NOT linked (no longer linked). */
  plaidAccountIdOverride?: string;
  source: string;
};

export type FakeHouseholdOptions = {
  /** The household's today (YYYY-MM-DD). */
  today: string;
  items: FakeItem[];
  accounts: FakeAccount[];
  rows: FakeHouseholdRow[];
  /** The account the bank balance reads (its `key`). */
  snapshotAccount: string;
  /** Its mask twins (keys): on its ledger, as the server lists them. */
  twins?: string[];
  /** Linked accounts the ledger refuses anyway (keys): unlinked between the list and the ledger. */
  refuse?: string[];
  /** The bank balance today. */
  balanceToday?: string;
  /**
   * (WP8b) Plaid's stored liability balance per card (`key` → figure), as GET
   * /plaid/liability-accounts lists it and GET /amex/anchor?accountId= answers
   * it (`source: "plaid"`). A card not named has no figure (`missing`).
   */
  cardBalances?: Record<string, { balance: string; lastFetchedAt: string }>;
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const isDepository = (a: FakeAccount) => a.subtype === "checking" || a.type === "depository" || a.subtype === "savings";
const isCardSource = (source: string) => {
  const s = source.toLowerCase();
  return s === "amex" || s.startsWith("plaid:");
};

export function createFakeHouseholdApi(opts: FakeHouseholdOptions) {
  const byKey = new Map(opts.accounts.map((a) => [a.key, a]));
  const extOf = (r: FakeHouseholdRow): string | null =>
    r.plaidAccountIdOverride ?? (r.account ? byKey.get(r.account)!.accountId : null);
  const snapshotKeys = new Set([opts.snapshotAccount, ...(opts.twins ?? [])]);
  const refused = new Set(opts.refuse ?? []);
  const asLedgerInput = (r: FakeHouseholdRow): FakeRowInput => {
    const { account: _account, plaidAccountIdOverride: _override, ...rest } = r;
    return { ...rest, plaidAccountId: extOf(r) };
  };

  // The bank ledger, scoped as the server scopes it.
  const snapshotRows = opts.rows.filter((r) =>
    r.account ? snapshotKeys.has(r.account) : !r.plaidAccountIdOverride && !isCardSource(r.source),
  );
  const otherAccounts: Record<string, FakeRowInput[]> = {};
  const refusedAccounts: string[] = [];
  for (const a of opts.accounts) {
    if (snapshotKeys.has(a.key)) continue;
    if (!isDepository(a) || refused.has(a.key)) {
      refusedAccounts.push(a.id);
      continue;
    }
    otherAccounts[a.id] = opts.rows.filter((r) => r.account === a.key).map(asLedgerInput);
  }
  const ledger: FakeLedgerServer = createFakeLedgerServer({
    rows: snapshotRows.map(asLedgerInput),
    today: opts.today,
    otherAccounts,
    refusedAccounts,
    balanceToday: opts.balanceToday ?? "1000.00",
    balanceStart: null,
    balanceEnd: opts.balanceToday ?? "1000.00",
  });

  // The list endpoint's rows, shaped like the generated `Transaction`.
  const listRows = opts.rows.map((r) => ({ ...ledgerRow(asLedgerInput(r)), plaidAccountId: extOf(r) }));
  const snapshot = byKey.get(opts.snapshotAccount)!;
  const itemOf = (id: string) => opts.items.find((i) => i.id === id)!;

  // `listCheckingAccounts`: every depository account, twins collapsed onto the snapshot's.
  const checkingAccounts = opts.accounts
    .filter((a) => isDepository(a) && !(opts.twins ?? []).includes(a.key))
    .map((a) => ({
      id: a.id,
      accountId: a.accountId,
      name: a.name,
      mask: a.mask,
      subtype: a.subtype,
      institutionName: itemOf(a.item).institutionName,
    }));

  const calls: FakeCall[] = [];
  const unknownCalls: string[] = [];

  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    const url = new URL(raw, "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const q = url.searchParams;
    calls.push({ method, path: url.pathname, query: q, body: init?.body ? JSON.parse(String(init.body)) : undefined });

    switch (url.pathname) {
      case "/api/transactions/ledger":
      case "/api/transactions/balances":
      case "/api/transactions/bulk-update":
      case "/api/transactions/bulk-review-matching":
      case "/api/me/ui-preferences":
        return ledger.fetch(input, init);
    }
    if (method !== "GET") {
      unknownCalls.push(`${method} ${url.pathname}`);
      return json(404, { error: `no fake for ${method} ${url.pathname}` });
    }
    switch (url.pathname) {
      case "/api/transactions": {
        const from = q.get("from");
        const to = q.get("to");
        const sources = (q.get("source") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        const hasAccount = q.has("plaidAccountId");
        const account = q.get("plaidAccountId") ?? "";
        const limit = Number(q.get("limit") ?? "500");
        const out = listRows
          .filter((t) => {
            const day = t.occurredOn.slice(0, 10);
            if (from && day < from) return false;
            if (to && day > to) return false;
            if (sources.length && !sources.includes(t.source)) return false;
            // WP7a: exact; a row with no Plaid account never matches; empty matches nothing.
            if (hasAccount && (account === "" || t.plaidAccountId !== account)) return false;
            return true;
          })
          .sort((a, b) => (a.occurredOn !== b.occurredOn ? (a.occurredOn < b.occurredOn ? 1 : -1) : a.id < b.id ? 1 : -1))
          .slice(0, limit);
        return json(200, out);
      }
      case "/api/plaid/items":
        return json(
          200,
          opts.items.map((it) => ({
            id: it.id,
            itemId: `item-${it.id}`,
            institutionName: it.institutionName,
            institutionSlug: it.institutionSlug,
            lastSyncedAt: `${opts.today}T11:00:00.000Z`,
            lastSyncError: null,
            lastSyncErrorCode: null,
            lastBankTxOn: opts.today,
            consentExpirationAt: null,
            accounts: opts.accounts
              .filter((a) => a.item === it.id)
              .map((a) => ({ id: a.id, accountId: a.accountId, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype, snapshot: null })),
          })),
        );
      case "/api/spine":
        return json(200, {
          asOf: `${opts.today}T12:00:00.000Z`,
          bank: {
            balance: opts.balanceToday ?? "1000.00",
            asOfDate: `${opts.today}T11:00:00.000Z`,
            source: "plaid",
            lastContactAt: null,
            lastFailureAt: null,
            stale: false,
            staleReason: null,
            snapshot: { balance: opts.balanceToday ?? "1000.00", at: `${opts.today}T11:00:00.000Z`, source: "plaid" },
            sinceSnapshot: { net: "0.00", count: 0, through: opts.today },
            account: { rowId: snapshot.id, externalId: snapshot.accountId, name: snapshot.name, mask: snapshot.mask, subtype: snapshot.subtype, via: "pointer" },
          },
          reviewCount: 0,
        });
      case "/api/forecast":
        return json(200, {
          bankSnapshot: {
            balance: opts.balanceToday ?? "1000.00",
            at: `${opts.today}T11:00:00.000Z`,
            source: "plaid",
            accountId: snapshot.id,
            name: snapshot.name,
            mask: snapshot.mask,
          },
          accountSnapshots: {},
          resolutions: [],
          plaidCheckingAccounts: checkingAccounts,
          today: opts.today,
        });
      case "/api/forecast/cash-signal":
        return json(200, { daily: [], events: [], account: null, status: "no_data" });
      case "/api/plaid/liability-accounts":
        return json(
          200,
          Object.entries(opts.cardBalances ?? {}).map(([key, fig]) => {
            const a = byKey.get(key)!;
            const it = itemOf(a.item);
            return {
              id: a.id,
              accountId: a.accountId,
              itemId: a.item,
              name: a.name,
              officialName: null,
              mask: a.mask,
              type: a.type,
              subtype: a.subtype,
              liabilityKind: "credit",
              balance: fig.balance,
              apr: null,
              minPayment: null,
              lastFetchedAt: fig.lastFetchedAt,
              institutionId: null,
              institutionName: it.institutionName,
              institutionSlug: it.institutionSlug,
              linkedDebt: null,
              suggestedDebt: null,
            };
          }),
        );
      case "/api/debts":
      case "/api/budget/categories":
      case "/api/mapping-rules":
        return json(200, []);
      case "/api/amex/weekly-payoff":
        return json(200, { weekStart: opts.today, weekEnd: opts.today, combinedWeekCharges: 0, combinedStatementBalance: 0, cards: [] });
      case "/api/amex/anchor": {
        const card = opts.accounts.find((a) => a.accountId === q.get("accountId"));
        const fig = card ? opts.cardBalances?.[card.key] : undefined;
        return fig
          ? json(200, { amexEndingBalance: Number(fig.balance), asOf: fig.lastFetchedAt, source: "plaid" })
          : json(200, { amexEndingBalance: null, asOf: `${opts.today}T12:00:00.000Z`, source: "missing" });
      }
      case "/api/settings":
        return json(200, { preferences: {} });
    }
    unknownCalls.push(`GET ${url.pathname}`);
    return json(404, { error: `no fake for GET ${url.pathname}` });
  };

  return {
    fetch: vi.fn(handler),
    ledger,
    calls,
    /** GET /transactions (the list) requests so far. */
    listGets: () => calls.filter((c) => c.method === "GET" && c.path === "/api/transactions"),
    /** Endpoints asked that this fake does not answer. */
    unknown: () => [...unknownCalls],
  };
}

export type FakeHouseholdApi = ReturnType<typeof createFakeHouseholdApi>;
