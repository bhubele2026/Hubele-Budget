import { test, expect, type Page, type Route } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for the Amex per-row running balance ("bal $X"),
 * rewritten for Q3 (2026-10-14) with PLAID card rows (`plaid:amex`).
 *
 * A card balance is what is OWED. Plaid stores a card row with the BANK sign:
 * a purchase is NEGATIVE, a payment POSITIVE. The page used to walk card rows
 * with the checking rule (`older = bal − amount`), so going back in time a
 * purchase made the balance RISE. It now walks what is owed
 * (`lib/cardBalanceWalk.ts`): `balanceBefore(row) = balanceAfter(row) −
 * owedDelta(row)`, owedDelta = +purchase, −payment/refund/credit. The old
 * spec seeded workbook rows (`source: "amex"`, purchases positive) on "All
 * cards", the one shape where the checking rule happened to be right, and
 * "All cards" no longer carries a combined running balance at all.
 *
 * Strategy (every read mocked at the network, synthetic values):
 *   1. One Amex item with two credit cards (`/api/plaid/items`).
 *   2. One card's rows today, with distinct `occurredAt` so the canonical
 *      newest-first comparator orders them: three purchases (−50, −30, −20)
 *      and an older payment (+100), plus a PENDING hold (−12) that must show
 *      no "bal" and move nothing. Another card's purchase rides along.
 *   3. `/api/amex/summary` answers the card's current balance ($1,000.00,
 *      read today) — the anchor — and, for "All cards", each card's balance.
 *   4. `/amex?card=<card>`: the newest posted row reads $1,000.00, each older
 *      row = previous − owedDelta(previous), in both layouts and in DOM order;
 *      the note names what the figures count back from.
 *   5. `/amex` ("All cards"): no row carries a "bal", and each card's balance
 *      is listed by card.
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

const PLAT = "e2e-q3-ext-plat";
const BLUE = "e2e-q3-ext-blue";

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

// "bal $1,234.56" → 1234.56.
function parseBalText(text: string): number {
  const m = text.match(/-?\$?[\d,]+(?:\.\d+)?/);
  if (!m) throw new Error(`could not parse running-balance text: "${text}"`);
  return Number(m[0].replace(/[$,]/g, ""));
}

type Seed = { id: string; description: string; amount: string; at: string; pending?: boolean; card?: string };

function txn(today: string, s: Seed) {
  return {
    id: s.id,
    occurredOn: today,
    occurredAt: s.at,
    postedOn: today,
    description: s.description,
    amount: s.amount,
    account: "Amex",
    categoryId: null,
    forecastFlag: false,
    weeklyAllowance: false,
    weeklyBucket: null,
    monthlyAllowance: false,
    unplannedAllowance: false,
    reimbursable: false,
    reimbursed: false,
    reviewed: false,
    isTransfer: false,
    isTransferUserOverridden: false,
    isExternalCardPayment: false,
    notes: null,
    source: "plaid:amex",
    member: null,
    owedBy: null,
    plaidTransactionId: `${s.id}-ext`,
    plaidAccountId: s.card ?? PLAT,
    pending: s.pending === true,
    debtId: null,
    matchedRuleId: null,
  };
}

function summaryBody(accountId: string, asOf: string) {
  const total = (amount = "0.00") => ({ amount, count: 0 });
  const card = (id: string, name: string, mask: string, owed: string | null) => ({
    accountId: id,
    name,
    mask,
    institution: "American Express",
    brand: "silver",
    cadence: "weekly",
    debtLinked: false,
    debtId: null,
    owed,
    purchases: total(),
  });
  const all = accountId === "all";
  return {
    scope: all
      ? { kind: "all", accountId: null, name: null, mask: null, institution: null, cards: [card(PLAT, "Platinum", "1002", "1000.00"), card(BLUE, "Blue Cash", "2003", "250.00")] }
      : { kind: "card", accountId, name: "Platinum", mask: "1002", institution: "American Express", cards: [card(PLAT, "Platinum", "1002", "1000.00")] },
    period: { from: todayIso(), to: todayIso(), timezone: "America/Chicago" },
    owed: { current: "1000.00", statement: null, asOf, source: "plaid" },
    purchases: { amount: "0.00", count: 0, reimbursable: total() },
    refunds: total(),
    payments: total(),
    otherCredits: total(),
    otherCharges: total(),
    notMine: total(),
    householdContribution: { amount: "0.00", count: 0, spent: "0.00", weekPlan: null, remaining: null, scope: "all" },
    planLink: { kind: "none" },
    needsAttention: {
      unplanned: { amount: "0.00", count: 0, truncated: false, rows: [] },
      unfiled: { amount: "0.00", count: 0, truncated: false, rows: [] },
      uncategorized: { amount: "0.00", count: 0, truncated: false, rows: [] },
      truncated: false,
    },
    limitations: [],
  };
}

async function mockCards(page: Page, today: string, seeds: Seed[]) {
  // The card's balance was read at midday today in Chicago: today's rows are inside it.
  const asOf = `${today}T12:00:00-05:00`;
  await page.route("**/api/plaid/items", async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "e2e-q3-item-row",
          itemId: "e2e-q3-item",
          institutionId: "ins_amex",
          institutionName: "American Express",
          institutionSlug: "amex",
          lastSyncedAt: new Date().toISOString(),
          lastSyncError: null,
          lastSyncErrorCode: null,
          stillPreparing: false,
          accounts: [
            { id: "e2e-q3-row-plat", accountId: PLAT, name: "Platinum Card", mask: "1002", type: "credit", subtype: "credit card" },
            { id: "e2e-q3-row-blue", accountId: BLUE, name: "Blue Cash", mask: "2003", type: "credit", subtype: "credit card" },
          ],
        },
      ]),
    });
  });
  await page.route("**/api/transactions**", async (route: Route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== "GET" || url.pathname !== "/api/transactions") return route.fallback();
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(seeds.map((s) => txn(today, s))) });
  });
  await page.route("**/api/amex/summary**", async (route: Route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const accountId = new URL(route.request().url()).searchParams.get("accountId") ?? "all";
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(summaryBody(accountId, asOf)) });
  });
}

test.describe("Amex page — per-row running balance on Plaid card rows (Q3)", () => {
  test("one card counts back from its current balance the owed way; All cards carries no combined bal", async ({ page }) => {
    const { email, password } = await createTestUser("amex-running-balance", provisionedUserIds);
    const today = todayIso();
    // Newest first. Owed change: purchase +, payment −.
    const posted: Seed[] = [
      { id: "e2e-q3-p1", description: "Q3 GROCER", amount: "-50.00", at: `${today}T18:00:00.000Z` }, //  +50
      { id: "e2e-q3-p2", description: "Q3 BOOKS", amount: "-30.00", at: `${today}T15:00:00.000Z` }, //   +30
      { id: "e2e-q3-p3", description: "Q3 TRANSIT", amount: "-20.00", at: `${today}T12:00:00.000Z` }, // +20
      { id: "e2e-q3-p4", description: "Q3 PAYMENT", amount: "100.00", at: `${today}T09:00:00.000Z` }, // −100
    ];
    const pending: Seed = { id: "e2e-q3-hold", description: "Q3 CAFE HOLD", amount: "-12.00", at: `${today}T19:00:00.000Z`, pending: true };
    const other: Seed = { id: "e2e-q3-b1", description: "Q3 OTHER CARD", amount: "-22.40", at: `${today}T17:00:00.000Z`, card: BLUE };
    await mockCards(page, today, [pending, ...posted, other]);

    await signInAndOpen(page, email, password, `/amex?card=${PLAT}`);
    await expect(page.getByRole("heading", { name: /american express/i })).toBeVisible({ timeout: 15_000 });

    // Worked by hand: after p1 1,000.00 · after p2 950.00 · after p3 920.00 ·
    // after p4 900.00 · before p4 (opening) 1,000.00. The old checking walk
    // read 1,000.00 / 1,050.00 / 1,080.00 / 1,100.00.
    const owed = (s: Seed) => -Number(s.amount);
    const expected: Array<{ id: string; bal: number }> = [];
    let bal = 1000;
    for (const s of posted) {
      expected.push({ id: s.id, bal });
      bal = Math.round((bal - owed(s)) * 100) / 100;
    }
    expect(expected.map((e) => e.bal)).toEqual([1000, 950, 920, 900]);
    expect(bal).toBe(1000);

    await expect(page.getByTestId(`text-running-balance-${posted[0]!.id}`)).toContainText(fmtCurrency(1000), {
      timeout: 15_000,
    });
    // (P1) One row per transaction, phone and desktop alike: one "bal" each.
    for (const e of expected) {
      const bal = page.getByTestId(`text-running-balance-${e.id}`);
      await expect(bal).toBeVisible({ timeout: 15_000 });
      expect(parseBalText((await bal.textContent()) ?? "")).toBeCloseTo(e.bal, 2);
    }

    // The pending hold is listed, with no "bal"; the other card's row is not on this card's page.
    await expect(page.getByText("Q3 CAFE HOLD").first()).toBeAttached();
    await expect(page.getByTestId(`text-running-balance-${pending.id}`)).toHaveCount(0);
    await expect(page.getByText("Q3 OTHER CARD")).toHaveCount(0);

    // DOM order obeys the owed recurrence: next = prev − owedDelta(prev row).
    const rendered = page.locator('[data-testid^="text-running-balance-"]');
    await expect(rendered).toHaveCount(posted.length, { timeout: 15_000 });
    const owedById = new Map(posted.map((s) => [s.id, owed(s)]));
    let prev: { bal: number; owed: number } | null = null;
    for (const handle of await rendered.elementHandles()) {
      const id = ((await handle.getAttribute("data-testid")) ?? "").replace(/^text-running-balance-/, "");
      const v = parseBalText((await handle.textContent()) ?? "");
      if (prev) expect(v).toBeCloseTo(Math.round((prev.bal - prev.owed) * 100) / 100, 2);
      else expect(v).toBeCloseTo(1000, 2);
      const o = owedById.get(id);
      expect(o, `unexpected row id rendered: ${id}`).not.toBeUndefined();
      prev = { bal: v, owed: o! };
    }

    await expect(page.getByTestId("amex-anchor-note")).toHaveText(
      /^Balance after each row, counting back from \$1,000\.00 \(as of [A-Z][a-z]{2} \d{1,2}\)\.$/,
    );

    // "All cards": no combined running balance; each card's own balance, by card.
    await page.goto("/amex");
    await expect(page.getByRole("heading", { name: /american express/i })).toBeVisible({ timeout: 15_000 });
    const balances = page.getByTestId("amex-card-balances");
    await expect(balances).toBeVisible({ timeout: 15_000 });
    await expect(balances.getByTestId(`amex-card-balance-${PLAT}`)).toContainText("Platinum ••1002");
    await expect(balances.getByTestId(`amex-card-balance-${PLAT}`)).toContainText(fmtCurrency(1000));
    await expect(balances.getByTestId(`amex-card-balance-${BLUE}`)).toContainText(fmtCurrency(250));
    await expect(page.getByText("Q3 OTHER CARD").first()).toBeAttached({ timeout: 15_000 });
    await expect(page.locator('[data-testid^="text-running-balance-"]')).toHaveCount(0);
  });
});
