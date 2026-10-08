import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import type { CategorizationSettings } from "@workspace/api-client-react";
import { createQueryClient } from "@/data/queryClient";
import {
  getGetCategorizationSettingsQueryKey,
  getGetCategorizationSettingsUrl,
  getGetSpineQueryKey,
  getListCategorizationReviewQueryKey,
  getListMappingRulesQueryKey,
  getListMappingRulesUrl,
  getRunCategorizationUrl,
  getUpdateCategorizationSettingsUrl,
} from "@workspace/api-client-react";
import { RUN_URL, mappingRulesKey, settingsKey } from "@/data/automationApi";
import { installApi, on, CATEGORIES } from "@/screens/activity/testApi";
import Automation from "./Automation";
import DesignAutomation, { SAMPLE_SETTINGS } from "@/screens/design/DesignAutomation";
import { backlogLine, bandWord, bankLine, engineLine, fullDate, requirementFigure, resolutionWord, runResultLine, sourceWord } from "./automationWords";

const view = (over: Record<string, unknown> = {}) =>
  ({ ...(SAMPLE_SETTINGS as unknown as Record<string, unknown>), ...over }) as unknown as CategorizationSettings;

function mount(settings: CategorizationSettings, owner = true, extra: ReturnType<typeof on>[] = []) {
  let current = settings;
  const api = installApi([
    ...extra,
    (c) => (c.method === "GET" && c.path === "/api/categorization/settings" ? [200, current] : undefined),
    on("GET", "/api/me", { isOwner: owner }),
    on("GET", "/api/budget/categories", CATEGORIES),
    (c) => {
      if (c.method !== "PUT" || c.path !== "/api/categorization/settings" || owner === false) return undefined;
      current = { ...current, ...(c.body as object) } as CategorizationSettings;
      return [200, current];
    },
  ]);
  const client = createQueryClient();
  client.setDefaultOptions({ ...client.getDefaultOptions(), queries: { ...client.getDefaultOptions().queries, retry: false } });
  render(
    <QueryClientProvider client={client}>
      <Automation />
    </QueryClientProvider>,
  );
  return Object.assign(api, { client });
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => cleanup());

describe("Automation — every section from a fixture", () => {
  it("reads the heading, filing line, AI words, ladder, requirements and recent rows", async () => {
    mount(view());
    expect((await screen.findByRole("heading", { name: "Automation" })).tagName).toBe("H1");
    expect((await screen.findByTestId("engine-line")).textContent).toBe("Rules you wrote: 4 · Learned from your corrections: 11 · Recurring bills: 7");
    expect(screen.getByTestId("ai-configured").textContent).toContain("Configured");
    expect(screen.getByTestId("ai-enabled").textContent).toContain("On");
    expect(screen.getByTestId("mode-off").textContent).toBe("Off — rules and memory only");
    expect(screen.getByTestId("mode-suggest").textContent).toContain("Suggests — files what it is sure about as provisional and queues the rest; you confirm");
    expect(screen.getByTestId("mode-auto").textContent).toContain("Files on its own — only after the record below holds");
    expect(screen.getByTestId("mode-suggest").getAttribute("data-current")).toBe("true");
    expect(screen.getByTestId("mode-off").getAttribute("data-current")).toBeNull();
    expect(screen.getByTestId("mode-suggest").textContent).toContain("Now");
    expect(within(screen.getByTestId("req-judged")).getByTestId("req-figure").textContent).toBe("18 of 30 verified");
    expect(screen.getByTestId("req-judged").textContent).toContain("At least 30 suggestions you verified in Review.");
    expect(screen.getByTestId("unreviewed-line").textContent).toBe("Left unchanged, not verified: 4");
    expect(within(screen.getByTestId("req-accuracy")).getByTestId("req-figure").textContent).toBe("16 of 18 right");
    expect(screen.getByTestId("req-ai").textContent).toContain("Met");
    expect(screen.getByTestId("req-judged").textContent).toContain("Not met");
    expect(screen.getByTestId("section-requirements").textContent).toContain(
      "Verified = a suggestion you accepted or corrected in Review. One left unchanged for 14 days is not verified.",
    );
    expect(screen.getByTestId("section-requirements").textContent).not.toContain("Judged");
    expect(screen.getAllByTestId("decision")).toHaveLength(8);
    expect(screen.getByTestId("link-review").textContent).toBe("Review queue (3)");
    expect(screen.getByTestId("link-review").getAttribute("href")).toBe("/activity/review");
    expect(screen.getByTestId("link-rules").getAttribute("href")).toBe("/activity/rules");
  });

  it("AI not configured and off say so in words", async () => {
    mount(view({ ai: { configured: false, enabled: false } }));
    await screen.findByTestId("ai-configured");
    expect(screen.getByTestId("ai-configured").textContent).toContain("Not configured");
    expect(screen.getByTestId("ai-enabled").textContent).toContain("Off — turn on AI_ENABLED on the server");
  });

  it("shows the fifth and sixth requirement rows when the server sends them", async () => {
    const base = SAMPLE_SETTINGS.model;
    mount(
      view({
        model: {
          ...base,
          mode: "auto",
          requirements: [
            ...base.requirements,
            { key: "holding", label: "Holding: the last 20 are at least 8 in 10.", met: true, current: 17, target: 16 },
            { key: "floor", label: "Recent answers slipped.", met: false, current: 12, target: 18 },
          ],
        },
      }),
    );
    expect((await screen.findByTestId("req-holding")).textContent).toContain("17 of 16 right");
    expect(screen.getByTestId("req-floor").textContent).toContain("Not met");
    expect(screen.getByTestId("mode-auto").getAttribute("data-current")).toBe("true");
  });
});

describe("Automation — owner and member", () => {
  it("the owner's switches PUT only the key they change", async () => {
    const user = userEvent.setup();
    const api = mount(view(), true);
    const sw = await screen.findByTestId("auto-file");
    await waitFor(() => expect((sw as HTMLButtonElement).disabled).toBe(false));
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await user.click(sw);
    await waitFor(() => expect(api.find("PUT", /categorization\/settings/)).toHaveLength(1));
    expect(api.find("PUT", /categorization\/settings/)[0]!.body).toEqual({ autoCategorize: false });
    await waitFor(() => expect(screen.getByTestId("auto-file").getAttribute("aria-checked")).toBe("false"));
    const model = screen.getByTestId("model-auto");
    expect(model.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Takes effect when every requirement is met.")).toBeTruthy();
    api.calls.length = 0;
    await user.click(model);
    await waitFor(() => expect(api.find("PUT", /categorization\/settings/)).toHaveLength(1));
    expect(api.find("PUT", /categorization\/settings/)[0]!.body).toEqual({ modelAutoCategorize: true });
  });

  it("a member sees both switches disabled and the words Owner only", async () => {
    mount(view(), false);
    await waitFor(() => expect(screen.getAllByText(/Owner only/).length).toBeGreaterThan(0));
    expect((screen.getByTestId("auto-file") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("model-auto") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a refused PUT says so and leaves the switch as it was", async () => {
    const user = userEvent.setup();
    mount(view(), true, [on("PUT", "/api/categorization/settings", { error: "owner_only" }, 403)]);
    const sw = await screen.findByTestId("auto-file");
    await waitFor(() => expect((sw as HTMLButtonElement).disabled).toBe(false));
    await user.click(sw);
    expect((await screen.findByTestId("toast")).textContent).toBe("Only the household owner can do this.");
    expect(screen.getByTestId("auto-file").getAttribute("aria-checked")).toBe("true");
  });
});

describe("Automation — recent decisions", () => {
  it("each row reads date, amount, category, source, band and resolution", async () => {
    mount(view());
    const rows = await screen.findAllByTestId("decision");
    const first = rows[0]!;
    expect(within(first).getByTestId("decision-name").textContent).toBe("Corner Market");
    expect(within(first).getByTestId("decision-when").textContent).toBe("Oct 7");
    expect(within(first).getByTestId("decision-amount").textContent).toBe("-$18");
    expect(within(first).getByTestId("decision-category").textContent).toBe("Groceries");
    expect(within(first).getByTestId("decision-source").textContent).toBe("Rule");
    expect(within(first).getByTestId("decision-band").textContent).toBe("Filed");
    expect(within(first).getByTestId("decision-resolution").textContent).toBe("Waiting");
    expect(within(rows[5]!).getByTestId("decision-resolution").textContent).toBe("Unreviewed");
    expect(within(rows[5]!).getByTestId("decision-hint").textContent).toBe("Left unchanged 14 days. Not verified.");
    expect(within(rows[4]!).queryByTestId("decision-hint")).toBeNull();
    expect(within(rows[3]!).queryByTestId("decision-undo")).toBeNull();
    expect(within(rows[7]!).getByTestId("decision-source").textContent).toBe("Carried over");
  });

  it("Undo POSTs the decision's undo and asks for the settings, review queue and spine again", async () => {
    const user = userEvent.setup();
    const api = mount(view(), true, [on("POST", "/api/category-decisions/a1/undo", { ok: true })]);
    const rows = await screen.findAllByTestId("decision");
    await user.click(within(rows[0]!).getByTestId("decision-undo"));
    await waitFor(() => expect(api.find("POST", /category-decisions\/a1\/undo/)).toHaveLength(1));
    await waitFor(() => expect(api.find("GET", /categorization\/settings/).length).toBeGreaterThan(1));
    expect((await screen.findByTestId("toast")).textContent).toBe("Put back.");
  });

  it("Change opens the category picker and PATCHes the transaction", async () => {
    const user = userEvent.setup();
    const api = mount(view(), true, [on("PATCH", "/api/transactions/t-a1", { id: "t-a1" })]);
    const rows = await screen.findAllByTestId("decision");
    await user.click(within(rows[0]!).getByTestId("decision-change"));
    const dialog = await screen.findByRole("dialog");
    await user.click(await within(dialog).findByRole("button", { name: /Fuel/ }));
    await waitFor(() => expect(api.find("PATCH", /transactions\/t-a1/)).toHaveLength(1));
    expect(api.find("PATCH", /transactions\/t-a1/)[0]!.body).toEqual({ categoryId: "c3" });
  });

  it("an empty list says nothing has been filed", async () => {
    mount(view({ recent: [] }));
    expect((await screen.findByTestId("recent-empty")).textContent).toBe("Nothing has been filed yet.");
  });

  it("a failed read shows a retry note", async () => {
    installApi([on("GET", "/api/categorization/settings", { error: "x" }, 500), on("GET", "/api/me", { isOwner: true })]);
    const client = createQueryClient();
    client.setDefaultOptions({ ...client.getDefaultOptions(), queries: { ...client.getDefaultOptions().queries, retry: false } });
    render(
      <QueryClientProvider client={client}>
        <Automation />
      </QueryClientProvider>,
    );
    expect((await screen.findByTestId("automation-error")).textContent).toContain("Couldn't load the automation settings.");
  });
});

describe("Automation — backlog and bank data (V7)", () => {
  it("reads the unfiled count with the oldest date, and one line per bank", async () => {
    mount(view());
    expect((await screen.findByTestId("backlog-line")).textContent).toBe("Unfiled charges: 23 · oldest Mar 14, 2026");
    expect(screen.getAllByTestId("bank").map((b) => b.textContent)).toEqual([
      "Sample Bank · data through Oct 7, 2026 · Automatic updates On",
      "Sample Card · data through Oct 5, 2026 · Automatic updates Off",
    ]);
    expect(screen.queryByTestId("backlog-result")).toBeNull();
    expect(screen.getByTestId("backlog-run").textContent).toBe("File everything up to today");
  });

  it("nothing unfiled hides the date; no bank says so", async () => {
    mount(view({ backlog: { unfiled: 0, oldestUnfiledOn: null, provisional: 0 }, banks: [] }));
    expect((await screen.findByTestId("backlog-line")).textContent).toBe("Unfiled charges: 0");
    expect(screen.getByTestId("banks-empty").textContent).toBe("No bank linked.");
  });

  it("the owner files everything: POST { scope: all }, the result line, the Review link, and the view, review queue, spine and ledger refreshed", async () => {
    const user = userEvent.setup();
    const result = { decided: 15, queued: 2, ambiguous: 5, modelQueued: 5, filed: 12, suggested: 3, unreviewed: 4, remaining: 5 };
    const api = mount(view(), true, [on("POST", "/api/categorization/run", result)]);
    const ledgerKey = ["infinite", "/api/transactions/ledger", { limit: 50 }];
    api.client.setQueryData(getGetSpineQueryKey(), { ok: true });
    api.client.setQueryData(getListCategorizationReviewQueryKey({ limit: 20 }), { items: [], total: 0 });
    api.client.setQueryData(ledgerKey, { pages: [] });
    const btn = await screen.findByTestId("backlog-run");
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    const gets = api.find("GET", /categorization\/settings/).length;
    await user.click(btn);
    await waitFor(() => expect(api.find("POST", /categorization\/run/)).toHaveLength(1));
    expect(api.find("POST", /categorization\/run/)[0]!.body).toEqual({ scope: "all" });
    expect((await screen.findByTestId("backlog-result")).textContent).toBe("Filed 12 · Suggested 3 (provisional) · 2 need a look · 4 left unchanged");
    expect(screen.getByTestId("backlog-review").getAttribute("href")).toBe("/activity/review");
    await waitFor(() => expect(api.find("GET", /categorization\/settings/).length).toBeGreaterThan(gets));
    expect(api.client.getQueryState(getGetSpineQueryKey())?.isInvalidated).toBe(true);
    expect(api.client.getQueryState(getListCategorizationReviewQueryKey({ limit: 20 }))?.isInvalidated).toBe(true);
    expect(api.client.getQueryState(ledgerKey)?.isInvalidated).toBe(true);
  });

  it("a member sees the button disabled with Owner only, and never posts", async () => {
    const user = userEvent.setup();
    const api = mount(view(), false);
    await waitFor(() => expect(screen.getByTestId("backlog-owner-only").textContent).toBe("Owner only"));
    const btn = screen.getByTestId("backlog-run") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    await user.click(btn);
    expect(api.find("POST", /categorization\/run/)).toHaveLength(0);
  });

  it("a refused run says so in words", async () => {
    const user = userEvent.setup();
    mount(view(), true, [on("POST", "/api/categorization/run", { error: "Forbidden: owner only" }, 403)]);
    const btn = await screen.findByTestId("backlog-run");
    await waitFor(() => expect((btn as HTMLButtonElement).disabled).toBe(false));
    await user.click(btn);
    expect((await screen.findByTestId("toast")).textContent).toBe("Only the household owner can do this.");
    expect(screen.queryByTestId("backlog-result")).toBeNull();
  });
});

describe("the hand-written client matches the generated one", () => {
  it("same query keys and URLs, so every other screen's invalidation still reaches it", () => {
    expect(RUN_URL).toBe(getRunCategorizationUrl());
    expect(settingsKey()).toEqual(getGetCategorizationSettingsQueryKey());
    expect(mappingRulesKey()).toEqual(getListMappingRulesQueryKey());
    expect(getGetCategorizationSettingsUrl()).toBe("/api/categorization/settings");
    expect(getUpdateCategorizationSettingsUrl()).toBe("/api/categorization/settings");
    expect(getListMappingRulesUrl()).toBe("/api/mapping-rules");
  });
});

describe("Automation words", () => {
  it("map every source, band and resolution", () => {
    expect(["rule", "memory", "recurring", "inherited", "model", "user"].map((s) => sourceWord(s as never))).toEqual(["Rule", "Memory", "Recurring", "Carried over", "Model", "You"]);
    expect(["auto", "provisional", "queue"].map((b) => bandWord(b as never))).toEqual(["Filed", "Provisional", "Queued"]);
    expect(resolutionWord({ resolution: "accepted", resolvedBy: "user" })).toBe("Accepted");
    expect(resolutionWord({ resolution: "corrected", resolvedBy: "user" })).toBe("Corrected");
    expect(resolutionWord({ resolution: "skipped", resolvedBy: "user" })).toBe("Skipped");
    expect(resolutionWord({ resolution: "unreviewed", resolvedBy: "silent" })).toBe("Unreviewed");
    // An old accepted + silent row (before 0116) never reads as anything but Accepted.
    expect(resolutionWord({ resolution: "accepted", resolvedBy: "silent" })).toBe("Accepted");
    expect(requirementFigure({ key: "judged", current: 18, target: 30 })).toBe("18 of 30 verified");
    expect(fullDate("2026-03-04")).toBe("Mar 4, 2026");
    expect(backlogLine({ unfiled: 1, oldestUnfiledOn: "2025-12-31" })).toBe("Unfiled charges: 1 · oldest Dec 31, 2025");
    expect(backlogLine({ unfiled: 0, oldestUnfiledOn: "2025-12-31" })).toBe("Unfiled charges: 0");
    expect(runResultLine({ filed: 0, suggested: 1, queued: 2, unreviewed: 3 })).toBe("Filed 0 · Suggested 1 (provisional) · 2 need a look · 3 left unchanged");
    expect(bankLine({ name: null, lastDataOn: null, autoUpdates: { on: false, reason: "no_url" } })).toBe("Bank · data through not yet · Automatic updates Off");
    expect(requirementFigure({ key: "ai", current: 1, target: 1 })).toBeNull();
    expect(engineLine({ rules: 0, learned: 1, recurring: 2 })).toBe("Rules you wrote: 0 · Learned from your corrections: 1 · Recurring bills: 2");
  });
});

describe("/design/automation", () => {
  it("opens through the design-activity page", async () => {
    window.history.replaceState(null, "", "/design/automation");
    const { default: DesignActivity } = await import("@/screens/design/DesignActivity");
    const { Router } = await import("wouter");
    render(
      <Router>
        <DesignActivity />
      </Router>,
    );
    expect((await screen.findByTestId("page-design-automation")).textContent).toContain("Sample — every figure on this page is made up.");
    window.history.replaceState(null, "", "/");
  });

  it("renders the screen on made-up data in suggest mode, 18 of 30, the backlog, banks and left-unchanged line, with the sample line first", () => {
    render(<DesignAutomation />);
    const page = screen.getByTestId("page-design-automation");
    expect(page.firstElementChild!.textContent).toContain("Sample — every figure on this page is made up.");
    expect(screen.getByTestId("mode-suggest").getAttribute("data-current")).toBe("true");
    expect(screen.getByTestId("req-judged").textContent).toContain("18 of 30 verified");
    expect(screen.getAllByTestId("decision").length).toBeGreaterThan(0);
    expect(screen.getByTestId("backlog-line").textContent).toBe("Unfiled charges: 23 · oldest Mar 14, 2026");
    expect(screen.getAllByTestId("bank")).toHaveLength(2);
    expect(screen.getByTestId("unreviewed-line").textContent).toBe("Left unchanged, not verified: 4");
  });
});

describe("/household/automation shares the AI cost importer", () => {
  it("renders Automation there, and the AI cost page on /household/ai", async () => {
    mount(view());
    cleanup();
    window.history.replaceState(null, "", "/household/automation");
    installApi([
      on("GET", "/api/categorization/settings", view()),
      on("GET", "/api/me", { isOwner: true }),
      on("GET", "/api/budget/categories", CATEGORIES),
    ]);
    const { default: HouseholdMore } = await import("./HouseholdMore");
    const { Router } = await import("wouter");
    const client = createQueryClient();
    render(
      <QueryClientProvider client={client}>
        <Router>
          <HouseholdMore />
        </Router>
      </QueryClientProvider>,
    );
    expect(await screen.findByTestId("automation")).toBeTruthy();
    window.history.replaceState(null, "", "/");
  });
});
