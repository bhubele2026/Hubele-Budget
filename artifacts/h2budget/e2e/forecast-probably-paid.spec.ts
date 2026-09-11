import { test, expect, type Page } from "@playwright/test";
import {
  cleanupTestUsers,
  createTestUser,
  signInAndOpen,
} from "./helpers/clerk";

/**
 * (PR5b) The server's "probably paid" pair on Review: "Suggested" → Confirm,
 * and "Suggested" → Not this.
 *
 * Seeds are deterministic relative to the HOUSEHOLD date — the server's own
 * `today` from GET /api/forecast — and the browser runs in the household's
 * time zone, so Review's month is the household month on every run:
 *   - a monthly bill "Aqualine <tag>" for $150, due today;
 *   - a bank row "AQUALINE <TAG> WEB" for $150, dated today.
 * The row carries the bill's full name, the exact amount, on the same day, so
 * the server pairs them (high confidence, off the curve) on every calendar day.
 */
test.use({ timezoneId: "America/Chicago" });

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

type Seeded = {
  itemId: string;
  txnId: string;
  billName: string;
  description: string;
  today: string;
};

type Resolution = {
  recurringItemId: string | null;
  occurrenceDate: string | null;
  matchedTxnId: string | null;
  status: string;
};

async function seedPair(page: Page): Promise<Seeded> {
  const { today } = await apiCall<{ today: string }>(page, "GET", "/api/forecast");
  const tag = `q${Math.random().toString(36).slice(2, 8)}`;
  const billName = `Aqualine ${tag}`;
  const item = await apiCall<{ id: string }>(page, "POST", "/api/recurring-items", {
    name: billName,
    kind: "bill",
    amount: "150.00",
    frequency: "monthly",
    dayOfMonth: Number(today.slice(8, 10)),
    active: "true",
  });
  const description = `AQUALINE ${tag.toUpperCase()} WEB`;
  const txn = await apiCall<{ id: string }>(page, "POST", "/api/transactions", {
    occurredOn: today,
    description,
    amount: "-150.00",
    forecastFlag: true,
  });
  return { itemId: item.id, txnId: txn.id, billName, description, today };
}

function captureResolutionPosts(page: Page): Array<Record<string, unknown>> {
  const posts: Array<Record<string, unknown>> = [];
  page.on("request", (req) => {
    if (
      req.method() === "POST" &&
      new URL(req.url()).pathname === "/api/forecast/resolutions"
    ) {
      try {
        posts.push(JSON.parse(req.postData() ?? "{}"));
      } catch {
        /* ignore */
      }
    }
  });
  return posts;
}

async function openSuggested(page: Page, label: string): Promise<Seeded> {
  const { email, password } = await createTestUser(label, provisionedUserIds);
  await signInAndOpen(page, email, password, "/review");
  await expect(page.getByTestId("card-from-bank")).toBeVisible({ timeout: 15_000 });
  const seeded = await seedPair(page);
  await page.goto("/review");
  await expect(page.getByTestId("card-from-bank")).toBeVisible({ timeout: 15_000 });

  const strip = page.getByTestId(`probably-paid-${seeded.txnId}`);
  await expect(strip).toBeVisible({ timeout: 15_000 });
  await expect(strip).toContainText("Suggested");
  await expect(strip).toContainText(seeded.billName);
  await expect(page.getByTestId(`probably-paid-difference-${seeded.txnId}`)).toHaveText("exact");
  await expect(page.getByTestId(`probably-paid-days-${seeded.txnId}`)).toHaveText("same day");
  await expect(page.getByTestId(`probably-paid-curve-${seeded.txnId}`)).toHaveText("Out of forecast");
  // The server's pair is the row's only suggestion: no client chips, no
  // one-click Match, and (paid exactly) nothing partial to record.
  await expect(page.getByTestId(`bank-suggestions-${seeded.txnId}`)).toHaveCount(0);
  await expect(page.getByTestId(`one-click-match-${seeded.txnId}`)).toHaveCount(0);
  await expect(page.getByTestId(`probably-paid-partial-${seeded.txnId}`)).toHaveCount(0);
  return seeded;
}

test.describe("Forecast Review — server 'probably paid' suggestions (PR5b)", () => {
  test("Suggested → Confirm writes the pair as matched and moves the row to Resolved", async ({
    page,
  }) => {
    const s = await openSuggested(page, "forecast-probably-paid-confirm");
    const posts = captureResolutionPosts(page);

    await page.getByTestId(`probably-paid-confirm-${s.txnId}`).click();

    const notifications = page.getByRole("region", { name: /notifications/i });
    await expect(
      notifications.getByText(new RegExp(`Matched to ${s.billName}`)),
    ).toBeVisible({ timeout: 10_000 });
    expect(posts).toContainEqual(
      expect.objectContaining({
        status: "matched",
        recurringItemId: s.itemId,
        occurrenceDate: s.today,
        matchedTxnId: s.txnId,
      }),
    );

    await expect(page.getByTestId(`select-bank-${s.txnId}`)).toHaveCount(0, {
      timeout: 10_000,
    });
    const resolvedList = page.getByTestId("bank-resolved-list");
    await expect(resolvedList).toContainText(s.description);
    await expect(resolvedList).toContainText(/matched/i);

    const fc = await apiCall<{ resolutions: Resolution[] }>(page, "GET", "/api/forecast");
    expect(fc.resolutions).toContainEqual(
      expect.objectContaining({
        status: "matched",
        recurringItemId: s.itemId,
        occurrenceDate: s.today,
        matchedTxnId: s.txnId,
      }),
    );
  });

  test("Suggested → Not this keeps the row in Review with no suggestion, and the answer sticks", async ({
    page,
  }) => {
    const s = await openSuggested(page, "forecast-probably-paid-not-this");
    const posts = captureResolutionPosts(page);

    await page.getByTestId(`probably-paid-reject-${s.txnId}`).click();

    const notifications = page.getByRole("region", { name: /notifications/i });
    await expect(notifications.getByText("Not this row")).toBeVisible({ timeout: 10_000 });
    expect(posts).toContainEqual(
      expect.objectContaining({
        status: "not_match",
        recurringItemId: s.itemId,
        occurrenceDate: s.today,
        matchedTxnId: s.txnId,
      }),
    );

    // The strip goes; the row stays in Review. The server offers nothing for
    // the rejected pair, and the client never re-offers it (no chips, no
    // one-click Match, no Enter shortcut, not in "Match all confident").
    await expect(page.getByTestId(`probably-paid-${s.txnId}`)).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(page.getByTestId(`select-bank-${s.txnId}`)).toBeVisible();
    await expect(page.getByTestId(`bank-suggestions-${s.txnId}`)).toHaveCount(0);
    await expect(page.getByTestId(`one-click-match-${s.txnId}`)).toHaveCount(0);
    await expect(page.getByTestId(`inbox-card-${s.txnId}`)).toHaveCount(0);
    await expect(page.getByTestId("bulk-match-confident")).toHaveCount(0);

    const signal = await apiCall<{ matches?: Array<{ txnId: string }> }>(
      page,
      "GET",
      "/api/forecast/cash-signal?horizonDays=30",
    );
    expect((signal.matches ?? []).map((m) => m.txnId)).not.toContain(s.txnId);

    const fc = await apiCall<{ resolutions: Resolution[] }>(page, "GET", "/api/forecast");
    expect(fc.resolutions).toContainEqual(
      expect.objectContaining({
        status: "not_match",
        recurringItemId: s.itemId,
        occurrenceDate: s.today,
        matchedTxnId: s.txnId,
      }),
    );
    expect(
      fc.resolutions.filter((r) => r.matchedTxnId === s.txnId && r.status !== "not_match"),
    ).toEqual([]);
  });
});
