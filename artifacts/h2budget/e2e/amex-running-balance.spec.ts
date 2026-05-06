import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * End-to-end coverage for the Amex per-row running statement balance
 * (task #299, follow-up #341). Pins the register-style "bal $X" math
 * shown beside each row on /amex so a future refactor of:
 *   - `computeRunningBalances` (lib/runningBalance.ts),
 *   - the canonical `compareNewestFirst` comparator,
 *   - the day-group sort in amex.tsx, or
 *   - the anchor resolution in `endingBalance` / `computeBalanceAtEndOf`
 * cannot silently break monotonicity or reconciliation again without
 * being caught here.
 *
 * Strategy:
 *   1. Provision a fresh user; seed a saved Amex anchor at a known value
 *      via POST /api/amex/anchor with asOf=now (so anchor month == current
 *      month → ending balance == anchor value with no further roll).
 *   2. Seed four same-day amex-source transactions on today's date with
 *      distinct `occurredAt` timestamps so the canonical newest-first
 *      comparator orders them deterministically (no id-tiebreaker
 *      reliance). Mix charges (positive amounts) and a payment
 *      (negative amount) to exercise both walk directions.
 *   3. Open /amex, wait for the ending balance chip to populate to the
 *      anchor value, then read the running-balance text from each row in
 *      both the desktop (`text-running-balance-${id}`) and mobile
 *      (`text-running-balance-mobile-${id}`) layouts. Both render
 *      simultaneously in the DOM (Tailwind `md:hidden` / `hidden md:block`),
 *      so the same data flows through both code paths.
 *   4. Assert per layout:
 *        - Newest row's "bal" exactly equals the ending balance chip.
 *        - Walking newest → oldest, each next row's balance equals
 *          `prev_bal − prev_row_amount` (the canonical recurrence used
 *          by `computeRunningBalances`).
 *      That single recurrence covers both monotonicity for charges
 *      (balance walks down by the charge amount as we look further back)
 *      and the reverse for payments (balance walks back up).
 */

const provisionedUserIds: string[] = [];

test.afterAll(async () => {
  await cleanupTestUsers(provisionedUserIds);
});

type ApiResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; body: unknown };

async function apiCall<T>(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const result = await page.evaluate(
    async (args): Promise<ApiResult<T>> => {
      const res = await fetch(args.path, {
        method: args.method,
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: args.body == null ? undefined : JSON.stringify(args.body),
      });
      let parsed: unknown = null;
      const text = await res.text();
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      if (!res.ok) {
        return { ok: false, status: res.status, body: parsed };
      }
      return { ok: true, status: res.status, body: parsed as T };
    },
    { method, path, body },
  );
  if (!result.ok) {
    throw new Error(
      `API ${method} ${path} failed (${result.status}): ${JSON.stringify(result.body)}`,
    );
  }
  return result.body;
}

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(n);
}

// Parses "bal $1,234.56" → 1234.56. Strips the leading "bal " prefix the
// chip wraps each value in, then strips currency formatting.
function parseBalText(text: string): number {
  const m = text.match(/-?\$?[\d,]+(?:\.\d+)?/);
  if (!m) throw new Error(`could not parse running-balance text: "${text}"`);
  return Number(m[0].replace(/[$,]/g, ""));
}

type Seeded = {
  id: string;
  description: string;
  // Signed amount as the running-balance recurrence sees it (matches
  // what the page stores in `t.amount` and feeds to
  // `computeRunningBalances`).
  amount: number;
};

test.describe("Amex page — per-row running balance (#341)", () => {
  test("running balances are monotonic newest→oldest and reconcile to the ending balance chip in both layouts", async ({
    page,
  }) => {
    const { email, password } = await createTestUser(
      "amex-running-balance",
      provisionedUserIds,
    );

    // Sign in first so the page has a Clerk session cookie before any
    // /api/* seeding calls. We land on /amex but only to mount an
    // authenticated origin — we'll reload after seeding.
    await signInAndOpen(page, email, password, "/amex");
    await expect(
      page.getByRole("heading", { name: /american express/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Anchor balance: pick a round value so manual cross-check is easy.
    const anchorBalance = 1000;

    // Seed four same-day amex transactions with explicit occurredAt
    // timestamps so the canonical comparator orders them deterministically
    // (newest occurredAt first, with payment as the oldest of the day).
    const today = todayIso();
    const seedSpecs: Array<{ description: string; amount: string; at: string }> = [
      {
        description: "AMEX BAL TEST — STARBUCKS NEWEST",
        amount: "50.00",
        at: `${today}T18:00:00.000Z`,
      },
      {
        description: "AMEX BAL TEST — TRADER JOES",
        amount: "30.00",
        at: `${today}T15:00:00.000Z`,
      },
      {
        description: "AMEX BAL TEST — UBER",
        amount: "20.00",
        at: `${today}T12:00:00.000Z`,
      },
      {
        description: "AMEX BAL TEST — PAYMENT THANK YOU",
        amount: "-100.00",
        at: `${today}T09:00:00.000Z`,
      },
    ];

    const seeded: Seeded[] = [];
    for (const s of seedSpecs) {
      const row = await apiCall<{ id: string }>(
        page,
        "POST",
        "/api/transactions",
        {
          occurredOn: today,
          occurredAt: s.at,
          description: s.description,
          amount: s.amount,
          account: "Amex",
          source: "amex",
          // Don't auto-categorize off a fresh user's empty rule set.
          categoryId: null,
        },
      );
      seeded.push({
        id: row.id,
        description: s.description,
        amount: Number(s.amount),
      });
    }

    // Save the Amex anchor AFTER seeding so the GET /amex/anchor query the
    // page makes on reload returns our value. asOf=today keeps the anchor
    // month aligned with the selected month, so endingBalance == anchor
    // (no roll-forward / roll-backward via netChangeByMonth).
    await apiCall(page, "POST", "/api/amex/anchor", {
      balance: anchorBalance,
      asOf: new Date().toISOString(),
    });

    // Reload so the Amex page picks up both the seeded txns and the anchor.
    await page.goto("/amex");
    await expect(
      page.getByRole("heading", { name: /american express/i }),
    ).toBeVisible({ timeout: 15_000 });

    // Ending balance chip populates to the anchor value.
    const tile = page.getByTestId("stat-ending-balance");
    const expectedAnchorText = fmtCurrency(anchorBalance);
    await expect(tile).toContainText(expectedAnchorText, { timeout: 15_000 });
    await expect(tile).toContainText("From saved anchor");

    // Determine newest→oldest order via the seeds' occurredAt: spec is
    // already in descending-time order, so seeded[] is exactly the order
    // the comparator should produce. Compute the expected running balance
    // for each row using the canonical recurrence:
    //   bal[0] = anchor, bal[i] = bal[i-1] - amount[i-1].
    const expected: Array<{ id: string; bal: number }> = [];
    let bal = Math.round(anchorBalance * 100) / 100;
    for (let i = 0; i < seeded.length; i += 1) {
      expected.push({ id: seeded[i].id, bal });
      bal = Math.round((bal - seeded[i].amount) * 100) / 100;
    }

    // First row's balance must reconcile to the chip.
    expect(fmtCurrency(expected[0].bal)).toBe(expectedAnchorText);

    // Sanity: monotonic-down across the three charges, then back up after
    // the payment. Locks the per-row recurrence's directionality.
    expect(expected[0].bal).toBeGreaterThan(expected[1].bal);
    expect(expected[1].bal).toBeGreaterThan(expected[2].bal);
    expect(expected[2].bal).toBeGreaterThan(expected[3].bal);
    expect(expected[3].bal).toBeLessThan(expected[0].bal);
    // After applying the -$100 payment to the oldest row's incoming
    // balance, we land back at the anchor (charges 50+30+20 = 100).
    const finalBal = Math.round((expected[3].bal - seeded[3].amount) * 100) / 100;
    expect(finalBal).toBe(anchorBalance);

    // Both layouts render simultaneously (Tailwind `md:hidden` /
    // `hidden md:block`), so we read each row's running-balance text
    // from both code paths. Each row's chip is "bal $X" — `parseBalText`
    // strips formatting so we can compare numerically (avoids fragile
    // exact-text matches that would break on locale or whitespace
    // tweaks).
    for (const e of expected) {
      const desktop = page.getByTestId(`text-running-balance-${e.id}`);
      const mobile = page.getByTestId(`text-running-balance-mobile-${e.id}`);
      await expect(desktop).toBeVisible({ timeout: 15_000 });
      await expect(mobile).toBeAttached({ timeout: 15_000 });

      const desktopText = (await desktop.textContent()) ?? "";
      const mobileText = (await mobile.textContent()) ?? "";
      expect(parseBalText(desktopText)).toBeCloseTo(e.bal, 2);
      expect(parseBalText(mobileText)).toBeCloseTo(e.bal, 2);

      // Both layouts must agree on every row — a divergence would mean
      // one of the two render paths skipped or re-sorted the map.
      expect(parseBalText(desktopText)).toBeCloseTo(
        parseBalText(mobileText),
        2,
      );
    }

    // Final reconciliation assertion: the newest row's displayed
    // running balance equals the chip's displayed value, char for char.
    const newestDesktopText =
      (await page
        .getByTestId(`text-running-balance-${expected[0].id}`)
        .textContent()) ?? "";
    expect(newestDesktopText).toContain(expectedAnchorText);

    // DOM-order monotonicity check. The per-id assertions above pin the
    // computed values, but a regression in the day-group sort
    // (`groups.map`) or the per-day `sort(compareNewestFirst)` could
    // leave the values correct in the map yet render them out of order
    // on screen. Walk the desktop running-balance chips in their
    // actual DOM order and assert that consecutive rows obey the
    // canonical recurrence
    //   nextBal === prevBal − prevRowAmount.
    // A single failure here means the rendered list is not in
    // newest-first order even if `computeRunningBalances` is.
    const renderedBalLocators = page.locator(
      '[data-testid^="text-running-balance-"]:not([data-testid^="text-running-balance-mobile-"])',
    );
    await expect(renderedBalLocators).toHaveCount(seeded.length, {
      timeout: 15_000,
    });
    const renderedHandles = await renderedBalLocators.elementHandles();
    const amountById = new Map(seeded.map((s) => [s.id, s.amount]));
    let prevBal: number | null = null;
    let prevRowAmount: number | null = null;
    for (const handle of renderedHandles) {
      const testId = (await handle.getAttribute("data-testid")) ?? "";
      const id = testId.replace(/^text-running-balance-/, "");
      const text = (await handle.textContent()) ?? "";
      const bal = parseBalText(text);
      if (prevBal !== null && prevRowAmount !== null) {
        const expectedNext = Math.round((prevBal - prevRowAmount) * 100) / 100;
        expect(bal).toBeCloseTo(expectedNext, 2);
      } else {
        // First rendered row must reconcile to the chip — pins
        // newest-first ordering of the day group itself.
        expect(bal).toBeCloseTo(anchorBalance, 2);
      }
      const amt = amountById.get(id);
      expect(amt, `unexpected row id rendered: ${id}`).not.toBeUndefined();
      prevBal = bal;
      prevRowAmount = amt!;
    }
  });
});
