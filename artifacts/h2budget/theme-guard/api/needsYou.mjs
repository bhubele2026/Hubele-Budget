// GET /api/banking/needs-you — Banking's "Needs you" list for the invented household: four rows the
// ledger really holds (two on Everyday Checking at Cedar Hollow Bank, two on Card A), two to match and
// two to file, one with no suggestion and one still pending. Nothing here is real.
import * as fx from "./fixture.mjs";
import * as L from "./ledger.mjs";

const newestOut = (acct) =>
  L.ALL.filter((t) => t.plaidAccountId === acct.externalId && Number(t.amount) < 0 && t.occurredOn <= fx.TODAY)
    .sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : a.occurredOn > b.occurredOn ? -1 : a.id < b.id ? 1 : -1));

function build() {
  const chk = newestOut(fx.CHECKING);
  const card = newestOut(L.CARD_A);
  const like = (rows, re) => rows.find((t) => re.test(`${t.description} ${t.displayName ?? ""}`));
  const used = new Set();
  const take = (t) => (t && !used.has(t.id) ? (used.add(t.id), t) : undefined);
  const carIns = take(like(chk, /OAKMONT MUTUAL AUTO/i) ?? chk[0]);
  const market = take(like(card, /FRESHFIELD|MARKET|GROCER/i) ?? card[0]);
  const unclear = take(like(chk, /PAWS AND CO/i) ?? chk[1]);
  const pendingFun = take(card.find((t) => t.pending && !used.has(t.id)) ?? like(card, /CINEMA|BISTRO|COFFEE/i) ?? card[1]);
  const picks = [
    { t: carIns, acct: fx.CHECKING, kind: "match", suggestion: { label: "the Car insurance · Oakmont Mutual payment, planned $186.00 on Nov 5", planOccurrenceId: "ri-car-ins|2026-11-05", confidence: "medium" }, reason: "The amount fits; the day is a few days off." },
    { t: market, acct: L.CARD_A, kind: "category", suggestion: { label: "Groceries", categoryId: "cat-groceries", reviewItemId: "rv-fixture-1", confidence: "medium" }, reason: "A merchant H2 has not seen before." },
    { t: unclear, acct: fx.CHECKING, kind: "match", suggestion: null, reason: "Two planned bills could fit this one." },
    { t: pendingFun, acct: L.CARD_A, kind: "category", suggestion: { label: "Dining & fun", categoryId: "cat-dining", confidence: "low" }, reason: "Seen once before, filed differently." },
  ].filter((p) => p.t);
  const items = picks.map((p, i) => ({
    id: `ny-${i + 1}`,
    txId: p.t.id,
    accountName: `${p.acct.institution} ${p.acct.name}`.trim(),
    mask: p.acct.mask,
    date: p.t.occurredOn,
    name: p.t.displayName || p.t.description,
    amount: p.t.amount,
    pending: !!p.t.pending,
    categoryName: p.t.categoryId ? (fx.categories.find((c) => c.id === p.t.categoryId)?.name ?? null) : null,
    kind: p.kind,
    suggestion: p.suggestion,
    reason: p.reason,
  }));
  return { throughDate: fx.TODAY, count: items.length, truncated: false, items, autoDone: { matched: 9, categorized: 14, since: "2026-11-03" } };
}

export const needsYou = () => build();
