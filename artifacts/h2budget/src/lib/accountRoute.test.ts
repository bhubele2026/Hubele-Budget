import { describe, it, expect } from "vitest";
import type { PlaidItemDetail } from "@workspace/api-client-react";
import { buildEntries } from "@/pages/next/accounts/entries";
import { accountPageHref, txnRoute, type TxnRouteRef } from "./accountRoute";
import { accountPageHref as accountPageHrefDirect } from "./accountPage";
import { AMEX_SOURCES } from "./amexSources";

// One household, built the way the items response arrives: the external Plaid
// `account_id` (what a transaction carries) and the internal row id (what debts
// and settings key on) differ on every account.
const item = (id: string, institutionName: string, institutionSlug: string, accounts: object[]) =>
  ({ id, itemId: `i-${id}`, institutionName, institutionSlug, lastSyncedAt: "2026-10-08T12:00:00Z", lastSyncError: null, accounts }) as unknown as PlaidItemDetail;
const acct = (id: string, accountId: string, o: object) => ({ id, accountId, name: null, mask: null, type: "depository", subtype: "checking", ...o });

const ITEMS = [
  item("chase", "Chase", "chase", [
    acct("r-chk", "ext-chk", { name: "Total Checking", mask: "5526" }),
    acct("r-sav", "ext-sav", { name: "Savings", mask: "8801", subtype: "savings" }),
    acct("r-free", "ext-freedom", { name: "Freedom", mask: "4433", type: "credit", subtype: "credit card" }),
  ]),
  item("amex", "American Express", "amex", [acct("r-blue", "ext-blue", { name: "Blue Cash Preferred", mask: "1001", type: "credit", subtype: "credit card" })]),
  item("cu", "Summit Credit Union", "summit-cu", [acct("r-cu", "ext/cu 1", { name: "Share Checking", mask: "7007" })]),
  item("upstart", "Upstart", "upstart", [acct("r-loan", "ext-loan", { name: "Personal Loan", mask: "9009", type: "loan", subtype: "loan" })]),
];
const ENTRIES = buildEntries(ITEMS);
const BY_EXT = new Map(ENTRIES.map((e) => [e.plaidAccountId, e]));

const txn = (o: Partial<TxnRouteRef> & { id?: string }): TxnRouteRef => ({
  id: "t1",
  occurredOn: "2026-09-14",
  plaidAccountId: null,
  source: "manual",
  ...o,
});

describe("txnRoute — where a transaction opens", () => {
  it.each([
    ["checking", "ext-chk", "plaid:chase", "Chase Total Checking ••5526"],
    ["savings", "ext-sav", "plaid:chase", "Chase Savings ••8801"],
    ["a non-Amex card", "ext-freedom", "plaid:chase", "Chase Freedom ••4433"],
    ["the Amex card", "ext-blue", "plaid:amex", "American Express Blue Cash Preferred ••1001"],
    ["a loan", "ext-loan", "plaid:upstart", "Upstart Personal Loan ••9009"],
  ])("a row on a linked %s opens that account's page, on the row and its month", (_kind, ext, source, label) => {
    const r = txnRoute(txn({ plaidAccountId: ext, source }), ENTRIES);
    expect(r.kind).toBe("account");
    expect(r.href).toBe(`/next/accounts/${ext}?tx=t1&month=2026-09-01`);
    expect(r.label).toBe(label);
    expect(r.note).toBeNull();
    expect(r.identity.known).toBe(true);
  });

  it("encodes the account id and the row id in the href", () => {
    const r = txnRoute(txn({ id: "id with/slash", plaidAccountId: "ext/cu 1", source: "plaid:summit-cu" }), ENTRIES);
    expect(r.href).toBe("/next/accounts/ext%2Fcu%201?tx=id%20with%2Fslash&month=2026-09-01");
  });

  it("reads entries as an array or a Map, the same", () => {
    const t = txn({ plaidAccountId: "ext-blue", source: "plaid:amex" });
    expect(txnRoute(t, BY_EXT)).toEqual(txnRoute(t, ENTRIES));
  });

  it("the internal row id on a transaction is not its account: it never matches", () => {
    const r = txnRoute(txn({ plaidAccountId: "r-chk", source: "plaid:chase" }), ENTRIES);
    expect(r.kind).toBe("none");
    expect(r.href).toBeNull();
  });

  it("an Amex workbook row opens the Amex page's All cards view (no per-card view lists it)", () => {
    const r = txnRoute(txn({ source: "amex", occurredOn: "2026-08-31" }), ENTRIES);
    expect(r).toMatchObject({ kind: "cards", href: "/amex?tx=t1&month=2026-08-01", label: "Amex (imported) · All cards", note: null });
    expect(r.identity.known).toBe(false);
  });

  it("an unlinked Amex Plaid row opens All cards too: the Amex page lists every row of its sources", () => {
    const r = txnRoute(txn({ plaidAccountId: "ext-old-amex", source: "plaid:amex" }), ENTRIES);
    expect(r).toMatchObject({ kind: "cards", href: "/amex?tx=t1&month=2026-09-01", note: null });
    expect(r.label).toBe("American Express (no longer linked) · All cards");
    for (const source of AMEX_SOURCES) {
      expect(txnRoute(txn({ plaidAccountId: null, source }), ENTRIES).kind, source).toBe("cards");
    }
  });

  it.each([
    ["a manual entry", "manual"],
    ["an imported bank file", "xlsx"],
    ["a row with no source at all", ""],
  ])("%s with no Plaid account opens the checking ledger (the bank balance counts it)", (_name, source) => {
    const r = txnRoute(txn({ source }), ENTRIES);
    expect(r).toMatchObject({ kind: "bank", href: "/transactions?tx=t1&month=2026-09-01", label: "Checking ledger", note: null });
  });

  it("an empty or blank Plaid account id is no Plaid account", () => {
    expect(txnRoute(txn({ plaidAccountId: "", source: "manual" }), ENTRIES).kind).toBe("bank");
    expect(txnRoute(txn({ plaidAccountId: "  ", source: "manual" }), ENTRIES).kind).toBe("bank");
  });

  it("a Plaid row whose account is no longer linked opens nowhere and says why", () => {
    const gone = txnRoute(txn({ plaidAccountId: "ext-gone", source: "plaid:chase" }), ENTRIES);
    expect(gone).toMatchObject({ kind: "none", href: null, note: "No ledger: Chase (no longer linked)" });
    // The institution's own name when a linked item shares the slug.
    expect(txnRoute(txn({ plaidAccountId: "ext-gone", source: "plaid:summit-cu" }), ENTRIES).note).toBe(
      "No ledger: Summit Credit Union (no longer linked)",
    );
    // No account id at all, but a bank's Plaid source: not the bank balance's row either.
    expect(txnRoute(txn({ plaidAccountId: null, source: "plaid:wells-fargo" }), ENTRIES).note).toBe(
      "No ledger: Wells Fargo (no longer linked)",
    );
  });

  it("a non-Plaid row that names an account H2 does not have opens nowhere", () => {
    const r = txnRoute(txn({ plaidAccountId: "ext-unknown", source: "manual" }), ENTRIES);
    expect(r).toMatchObject({ kind: "none", href: null, note: "No ledger: its account is not linked" });
  });

  it("with no accounts linked at all, only the rows a ledger lists without an account open", () => {
    expect(txnRoute(txn({ plaidAccountId: "ext-chk", source: "plaid:chase" }), []).kind).toBe("none");
    expect(txnRoute(txn({ source: "amex" }), []).kind).toBe("cards");
    expect(txnRoute(txn({ source: "manual" }), []).kind).toBe("bank");
  });

  it("the month comes from the row's own day, a timestamp read to its day; no day, no month", () => {
    expect(txnRoute(txn({ occurredOn: "2026-12-31T23:30:00.000Z" }), ENTRIES).href).toBe("/transactions?tx=t1&month=2026-12-01");
    expect(txnRoute(txn({ occurredOn: "2027-01-01" }), ENTRIES).href).toBe("/transactions?tx=t1&month=2027-01-01");
    expect(txnRoute(txn({ occurredOn: "garbage" }), ENTRIES).href).toBe("/transactions?tx=t1");
  });

  it("keeps a caller's extra params, encoded, after the row and its month; empty ones are left out", () => {
    const r = txnRoute(txn({ plaidAccountId: "ext-chk", source: "plaid:chase" }), ENTRIES, {
      extra: { category: "Dining & Coffee", empty: "", missing: null },
    });
    expect(r.href).toBe("/next/accounts/ext-chk?tx=t1&month=2026-09-01&category=Dining%20%26%20Coffee");
  });

  it("(review) while the linked accounts are unknown, a Plaid row opens nowhere, says nothing and never 'no longer linked'", () => {
    for (const t of [
      txn({ plaidAccountId: "ext-chk", source: "plaid:chase" }),
      txn({ plaidAccountId: "ext-gone", source: "plaid:chase" }),
      txn({ plaidAccountId: null, source: "plaid:chase" }),
      txn({ plaidAccountId: "ext-old-amex", source: "plaid:amex" }),
    ]) {
      const r = txnRoute(t, [], { entriesKnown: false });
      expect(r).toMatchObject({ kind: "unknown", href: null, note: null });
      expect(r.identity.label).not.toContain("no longer linked");
      expect(r.identity.shortLabel).not.toContain("no longer linked");
      expect(r.label).not.toContain("no longer linked");
    }
    expect(txnRoute(txn({ plaidAccountId: "ext-gone", source: "plaid:chase" }), [], { entriesKnown: false }).identity.label).toBe("Chase");
    // Rows that need no account still open where they always do.
    expect(txnRoute(txn({ source: "amex" }), [], { entriesKnown: false }).href).toBe("/amex?tx=t1&month=2026-09-01");
    expect(txnRoute(txn({ source: "manual" }), [], { entriesKnown: false }).href).toBe("/transactions?tx=t1&month=2026-09-01");
    // Known (the default), the same rows route as before.
    expect(txnRoute(txn({ plaidAccountId: "ext-chk", source: "plaid:chase" }), ENTRIES).kind).toBe("account");
  });

  it("the identity it returns is the row's chip: the same answer resolveTxnAccount gives", () => {
    expect(txnRoute(txn({ source: "amex" }), ENTRIES).identity.label).toBe("Amex (imported)");
    expect(txnRoute(txn({ source: "manual" }), ENTRIES).identity.label).toBe("Manual entry");
    expect(txnRoute(txn({ plaidAccountId: "ext-gone", source: "plaid:chase" }), ENTRIES).identity.label).toBe("Chase (no longer linked)");
  });
});

describe("accountPageHref — an account's own page", () => {
  it("is keyed by the external account id, encoded", () => {
    expect(accountPageHref({ plaidAccountId: "ext-chk", rowId: "r-chk" })).toBe("/next/accounts/ext-chk");
    expect(accountPageHref({ plaidAccountId: "ext/cu 1" })).toBe("/next/accounts/ext%2Fcu%201");
  });
  it("falls back to the row id when the external id is missing (the page accepts either)", () => {
    expect(accountPageHref({ plaidAccountId: "", rowId: "r-chk" })).toBe("/next/accounts/r-chk");
    expect(accountPageHref({ plaidAccountId: null, rowId: "r-chk" })).toBe("/next/accounts/r-chk");
  });
  it("an entry fits as it is, and the route module re-exports the one helper", () => {
    for (const e of ENTRIES) expect(accountPageHref(e)).toBe(`/next/accounts/${encodeURIComponent(e.plaidAccountId)}`);
    expect(accountPageHref).toBe(accountPageHrefDirect);
  });
});
