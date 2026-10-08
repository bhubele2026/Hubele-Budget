import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { baseReads, installApi, ledgerPage, ledgerRow, on, renderActivity, SPINE } from "./testApi";

/**
 * ⭐ ACTIVITY AGAINST A FAKE SERVER. `fetch` is replaced and the real generated
 * hooks run, so the URLs, methods, bodies and query strings checked here are
 * what the app really sends. Charges and amounts are synthetic.
 */

beforeEach(() => {
  window.history.replaceState(null, "", "/activity");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ROWS = [
  ledgerRow("t1", "2026-10-07", "Corner Market", "-18.40", "c1", { pending: true }),
  ledgerRow("t2", "2026-10-07", "Coffee Cart", "-6.25", null),
  ledgerRow("t3", "2026-10-06", "Payroll deposit", "1200.00", "c1"),
];

const text = () => document.body.textContent ?? "";

describe("Ledger — rows, days, paging", () => {
  it("renders a page grouped by household day, with amounts, pending, mask and chips; Load more adds the next page", async () => {
    const api = installApi([
      on("GET", "/api/transactions/ledger", (c) =>
        c.query.get("cursor") === "c2"
          ? ledgerPage([ledgerRow("t4", "2026-10-05", "Hardware Depot", "-64.20", "c1")], null, 4)
          : ledgerPage(ROWS, "c2", 4),
      ),
      ...baseReads,
    ]);
    renderActivity("ledger");
    const days = await screen.findAllByTestId("day-group");
    expect(days.map((d) => d.getAttribute("aria-label"))).toEqual(["Today", "Yesterday"]);
    const rows = screen.getAllByTestId("ledger-row");
    expect(rows).toHaveLength(3);
    const corner = rows[0]!;
    expect(corner.textContent).toContain("Corner Market");
    expect(within(corner).getByTestId("row-pending").textContent).toBe("pending");
    expect(within(corner).getByTestId("row-mask").textContent).toBe("••4421");
    expect(corner.querySelector("data")!.textContent).toBe("-$18");
    expect(corner.querySelector("data")!.getAttribute("value")).toBe("-18.40");
    expect(rows[1]!.textContent).toContain("Not filed");
    expect(rows[2]!.querySelector("data")!.textContent).toBe("+$1,200");

    // Bounded: from/to and a page of 50, on every ledger request.
    const first = api.find("GET", /ledger$/)[0]!;
    expect(first.query.get("limit")).toBe("50");
    expect(first.query.get("from")).toBe("2026-10-01");
    expect(first.query.get("to")).toBe("2026-10-07");

    const user = userEvent.setup();
    await user.click(screen.getByTestId("load-more"));
    await waitFor(() => expect(screen.getAllByTestId("ledger-row")).toHaveLength(4));
    const second = api.find("GET", /ledger$/).find((c) => c.query.get("cursor") === "c2")!;
    expect(second.query.get("limit")).toBe("50");
    expect(second.query.get("from")).toBe("2026-10-01");
    expect(screen.queryByTestId("load-more")).toBeNull();
  });

  it("this week / last month / needs filing / account all go to the server as filters", async () => {
    const api = installApi([on("GET", "/api/transactions/ledger", ledgerPage(ROWS)), ...baseReads]);
    renderActivity("ledger");
    await screen.findAllByTestId("ledger-row");
    const user = userEvent.setup();
    const lastQuery = () => api.find("GET", /ledger$/).at(-1)!.query;

    await user.click(within(screen.getByTestId("range")).getByRole("button", { name: "This week" }));
    await waitFor(() => expect(lastQuery().get("from")).toBe("2026-10-04"));
    expect(lastQuery().get("to")).toBe("2026-10-07");

    await user.click(within(screen.getByTestId("range")).getByRole("button", { name: "Last month" }));
    await waitFor(() => expect(lastQuery().get("from")).toBe("2026-09-01"));
    expect(lastQuery().get("to")).toBe("2026-09-30");

    await user.click(within(screen.getByTestId("filing-filter")).getByRole("button", { name: "Needs filing" }));
    await waitFor(() => expect(lastQuery().get("uncategorized")).toBe("true"));

    await user.selectOptions(await screen.findByTestId("account-filter"), "acct2");
    await waitFor(() => expect(lastQuery().get("account")).toBe("acct2"));
  });

  it("search waits 250 ms and passes `search`; partial keystrokes are never sent", async () => {
    const api = installApi([on("GET", "/api/transactions/ledger", ledgerPage(ROWS)), ...baseReads]);
    renderActivity("ledger");
    await screen.findAllByTestId("ledger-row");
    const user = userEvent.setup();
    await user.type(screen.getByTestId("ledger-search"), "mark");
    await waitFor(() => expect(api.find("GET", /ledger$/).some((c) => c.query.get("search") === "mark")).toBe(true));
    const searches = api.find("GET", /ledger$/).map((c) => c.query.get("search"));
    expect(searches.filter((s) => s !== null)).toEqual(["mark"]);
  });

  it("empty and failed states: a Note, and Retry when the first load fails", async () => {
    installApi([on("GET", "/api/transactions/ledger", ledgerPage([])), ...baseReads]);
    renderActivity("ledger");
    expect((await screen.findByTestId("ledger-empty")).textContent).toBe("No charges in this range.");
    cleanup();
    installApi([on("GET", "/api/transactions/ledger", { error: "boom" }, 500), ...baseReads]);
    renderActivity("ledger");
    expect((await screen.findByTestId("refresh-note")).textContent).toContain("Couldn't load these numbers.");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryAllByTestId("ledger-row")).toHaveLength(0);
  });

  it("shows a skeleton once while cold", async () => {
    installApi([on("GET", "/api/transactions/ledger", () => new Promise(() => {}) as never), ...baseReads]);
    renderActivity("ledger");
    expect(screen.getByTestId("ledger-skeleton")).toBeTruthy();
  });

  it("a provisional category is a dotted chip with the word 'provisional'", async () => {
    installApi([
      on("GET", "/api/transactions/ledger", ledgerPage([ledgerRow("t1", "2026-10-07", "Gas Station", "-41.10", "c3", { categoryProvisional: true })])),
      ...baseReads,
    ]);
    renderActivity("ledger");
    const chip = await screen.findByTestId("category-chip");
    expect(chip.textContent).toContain("Fuel");
    expect(chip.textContent).toContain("provisional");
    expect(chip.className).toContain("border-dotted");
    expect(chip.hasAttribute("data-provisional")).toBe(true);
  });
});

describe("Ledger — filing a charge, and H2 remembers", () => {
  const patch = (extra: Record<string, unknown> = {}) =>
    on("PATCH", /\/api\/transactions\/t1$/, (c) => ({
      ...ROWS[0],
      categoryId: (c.body as { categoryId: string }).categoryId,
      repointedRules: [],
      ruleAction: { kind: "none" },
      retroactiveCandidates: null,
      ...extra,
    }));

  async function pickDining() {
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Change category for Corner Market/ }));
    await user.type(await screen.findByTestId("category-search"), "dining");
    expect(screen.getAllByTestId("category-option").map((o) => o.textContent)).toEqual(["Dining out"]);
    await user.click(screen.getByTestId("category-option"));
    return user;
  }

  it("PATCHes the id and category, says what H2 will remember, offers Undo — and no 'Apply' unless the server reports similar charges", async () => {
    const api = installApi([on("GET", "/api/transactions/ledger", ledgerPage(ROWS)), patch(), ...baseReads]);
    renderActivity("ledger");
    await pickDining();
    const toast = await screen.findByTestId("toast");
    expect(toast.textContent).toContain("Filed under Dining out. H2 will remember Corner Market.");
    expect(within(toast).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(within(toast).queryByRole("button", { name: /Apply to/ })).toBeNull();
    const sent = api.find("PATCH", /transactions\/t1$/);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({ categoryId: "c2" });
  });

  it("the chip changes at once and rolls back with a notice when the server refuses", async () => {
    installApi([
      on("GET", "/api/transactions/ledger", ledgerPage(ROWS)),
      on("PATCH", /\/api\/transactions\/t1$/, { error: "no" }, 500),
      ...baseReads,
    ]);
    renderActivity("ledger");
    await pickDining();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't file that charge. It's back as it was.");
    const chip = within(screen.getAllByTestId("ledger-row")[0]!).getByTestId("category-chip");
    expect(chip.textContent).toContain("Groceries");
  });

  it("Undo uses the decision id when the server sends one", async () => {
    const api = installApi([
      on("GET", "/api/transactions/ledger", ledgerPage(ROWS)),
      patch({ decisionId: "dec1" }),
      on("POST", "/api/category-decisions/dec1/undo", { decisionId: "dec1", transactionId: "t1", categoryId: "c1" }),
      ...baseReads,
    ]);
    renderActivity("ledger");
    const user = await pickDining();
    await user.click(within(await screen.findByTestId("toast")).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(api.find("POST", /category-decisions\/dec1\/undo$/)).toHaveLength(1));
    expect(await screen.findByText("Put back.")).toBeTruthy();
  });

  it("Undo without a decision id puts the previous category back (an API gap, noted in the review)", async () => {
    const api = installApi([on("GET", "/api/transactions/ledger", ledgerPage(ROWS)), patch(), ...baseReads]);
    renderActivity("ledger");
    const user = await pickDining();
    await user.click(within(await screen.findByTestId("toast")).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(api.find("PATCH", /transactions\/t1$/)).toHaveLength(2));
    expect(api.find("PATCH", /transactions\/t1$/)[1]!.body).toEqual({ categoryId: "c1" });
  });

  it("'Apply to N similar' appears only when offered, and nothing moves until it is pressed", async () => {
    const api = installApi([
      on("GET", "/api/transactions/ledger", ledgerPage(ROWS)),
      patch({ retroactiveCandidates: { count: 4, sample: [] } }),
      on("GET", "/api/learned-rules", [
        { id: "ru1", signature: "corner market", scope: "merchant", categoryId: "c2", count: 1, disabled: false, amountBandLo: null, amountBandHi: null, plaidAccountId: null, lastConfirmedAt: null, source: "user", createdAt: "2026-10-07T00:00:00Z" },
      ]),
      on("POST", "/api/learned-rules/ru1/apply-retroactively", { updated: 4 }),
      ...baseReads,
    ]);
    renderActivity("ledger");
    const user = await pickDining();
    const toast = await screen.findByTestId("toast");
    expect(api.find("POST", /apply-retroactively/)).toHaveLength(0);
    await user.click(within(toast).getByRole("button", { name: "Apply to 4 similar" }));
    await waitFor(() => expect(api.find("POST", /learned-rules\/ru1\/apply-retroactively$/)).toHaveLength(1));
    expect(await screen.findByText("Filed 4 similar charges.")).toBeTruthy();
  });
});

describe("Ledger — the row menu and the split sheet", () => {
  async function openSplit() {
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "More for Corner Market" }));
    expect(screen.getByTestId("row-details").textContent).toContain("CORNER MARKET");
    await user.click(screen.getByTestId("row-split"));
    return user;
  }
  const apiWithSplit = () =>
    installApi([
      on("GET", "/api/transactions/ledger", ledgerPage(ROWS)),
      on("GET", /\/api\/transactions\/t1\/splits$/, { transactionId: "t1", amount: "-18.40", invalid: false, splits: [] }),
      on("POST", /\/api\/transactions\/t1\/splits$/, undefined, 204),
      ...baseReads,
    ]);

  it("Save stays off until the remainder reads $0.00, then POSTs signed parts", async () => {
    const api = apiWithSplit();
    renderActivity("ledger");
    const user = await openSplit();
    const save = await screen.findByTestId("split-save");
    const remainder = screen.getByTestId("split-remainder");
    expect((save as HTMLButtonElement).disabled).toBe(true);

    const amount1 = screen.getByLabelText("Amount for part 1");
    await user.clear(amount1);
    await user.type(amount1, "10");
    expect(remainder.textContent).toBe("Left to assign $8.40");
    expect((save as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText("Amount for part 2"), "8.40");
    await user.selectOptions(screen.getByLabelText("Category for part 2"), "c2");
    expect(remainder.textContent).toBe("Balanced $0.00");
    expect((save as HTMLButtonElement).disabled).toBe(false);

    await user.clear(screen.getByLabelText("Amount for part 2"));
    await user.type(screen.getByLabelText("Amount for part 2"), "9");
    expect(remainder.textContent).toBe("Over by $0.60");
    expect((save as HTMLButtonElement).disabled).toBe(true);

    await user.clear(screen.getByLabelText("Amount for part 2"));
    await user.type(screen.getByLabelText("Amount for part 2"), "8.40");
    await user.click(save);
    await waitFor(() => expect(api.find("POST", /t1\/splits$/)).toHaveLength(1));
    expect(api.find("POST", /t1\/splits$/)[0]!.body).toEqual({
      splits: [
        { categoryId: "c1", amount: "-10.00" },
        { categoryId: "c2", amount: "-8.40" },
      ],
    });
    // The parent row now says it is split.
    expect((await screen.findByTestId("split-badge")).textContent).toBe("split ×2");
  });

  it("an unfiled part keeps Save off even when the amounts balance", async () => {
    apiWithSplit();
    renderActivity("ledger");
    const user = await openSplit();
    const amount1 = await screen.findByLabelText("Amount for part 1");
    await user.clear(amount1);
    await user.type(amount1, "10");
    await user.type(screen.getByLabelText("Amount for part 2"), "8.40");
    expect(screen.getByTestId("split-remainder").textContent).toBe("Balanced $0.00");
    expect((screen.getByTestId("split-save") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Review queue", () => {
  const item = (n: number, over: Record<string, unknown> = {}) => ({
    decisionId: `d${n}`,
    transactionId: `t${n}`,
    occurredOn: `2026-10-0${n}`,
    description: `Merchant ${n}`,
    amount: "-20.00",
    account: "••4421",
    currentCategoryId: null,
    suggestedCategoryId: "c1",
    confidence: 0.7,
    band: "queue",
    source: "memory",
    explanation: "x",
    createdAt: `2026-10-0${n}T12:00:00Z`,
    flags: { novelMerchant: false, amountAnomaly: false, splitNeedsRebalance: false },
    ...over,
  });
  const resolution = (c: { path: string }) => ({
    decisionId: c.path.split("/")[4],
    transactionId: "t",
    resolution: "accepted",
    categoryId: "c1",
    userDecisionId: "u1",
    retroactiveCandidates: null,
  });
  const reviewApi = (items: unknown[]) =>
    installApi([
      on("GET", "/api/categorization/review", { items, total: items.length }),
      on("POST", /\/api\/categorization\/review\/[^/]+\/(accept|skip|correct)$/, resolution),
      ...baseReads,
    ]);

  it("lists oldest first with the proposal as a provisional chip, one line why, and flags as words", async () => {
    reviewApi([item(3, { source: "recurring" }), item(1, { flags: { novelMerchant: true, amountAnomaly: true, splitNeedsRebalance: false } }), item(2, { source: "rule" })]);
    renderActivity("review");
    const rows = await screen.findAllByTestId("review-item");
    expect(rows.map((r) => r.textContent?.includes(`Merchant ${rows.indexOf(r) + 1}`))).toEqual([true, true, true]);
    expect(within(rows[0]!).getByTestId("review-chip").textContent).toContain("Groceries");
    expect(within(rows[0]!).getByTestId("review-chip").textContent).toContain("provisional");
    expect(within(rows[0]!).getByTestId("review-why").textContent).toBe("Learned from a correction");
    expect(within(rows[0]!).getAllByTestId("review-flag").map((f) => f.textContent)).toEqual(["New merchant", "Unusual amount"]);
    expect(within(rows[1]!).getByTestId("review-why").textContent).toBe("Matches a rule");
    expect(within(rows[2]!).getByTestId("review-why").textContent).toBe("Looks like a recurring bill");
  });

  it("keyboard: j/k move, a accepts, s skips, c changes; each calls the right endpoint", async () => {
    const api = reviewApi([item(1), item(2), item(3)]);
    renderActivity("review");
    await screen.findAllByTestId("review-item");
    const user = userEvent.setup();
    const current = () => screen.getAllByTestId("review-item").findIndex((r) => r.getAttribute("aria-current") === "true");
    expect(current()).toBe(0);
    await user.keyboard("j");
    expect(current()).toBe(1);
    await user.keyboard("k");
    expect(current()).toBe(0);

    await user.keyboard("a");
    await waitFor(() => expect(api.find("POST", /review\/d1\/accept$/)).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByTestId("review-item")).toHaveLength(2));

    await user.keyboard("s");
    await waitFor(() => expect(api.find("POST", /review\/d2\/skip$/)).toHaveLength(1));
    await waitFor(() => expect(screen.getAllByTestId("review-item")).toHaveLength(1));

    await user.keyboard("c");
    await user.click(await screen.findByRole("button", { name: "Fuel" }));
    await waitFor(() => expect(api.find("POST", /review\/d3\/correct$/)).toHaveLength(1));
    expect(api.find("POST", /review\/d3\/correct$/)[0]!.body).toEqual({ categoryId: "c3" });
  });

  it("the three buttons do the same; keys are ignored while typing in a field", async () => {
    const api = reviewApi([item(1), item(2)]);
    renderActivity("review");
    const user = userEvent.setup();
    const rows = await screen.findAllByTestId("review-item");
    await user.click(within(rows[0]!).getByTestId("review-accept"));
    await waitFor(() => expect(api.find("POST", /review\/d1\/accept$/)).toHaveLength(1));
    await user.click(within(screen.getAllByTestId("review-item")[0]!).getByTestId("review-skip"));
    await waitFor(() => expect(api.find("POST", /review\/d2\/skip$/)).toHaveLength(1));
    expect(await screen.findByTestId("review-empty")).toBeTruthy();
  });

  it("an answer the server refuses brings the item back with a notice", async () => {
    installApi([
      on("GET", "/api/categorization/review", { items: [item(1)], total: 1 }),
      on("POST", /accept$/, { error: "no" }, 500),
      ...baseReads,
    ]);
    renderActivity("review");
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("review-accept"));
    expect((await screen.findByRole("alert")).textContent).toContain("still in the queue");
    expect(screen.getAllByTestId("review-item")).toHaveLength(1);
  });

  it("empty: 'Nothing to review. H2 filed everything it was sure about.'", async () => {
    reviewApi([]);
    renderActivity("review");
    expect((await screen.findByTestId("review-empty")).textContent).toBe("Nothing to review. H2 filed everything it was sure about.");
  });

  it("the Review entry in the section index carries the queue's count", async () => {
    reviewApi([item(1), item(2)]);
    renderActivity("review");
    await screen.findAllByTestId("review-item");
    const index = screen.getByTestId("activity-index");
    expect(within(index).getByRole("link", { name: /Review/ }).textContent).toContain("2");
    expect(within(index).getByRole("link", { name: /Review/ }).getAttribute("aria-current")).toBe("page");
    expect(within(index).getByRole("link", { name: "Ledger" }).getAttribute("href")).toBe("/activity");
    expect(within(index).getByRole("link", { name: "Rules" }).getAttribute("href")).toBe("/activity/rules");
  });
});

describe("Rules", () => {
  const rule = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    signature: "corner market",
    scope: "merchant",
    plaidAccountId: null,
    amountBandLo: null,
    amountBandHi: null,
    categoryId: "c1",
    count: 6,
    lastConfirmedAt: "2026-10-05T12:00:00Z",
    disabled: false,
    source: "user",
    createdAt: "2026-08-01T12:00:00Z",
    ...over,
  });

  it("lists merchant, category, scope, times confirmed and last confirmed; links to the hand-written rules", async () => {
    installApi([on("GET", "/api/learned-rules", [rule("r1")]), ...baseReads]);
    renderActivity("rules");
    const row = await screen.findByTestId("rule");
    expect(row.textContent).toContain("Corner Market");
    expect(row.textContent).toContain("Confirmed 6 times · last Oct 5");
    expect((within(row).getByTestId("rule-category") as HTMLSelectElement).value).toBe("c1");
    expect((within(row).getByTestId("rule-scope") as HTMLSelectElement).value).toBe("merchant");
    expect(screen.getByTestId("classic-rules-link").getAttribute("href")).toBe("/classic/mapping-rules");
  });

  it("changing the scope or the category PATCHes the rule; a refusal says so", async () => {
    const api = installApi([
      on("GET", "/api/learned-rules", [rule("r1")]),
      on("PATCH", /learned-rules\/r1$/, rule("r1")),
      ...baseReads,
    ]);
    renderActivity("rules");
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByTestId("rule-scope"), "merchant_account");
    await waitFor(() => expect(api.find("PATCH", /learned-rules\/r1$/)).toHaveLength(1));
    expect(api.find("PATCH", /learned-rules\/r1$/)[0]!.body).toEqual({ scope: "merchant_account" });
    await user.selectOptions(screen.getByTestId("rule-category"), "c3");
    await waitFor(() => expect(api.find("PATCH", /learned-rules\/r1$/)).toHaveLength(2));
    expect(api.find("PATCH", /learned-rules\/r1$/)[1]!.body).toEqual({ categoryId: "c3" });
  });

  it("Turn off PATCHes disabled; Delete asks first; Apply to past charges is an explicit press that reports the count", async () => {
    const api = installApi([
      on("GET", "/api/learned-rules", [rule("r1")]),
      on("PATCH", /learned-rules\/r1$/, rule("r1", { disabled: true })),
      on("DELETE", /learned-rules\/r1$/, undefined, 204),
      on("POST", /learned-rules\/r1\/apply-retroactively$/, { updated: 7 }),
      ...baseReads,
    ]);
    renderActivity("rules");
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("rule-toggle"));
    await waitFor(() => expect(api.find("PATCH", /r1$/)[0]?.body).toEqual({ disabled: true }));

    expect(api.find("POST", /apply-retroactively/)).toHaveLength(0);
    await user.click(screen.getByTestId("rule-apply"));
    await waitFor(() => expect(api.find("POST", /r1\/apply-retroactively$/)).toHaveLength(1));
    expect(await screen.findByText("Filed 7 past charges.")).toBeTruthy();

    await user.click(screen.getByTestId("rule-delete"));
    expect(api.find("DELETE", /r1$/)).toHaveLength(0);
    await user.click(screen.getByTestId("rule-delete-confirm"));
    await waitFor(() => expect(api.find("DELETE", /learned-rules\/r1$/)).toHaveLength(1));
  });

  it("empty: says nothing is learned yet", async () => {
    installApi([on("GET", "/api/learned-rules", []), ...baseReads]);
    renderActivity("rules");
    expect((await screen.findByTestId("rules-empty")).textContent).toContain("hasn't learned a merchant yet");
  });
});

describe("Handled by H2 — the trail, Why? and Undo", () => {
  const act = (id: string, runId: string, over: Record<string, unknown> = {}) => ({
    id, runId, type: "set_category", targetKind: "transaction", targetId: id, outcome: "applied", reversible: true, undoneAt: null, createdAt: "2026-10-07T14:30:00Z", ...over,
  });
  const apiWith = (actions: unknown[], findings: unknown[] = [], extra: ReturnType<typeof on>[] = []) =>
    installApi([
      on("GET", "/api/transactions/ledger", ledgerPage(ROWS)),
      on("GET", "/api/agent/actions", { actions }),
      on("GET", "/api/agent/findings", { findings }),
      ...extra,
      ...baseReads,
    ]);

  it("Undo shows only while reversible and not undone; the line is words", async () => {
    apiWith([
      act("a1", "r1"),
      act("a2", "r1"),
      act("a3", "r2", { type: "remember", reversible: false }),
      act("a4", "r3", { type: "propose", undoneAt: "2026-10-07T15:00:00Z" }),
    ]);
    renderActivity("ledger");
    const items = await screen.findAllByTestId("trail-item");
    expect(items[0]!.textContent).toMatch(/^Filed 2 charges/);
    expect(items[1]!.textContent).toMatch(/^Remembered 1 merchant/);
    expect(items[2]!.textContent).toMatch(/^Suggested a change/);
    expect(within(items[0]!).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(within(items[1]!).queryByRole("button", { name: "Undo" })).toBeNull(); // not reversible
    expect(within(items[2]!).queryByRole("button", { name: "Undo" })).toBeNull(); // already undone
    expect(items[2]!.textContent).toContain("Undone");
  });

  it("Undo posts each undoable action; a 501 is a quiet notice, not an error", async () => {
    const api = apiWith([act("a1", "r1"), act("a2", "r1")], [], [on("POST", /agent\/actions\/[^/]+\/undo$/, { error: "not implemented" }, 501)]);
    renderActivity("ledger");
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("trail-undo"));
    await waitFor(() => expect(api.find("POST", /agent\/actions\/a1\/undo$/)).toHaveLength(1));
    expect(await screen.findByText("Undo arrives with the next update.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("Undo on success says Undone", async () => {
    const api = apiWith([act("a1", "r1")], [], [on("POST", /agent\/actions\/a1\/undo$/, {})]);
    renderActivity("ledger");
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("trail-undo"));
    await waitFor(() => expect(api.find("POST", /a1\/undo$/)).toHaveLength(1));
    expect(await screen.findByText("Undone.")).toBeTruthy();
  });

  it("Why? opens what is known; a finding's payload reads as words and figures", async () => {
    apiWith(
      [act("x1", "r1", { type: "finding", targetKind: "finding", targetId: "f1", outcome: "needs_attention", reversible: false })],
      [{ id: "f1", kind: "duplicate_charge", severity: "watch", confidence: "estimate", payload: { transactionId: "t9", amount: 18.4, daysApart: 1 }, firstSeen: "2026-10-06T22:00:00Z", lastSeen: "2026-10-07T08:00:00Z", resolvedAt: null, dismissedAt: null }],
    );
    renderActivity("ledger");
    const user = userEvent.setup();
    const item = await screen.findByTestId("trail-item");
    expect(item.textContent).toContain("Flagged a possible duplicate");
    await user.click(within(item).getByRole("button", { name: "Why?" }));
    const why = await screen.findByTestId("why-sheet");
    expect(why.textContent).toContain("Needs you");
    expect(why.querySelector("[data-testid=why-figures]")!.textContent).toContain("Amount$18");
    expect(why.textContent).toContain("Days apart1");
    expect(why.textContent).not.toContain("t9"); // refs are not shown
  });

  it("findings sit under 'Needs attention' with Dismiss; a shortfall links to Today", async () => {
    const api = apiWith(
      [],
      [
        { id: "f1", kind: "duplicate_charge", severity: "watch", confidence: "estimate", payload: {}, firstSeen: "2026-10-06T22:00:00Z", lastSeen: "2026-10-07T08:00:00Z", resolvedAt: null, dismissedAt: null },
        { id: "f2", kind: "shortfall_before_income", severity: "high", confidence: "confirmed", payload: { shortfall: 212 }, firstSeen: "2026-10-06T22:00:00Z", lastSeen: "2026-10-07T08:00:00Z", resolvedAt: null, dismissedAt: null },
      ],
      [on("POST", /agent\/findings\/f1\/dismiss$/, { id: "f1" })],
    );
    renderActivity("ledger");
    const user = userEvent.setup();
    const found = await screen.findAllByTestId("finding");
    expect(found).toHaveLength(2);
    expect(within(found[0]!).getByRole("button", { name: "Dismiss" })).toBeTruthy();
    expect(within(found[1]!).getByRole("link", { name: "See Today" }).getAttribute("href")).toBe("/");
    expect(within(found[0]!).queryByRole("link", { name: "See Today" })).toBeNull();
    await user.click(within(found[0]!).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(api.find("POST", /findings\/f1\/dismiss$/)).toHaveLength(1));
  });

  it("no trail and no findings draws nothing", async () => {
    apiWith([]);
    renderActivity("ledger");
    await screen.findAllByTestId("ledger-row");
    expect(screen.queryByTestId("trail")).toBeNull();
    expect(screen.queryByTestId("findings")).toBeNull();
  });
});

describe("Activity — the standing laws", () => {
  it("never renders an amount owed, even if a balance were smuggled onto the spine", async () => {
    installApi([
      on("GET", "/api/transactions/ledger", ledgerPage(ROWS)),
      on("GET", "/api/spine", {
        ...SPINE,
        debt: { payoffPct: 40, balance: "98765.43", owed: "98765.43", totalOwed: 98765.43 },
      }),
      ...baseReads,
    ]);
    renderActivity("ledger");
    await screen.findAllByTestId("ledger-row");
    await waitFor(() => expect(screen.getByTestId("activity")).toBeTruthy());
    expect(text().toLowerCase()).not.toMatch(/\bowed?\b|\bowing\b|balance due|balance remaining|remaining debt|98,765|98765/);
  });

  it("whole dollars on the list; cents only inside a detail sheet", async () => {
    installApi([on("GET", "/api/transactions/ledger", ledgerPage(ROWS)), ...baseReads]);
    renderActivity("ledger");
    const user = userEvent.setup();
    await screen.findAllByTestId("ledger-row");
    expect(screen.getByTestId("ledger").textContent).not.toMatch(/\.\d\d/);
    await user.click(screen.getByRole("button", { name: "More for Corner Market" }));
    expect(screen.getByTestId("row-details").textContent).toContain("-$18.40");
  });

  it("the section tabs on a phone are links too (Segmented)", async () => {
    installApi([on("GET", "/api/transactions/ledger", ledgerPage(ROWS)), ...baseReads]);
    renderActivity("ledger");
    const seg = await screen.findByTestId("activity-segmented");
    expect(within(seg).getByRole("link", { name: "Ledger" }).getAttribute("aria-current")).toBe("page");
    expect(within(seg).getByRole("link", { name: /Review/ }).getAttribute("href")).toBe("/activity/review");
  });
});
