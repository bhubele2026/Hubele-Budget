import { describe, expect, it } from "vitest";
import {
  canSupersede,
  descriptionsFuzzyEqual,
  expiredHolds,
  isExpiredByAge,
  pairPendingWithPosted,
  pairPendingWithPostedAmong,
  REVERSAL_MAX_DAYS,
  SUPERSEDE_MAX_DAYS,
  type SupersedeRow,
} from "@workspace/avalanche-core";

const at = (iso: string) => new Date(`${iso}T12:00:00Z`);
const pending = (id: string, occurredOn: string, amount: number, extra: Partial<SupersedeRow> = {}): SupersedeRow => ({
  id,
  plaidAccountId: "chase",
  pending: true,
  occurredOn,
  amount,
  description: "RESTAURANT 123",
  createdAt: at(occurredOn),
  ...extra,
});
const posted = (id: string, occurredOn: string, amount: number, extra: Partial<SupersedeRow> = {}): SupersedeRow => ({
  ...pending(id, occurredOn, amount, extra),
  pending: false,
  createdAt: extra.createdAt ?? at(occurredOn),
});

describe("canSupersede", () => {
  it("pairs a tip: pending −48.20 posting as −55.00 the next day", () => {
    expect(canSupersede(pending("p", "2026-05-01", -48.2), posted("q", "2026-05-02", -55))).toBe(true);
  });

  it("allows the same day (posted later) and up to seven days after", () => {
    expect(SUPERSEDE_MAX_DAYS).toBe(7);
    expect(
      canSupersede(pending("p", "2026-05-01", -20), posted("q", "2026-05-01", -20, { createdAt: new Date("2026-05-01T13:00:00Z") })),
    ).toBe(true);
    expect(canSupersede(pending("p", "2026-05-01", -20), posted("q", "2026-05-08", -20))).toBe(true);
    expect(canSupersede(pending("p", "2026-05-01", -20), posted("q", "2026-05-09", -20))).toBe(false);
  });

  it("never pairs a posted row dated before the pending row, or one that reached the ledger first", () => {
    expect(canSupersede(pending("p", "2026-05-03", -20), posted("q", "2026-05-02", -20))).toBe(false);
    expect(
      canSupersede(
        pending("p", "2026-05-01", -20, { createdAt: new Date("2026-05-02T12:00:00Z") }),
        posted("q", "2026-05-02", -20, { createdAt: new Date("2026-05-02T12:00:00Z") }),
      ),
    ).toBe(false);
  });

  it("holds the amount to |pending| ≤ |posted| ≤ 1.30 × |pending| + $1.00, same sign", () => {
    const p = pending("p", "2026-05-01", -40);
    expect(canSupersede(p, posted("q", "2026-05-02", -53))).toBe(true); // 40 × 1.30 + 1
    expect(canSupersede(p, posted("q", "2026-05-02", -53.01))).toBe(false);
    expect(canSupersede(p, posted("q", "2026-05-02", -39.99))).toBe(false);
    expect(canSupersede(p, posted("q", "2026-05-02", 40))).toBe(false);
    expect(canSupersede(pending("p", "2026-05-01", 500), posted("q", "2026-05-02", 500))).toBe(true);
  });

  it("needs the same account, a pending and a posted row, and fuzzy-equal descriptions", () => {
    const p = pending("p", "2026-05-01", -20);
    expect(canSupersede(p, posted("q", "2026-05-02", -20, { plaidAccountId: "savings" }))).toBe(false);
    expect(canSupersede({ ...p, plaidAccountId: null }, posted("q", "2026-05-02", -20, { plaidAccountId: null }))).toBe(false);
    expect(canSupersede(p, { ...posted("q", "2026-05-02", -20), pending: true })).toBe(false);
    expect(canSupersede(p, posted("q", "2026-05-02", -20, { description: "RESTAURANT" }))).toBe(true);
    expect(canSupersede(p, posted("q", "2026-05-02", -20, { description: "COFFEE SHOP" }))).toBe(false);
    expect(descriptionsFuzzyEqual("AFFIRM.COM PAYME Merchant: Affirm", "Affirm")).toBe(true);
  });

  it("(PR4c review) never pairs rows with no real description", () => {
    const p = pending("p", "2026-05-01", -20, { description: "(no description)" });
    expect(canSupersede(p, posted("q", "2026-05-02", -20, { description: "(no description)" }))).toBe(false);
    expect(canSupersede(pending("p", "2026-05-01", -20, { description: "" }), posted("q", "2026-05-02", -20, { description: "" }))).toBe(false);
  });
});

describe("pairPendingWithPosted", () => {
  it("pairs one to one: two equal pendings and one posted row pair once, with the OLDEST pending row (holds post oldest first)", () => {
    const pairs = pairPendingWithPosted([
      pending("p-old", "2026-05-01", -20),
      pending("p-new", "2026-05-03", -20),
      posted("q", "2026-05-04", -20),
    ]);
    expect([...pairs.entries()].map(([q, p]) => [q, p.id])).toEqual([["q", "p-old"]]);
  });

  it("(PR4c review) the closest amount beats the nearest date: an older −40 hold posting as −40 is not taken by a newer −30", () => {
    const pairs = pairPendingWithPosted([
      pending("p-40", "2026-05-01", -40),
      pending("p-30", "2026-05-02", -30),
      posted("q", "2026-05-03", -40),
    ]);
    expect(pairs.get("q")?.id).toBe("p-40");
  });

  it("one pending and two posted rows: the earlier posted row takes it", () => {
    const pairs = pairPendingWithPosted([
      pending("p", "2026-05-01", -20),
      posted("q2", "2026-05-03", -20),
      posted("q1", "2026-05-02", -20),
    ]);
    expect([...pairs.entries()].map(([q, p]) => [q, p.id])).toEqual([["q1", "p"]]);
  });

  it("on the same date, the closer amount wins", () => {
    const pairs = pairPendingWithPosted([
      pending("p-40", "2026-05-01", -40),
      pending("p-50", "2026-05-01", -50),
      posted("q", "2026-05-02", -52),
    ]);
    expect(pairs.get("q")?.id).toBe("p-50");
  });

  it("returns nothing when no posted row qualifies", () => {
    expect(pairPendingWithPosted([pending("p", "2026-05-01", -20), posted("q", "2026-05-02", -90)]).size).toBe(0);
  });
});

describe("pairPendingWithPostedAmong (PR7b review M1)", () => {
  // A dense in-memory ledger: look-alike merchants, repeated amounts, rows
  // that arrive out of order. Fixed seed.
  function ledger(): SupersedeRow[] {
    let seed = 4242;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const rows: SupersedeRow[] = [];
    for (let i = 0; i < 300; i += 1) {
      const d = new Date(Date.UTC(2026, 4, 1 + Math.floor(rand() * 30), 12, Math.floor(rand() * 2880)));
      const occurredOn = new Date(Date.UTC(2026, 4, 1 + Math.floor((d.getTime() - Date.UTC(2026, 4, 1)) / 86_400_000))).toISOString().slice(0, 10);
      rows.push({
        id: `r${i}`,
        plaidAccountId: pick(["chase", "amex"]),
        pending: rand() < 0.4,
        occurredOn,
        amount: -pick([5, 5.5, 6, 20, 22, 45, 47.4]),
        description: pick(["STARBUCKS", "STARBUCKS STORE 1234", "PANERA BREAD 601"]),
        createdAt: d,
      });
    }
    return rows;
  }

  it("with complete candidates (plus harmless extras, in any order) it returns exactly what pairPendingWithPosted returns", () => {
    const rows = ledger();
    const reference = pairPendingWithPosted(rows);
    expect(reference.size).toBeGreaterThan(10);
    const pendings = rows.filter((r) => r.pending);
    // Same-account pending rows, reversed: every qualifying one is present, most are extras.
    const got = pairPendingWithPostedAmong(rows, (q) =>
      pendings.filter((p) => p.plaidAccountId === q.plaidAccountId).reverse(),
    );
    expect([...got.entries()].map(([q, p]) => [q, p.id]).sort()).toEqual(
      [...reference.entries()].map(([q, p]) => [q, p.id]).sort(),
    );
  });

  it("only qualifying candidates also suffice; a missing one can change the answer (the precondition is real)", () => {
    const rows = ledger();
    const reference = pairPendingWithPosted(rows);
    const pendings = rows.filter((r) => r.pending);
    const exact = pairPendingWithPostedAmong(rows, (q) => pendings.filter((p) => canSupersede(p, q)));
    expect([...exact.values()].map((p) => p.id).sort()).toEqual([...reference.values()].map((p) => p.id).sort());

    const p0905 = pending("p0905", "2026-09-05", -45);
    const p0906 = pending("p0906", "2026-09-06", -45);
    const q0907 = posted("q0907", "2026-09-07", -47.4);
    const incomplete = pairPendingWithPostedAmong([p0905, p0906, q0907], () => [p0906]);
    expect(pairPendingWithPosted([p0905, p0906, q0907]).get("q0907")?.id).toBe("p0905");
    expect(incomplete.get("q0907")?.id).toBe("p0906");
  });
});

// ⭐ (F6 round 3, owner's decision 2026-10-15) "A charge that is still pending more
// than 7 days after its date: stop counting it everywhere." Synthetic rows only.
describe("expiredHolds — an expired hold and its reversal count nowhere", () => {
  const TODAY = "2026-10-15";
  const hold = (id: string, occurredOn: string, amount: number, extra: Partial<SupersedeRow> = {}) =>
    pending(id, occurredOn, amount, { description: "SOME TAVERN 0042", ...extra });
  const ids = (r: ReturnType<typeof expiredHolds>) => [...r.expiredIds].sort();
  const none = new Set<string>();

  it("the edge: exactly 7 days old is still counted; 8 days old is expired (today injected)", () => {
    expect(isExpiredByAge(hold("h", "2026-10-08", -20), TODAY)).toBe(false);
    expect(isExpiredByAge(hold("h", "2026-10-07", -20), TODAY)).toBe(true);
    expect(ids(expiredHolds([hold("a", "2026-10-08", -20), hold("b", "2026-10-07", -20)], TODAY, none))).toEqual(["b"]);
  });

  it("today rolls over: the same row is counted on 10/15 and expired on 10/16", () => {
    const r = [hold("h", "2026-10-08", -20)];
    expect(ids(expiredHolds(r, "2026-10-15", none))).toEqual([]);
    expect(ids(expiredHolds(r, "2026-10-16", none))).toEqual(["h"]);
  });

  it("any sign: an old pending credit is expired too; a posted row and a manual row never", () => {
    expect(ids(expiredHolds([hold("credit", "2026-10-01", 30)], TODAY, none))).toEqual(["credit"]);
    expect(ids(expiredHolds([{ ...hold("posted", "2026-10-01", -30), pending: false }], TODAY, none))).toEqual([]);
    expect(ids(expiredHolds([hold("manual", "2026-10-01", -30, { plaidAccountId: null })], TODAY, none))).toEqual([]);
  });

  it("a row a posted row replaced is never also expired, and never pairs as a hold or a reversal", () => {
    const r = expiredHolds([hold("h", "2026-10-01", -50), hold("v", "2026-10-10", 50)], TODAY, new Set(["h"]));
    expect(ids(r)).toEqual([]);
    const r2 = expiredHolds([hold("h", "2026-10-01", -50), hold("v", "2026-10-03", 50)], TODAY, new Set(["v"]));
    expect(ids(r2)).toEqual(["h"]);
    expect(r2.holdOf.size).toBe(0);
  });

  it("⭐ the reversal is expired WITH its hold even when it is younger than 7 days", () => {
    const r = expiredHolds([hold("h", "2026-10-05", -50), hold("v", "2026-10-11", 50)], TODAY, none);
    expect(ids(r)).toEqual(["h", "v"]);
    expect(r.holdOf.get("v")).toBe("h");
  });

  it("one to one: two holds and one reversal — the OLDEST hold takes it; the other hold is still expired on its own", () => {
    const r = expiredHolds([hold("h2", "2026-10-06", -50), hold("h1", "2026-10-04", -50), hold("v", "2026-10-09", 50)], TODAY, none);
    expect(r.holdOf.get("v")).toBe("h1");
    expect(ids(r)).toEqual(["h1", "h2", "v"]);
    // Two young reversals and one hold: one reversal only; the other still counts.
    const r2 = expiredHolds([hold("h", "2026-10-05", -50), hold("v1", "2026-10-09", 50), hold("v2", "2026-10-10", 50)], TODAY, none);
    expect(ids(r2)).toEqual(["h", "v1"]);
  });

  it("not a reversal: 1¢ off; another account; the same sign; dated before the hold", () => {
    const h = hold("h", "2026-10-05", -50);
    const cases: SupersedeRow[] = [
      hold("cent", "2026-10-09", 50.01),
      hold("acct", "2026-10-09", 50, { plaidAccountId: "savings" }),
      hold("same", "2026-10-09", -50),
    ];
    for (const c of cases) {
      const r = expiredHolds([h, c], TODAY, none);
      expect(r.holdOf.size, c.id).toBe(0);
      // Each is 6 days old: it still counts.
      expect(r.expiredIds.has(c.id), c.id).toBe(false);
    }
    // A credit dated BEFORE the hold is never its reversal. (F6 round 4) And an
    // older credit never takes the charge either: only a charge takes a
    // reversal. Both are 10–11 days old, so each is expired on its own.
    const r = expiredHolds([h, hold("before", "2026-10-04", 50)], TODAY, none);
    expect(r.holdOf.size).toBe(0);
    expect(ids(r)).toEqual(["before", "h"]);
    // Dated on the hold's day, or 7 days after it: a reversal.
    expect(expiredHolds([h, hold("same-day", "2026-10-05", 50)], TODAY, none).holdOf.get("same-day")).toBe("h");
    expect(expiredHolds([h, hold("day7", "2026-10-12", 50)], TODAY, none).holdOf.get("day7")).toBe("h");
  });

  it("⭐ (F6 round 4, finding 8) a reversal comes up to 31 days after its hold: 8 and 30 days pair, 32 days does not", () => {
    expect(REVERSAL_MAX_DAYS).toBe(31);
    // A hotel hold 10/01 −150, still pending on 10/15; its reversal 8 days later (10/09, 6 days old).
    const hotel = hold("hotel", "2026-10-01", -150, { description: "HARBOR HOTEL HOLD" });
    const r8 = expiredHolds([hotel, hold("rev8", "2026-10-09", 150, { description: "Hotel Transaction" })], TODAY, none);
    expect(r8.holdOf.get("rev8")).toBe("hotel");
    expect(ids(r8)).toEqual(["hotel", "rev8"]);
    // Read on 11/03: a hold 9/20 and its reversal 30 days later (10/20, 14 days old) pair; 31 days too.
    const sep = hold("sep", "2026-09-20", -150, { description: "HARBOR HOTEL HOLD" });
    expect(expiredHolds([sep, hold("rev30", "2026-10-20", 150)], "2026-11-03", none).holdOf.get("rev30")).toBe("sep");
    expect(expiredHolds([sep, hold("rev31", "2026-10-21", 150)], "2026-11-03", none).holdOf.get("rev31")).toBe("sep");
    // 32 days after: not a reversal. On 10/25 the credit (10/22, 3 days old) still counts.
    const r32 = expiredHolds([sep, hold("rev32", "2026-10-22", 150)], "2026-10-25", none);
    expect(r32.holdOf.size).toBe(0);
    expect(ids(r32)).toEqual(["sep"]);
  });

  it("⭐ (F6 round 4, finding 10) an orphan expired CREDIT never takes a young real purchase with it", () => {
    // A coffee hold −40 (10/06) was replaced by its tipped final; its reversal
    // credit +40 (10/07) stayed pending — an orphan, 8 days old: expired alone.
    // A real purchase −40.00 on 10/12 (3 days old) still counts.
    const orphan = hold("orphan", "2026-10-07", 40, { description: "Restaurant Transaction" });
    const purchase = hold("book", "2026-10-12", -40, { description: "BOOK NOOK" });
    const r = expiredHolds([orphan, purchase], TODAY, none);
    expect(ids(r)).toEqual(["orphan"]);
    expect(r.holdOf.size).toBe(0);
    // An expired credit with an older expired charge of the same amount: the
    // charge takes the credit (the charge is the hold), never the other way.
    const r2 = expiredHolds([hold("c", "2026-10-02", -40), orphan], TODAY, none);
    expect(r2.holdOf.get("orphan")).toBe("c");
  });

  it("⭐ (lead's amendment) no description test: a tavern hold and a generic \"Restaurant Transaction\" reversal pair", () => {
    const r = expiredHolds(
      [hold("h", "2026-10-03", -64.18, { description: "SOME TAVERN 0042" }), hold("v", "2026-10-09", 64.18, { description: "Restaurant Transaction" })],
      TODAY,
      none,
    );
    expect(r.holdOf.get("v")).toBe("h");
    expect(ids(r)).toEqual(["h", "v"]);
  });

  it("⭐ (lead's amendment) two equal-amount credits compete: a fuzzy-equal description first, then the closest date, then id", () => {
    const h = hold("h", "2026-10-03", -40, { description: "SOME TAVERN 0042" });
    const generic = hold("generic", "2026-10-04", 40, { description: "Restaurant Transaction" });
    const named = hold("named", "2026-10-09", 40, { description: "SOME TAVERN" });
    const r = expiredHolds([h, generic, named], TODAY, none);
    expect(r.holdOf.get("named")).toBe("h");
    // The generic credit is not a reversal: 11 days old, it is an expired pending credit on its own.
    expect(ids(r)).toEqual(["generic", "h", "named"]);
    // Neither named: the closest date wins.
    const near = hold("near", "2026-10-09", 40, { description: "Restaurant Transaction" });
    const far = hold("far", "2026-10-10", 40, { description: "Credit Adjustment" });
    expect(expiredHolds([hold("h2", "2026-10-06", -40), far, near], TODAY, none).holdOf.get("near")).toBe("h2");
    // Same day, neither named: the lower id.
    const b = hold("b", "2026-10-09", 40, { description: "Restaurant Transaction" });
    const a = hold("a", "2026-10-09", 40, { description: "Restaurant Transaction" });
    expect(expiredHolds([hold("h3", "2026-10-06", -40, { description: "PLACE" }), b, a], TODAY, none).holdOf.get("a")).toBe("h3");
  });

  it("one pair per row; a credit takes nothing; a young charge is never anyone's reversal", () => {
    // 10/01 −50 takes 10/04 +50; the young charge 10/09 −50 is a charge: no credit
    // takes it, and it still counts (6 days old).
    const r = expiredHolds([hold("a", "2026-10-01", -50), hold("b", "2026-10-04", 50), hold("c", "2026-10-09", -50)], TODAY, none);
    expect([...r.holdOf.entries()]).toEqual([["b", "a"]]);
    expect(ids(r)).toEqual(["a", "b"]);
  });

  it("a $0 pending row that old is expired (it adds nothing either way) and never pairs", () => {
    const r = expiredHolds([hold("zero", "2026-10-01", 0), hold("v", "2026-10-03", 0)], TODAY, none);
    expect(ids(r)).toEqual(["v", "zero"]);
    expect(r.holdOf.size).toBe(0);
  });
});
