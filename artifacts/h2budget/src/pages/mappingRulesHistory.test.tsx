import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// (WP5b) The rule audit trail on the Mapping Rules page.
//
// Pinned:
// 1. "edited <date>" shows on a rule the server says was edited
//    (`updatedAt`), on the HOUSEHOLD calendar (not the device's zone), and on
//    no other rule;
// 2. the History popover asks for nothing while closed, asks afresh for THAT
//    rule when opened, and reads the history in words: who (you / another
//    household member / H2's starter rules), what changed (before → after,
//    category names, a deleted category named as such) and the note;
// 3. empty, failed and capped histories say so;
// 4. the edit row's optional "why" travels as the PATCH `note`, and only when
//    filled in.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ?? ResizeObserverStub;

const toastMock = vi.fn(() => ({ dismiss: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

vi.mock("@/hooks/use-bulk-recategorize-prompt", () => ({
  useBulkRecategorizePrompt: () => ({ offerBulkRecategorize: vi.fn(), previewDialog: null }),
  bulkRuleFromRuleAction: vi.fn(() => null),
}));

vi.mock("wouter", async () => {
  const { defaultMappingRulesWouterMock } = await import("./__test-helpers__/mapping-rules-mocks");
  return defaultMappingRulesWouterMock();
});

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DragOverlay: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  PointerSensor: class {},
  TouchSensor: class {},
  KeyboardSensor: class {},
  useSensor: () => ({}),
  useSensors: (...s: unknown[]) => s,
  useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
  closestCenter: () => [],
  pointerWithin: () => [],
}));
vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    setActivatorNodeRef: () => {},
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
  arrayMove: <T,>(arr: T[]) => arr,
  verticalListSortingStrategy: null,
  sortableKeyboardCoordinates: () => null,
}));
vi.mock("@dnd-kit/utilities", () => ({ CSS: { Transform: { toString: () => "" } } }));

type Rule = {
  id: string;
  pattern: string;
  matchType: string;
  categoryId: string | null;
  priority: number;
  updatedAt?: string | null;
};

const RULES: Rule[] = [
  // 03:30 UTC on Oct 13 is still Oct 12 on the household's (Chicago) calendar.
  { id: "r-edited", pattern: "EXACT SCIENCES", matchType: "contains", categoryId: "cat-pay", priority: 50, updatedAt: "2026-10-13T03:30:00.000Z" },
  { id: "r-plain", pattern: "KROGER", matchType: "contains", categoryId: "cat-dining", priority: 20, updatedAt: null },
];
const CATEGORIES = [
  { id: "cat-pay", name: "Paycheck" },
  { id: "cat-dining", name: "Dining & Coffee" },
];

const updateMutate = vi.fn();
const historyCalls: Array<{ id: string; opts: { query?: { staleTime?: number; queryKey?: unknown } } }> = [];
let historyResult: Record<string, unknown> = {};
const refetch = vi.fn();

vi.mock("@workspace/api-client-react/features", async () => {
  const { defaultMappingRulesFeaturesMock } = await import("./__test-helpers__/mapping-rules-mocks");
  return defaultMappingRulesFeaturesMock({
    useGetMappingRuleHistory: (id: string, opts: { query?: { staleTime?: number } }) => {
      historyCalls.push({ id, opts });
      return { refetch, isFetching: false, isLoadingError: false, isRefetchError: false, ...historyResult };
    },
  });
});

vi.mock("@workspace/api-client-react", async () => {
  const { defaultMappingRulesApiClientMock } = await import("./__test-helpers__/mapping-rules-mocks");
  return defaultMappingRulesApiClientMock({
    useListMappingRules: () => ({ data: RULES, isLoading: false }),
    useListCategories: () => ({ data: CATEGORIES, isLoading: false }),
    useUpdateMappingRule: () => ({ mutate: updateMutate, isPending: false }),
  });
});

vi.mock("@/components/page-skeleton", () => ({
  PageSkeleton: () => <div data-testid="page-skeleton" />,
}));

import MappingRulesPage from "./mapping-rules";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MappingRulesPage />
    </QueryClientProvider>,
  );
}

const ENTRY = (over: Record<string, unknown>) => ({
  id: `h-${Math.random().toString(36).slice(2)}`,
  ruleId: "r-edited",
  action: "updated",
  actor: "user_other",
  actorKind: "person",
  byYou: false,
  previous: null,
  next: null,
  note: null,
  createdAt: "2026-10-13T17:00:00.000Z",
  ...over,
});

const SNAP = { pattern: "EXACT SCIENCES", matchType: "contains", priority: 50 };

beforeEach(() => {
  // Dates in a history read without the year when it is this year.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T17:00:00.000Z"));
  updateMutate.mockClear();
  refetch.mockClear();
  historyCalls.length = 0;
  historyResult = { data: { ruleId: "r-edited", entries: [], truncated: false } };
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("(WP5b) edited <date>", () => {
  it("shows the last edit on the household calendar, and only on an edited rule", () => {
    renderPage();
    expect(screen.getByTestId("rule-edited-r-edited").textContent).toBe("edited Oct 12");
    expect(screen.queryByTestId("rule-edited-r-plain")).toBeNull();
  });
});

describe("(WP5b) the History popover", () => {
  it("asks for nothing while closed, then asks afresh for that rule when opened", () => {
    renderPage();
    expect(historyCalls).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "History of rule EXACT SCIENCES" }));
    expect(historyCalls.length).toBeGreaterThan(0);
    expect(historyCalls.every((c) => c.id === "r-edited")).toBe(true);
    expect(historyCalls[0]!.opts.query?.staleTime).toBe(0);
    expect(historyCalls[0]!.opts.query?.queryKey).toEqual(["/api/mapping-rules/r-edited/history"]);
  });

  it("reads the history in words: who, what changed, and why", () => {
    historyResult = {
      data: {
        ruleId: "r-edited",
        truncated: false,
        entries: [
          ENTRY({
            action: "updated",
            actorKind: "person",
            byYou: true,
            previous: { ...SNAP, categoryId: "cat-dining" },
            next: { ...SNAP, categoryId: "cat-pay" },
            note: "Back to the paycheck.",
          }),
          ENTRY({
            action: "reordered",
            actorKind: "person",
            byYou: false,
            previous: { ...SNAP, categoryId: "cat-dining", priority: 40 },
            next: { ...SNAP, categoryId: "cat-dining", priority: 50 },
            createdAt: "2026-10-01T17:00:00.000Z",
          }),
          ENTRY({
            action: "updated",
            actor: "script:recategorize",
            actorKind: "script",
            previous: { ...SNAP, categoryId: "cat-gone" },
            next: { ...SNAP, categoryId: "cat-dining" },
            createdAt: "2026-09-20T17:00:00.000Z",
          }),
          ENTRY({
            action: "seeded",
            actor: "seed",
            actorKind: "seed",
            next: { ...SNAP, categoryId: "cat-gone" },
            createdAt: "2026-09-03T17:00:00.000Z",
          }),
        ],
      },
    };
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "History of rule EXACT SCIENCES" }));
    const pop = screen.getByTestId("rule-history-r-edited");
    const items = within(pop).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual([
      "Oct 13 · Edited by youCategory: Dining & Coffee → Paycheck“Back to the paycheck.”",
      "Oct 1 · Moved in the order by another household memberPriority: 40 → 50",
      "Sep 20 · Edited by a maintenance scriptCategory: a deleted category → Dining & Coffee",
      "Sep 3 · Added by H2's starter rulesEXACT SCIENCES · contains → a deleted category · priority 50",
    ]);
    expect(screen.queryByTestId("rule-history-truncated")).toBeNull();
  });

  it("names a delete by the rule it removed, and says when the list is capped", () => {
    historyResult = {
      data: {
        ruleId: "r-edited",
        truncated: true,
        entries: [
          ENTRY({
            action: "deleted",
            actor: "system",
            actorKind: "system",
            previous: { pattern: "EXACT SCIENCES", matchType: "starts_with", categoryId: null, priority: 7 },
          }),
        ],
      },
    };
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "History of rule EXACT SCIENCES" }));
    const pop = screen.getByTestId("rule-history-r-edited");
    expect(within(pop).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Oct 13 · Deleted by H2Was: EXACT SCIENCES · starts with → Uncategorized · priority 7",
    ]);
    expect(within(pop).getByTestId("rule-history-truncated").textContent).toBe("Showing the newest 1 change.");
  });

  it("an empty history says so; a failed one says so and retries", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "History of rule EXACT SCIENCES" }));
    expect(screen.getByTestId("rule-history-empty").textContent).toBe(
      "No changes recorded for this rule since its history began.",
    );
    cleanup();

    historyResult = { data: undefined, isLoadingError: true };
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "History of rule EXACT SCIENCES" }));
    const failed = screen.getByTestId("rule-history-failed");
    expect(failed.textContent).toContain("Couldn't load the history.");
    fireEvent.click(within(failed).getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("while the first answer is on its way it says Loading…, never an empty history", () => {
    historyResult = { data: undefined, isFetching: true };
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "History of rule EXACT SCIENCES" }));
    const pop = screen.getByTestId("rule-history-r-edited");
    expect(pop.textContent).toContain("Loading…");
    expect(screen.queryByTestId("rule-history-empty")).toBeNull();
  });
});

describe("(WP5b) the edit row's optional why", () => {
  it("sends a filled-in why as the PATCH note, trimmed", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("rule-edit-btn-r-edited"));
    fireEvent.change(screen.getByTestId("rule-edit-note-r-edited"), {
      target: { value: "  The old hand-filing flow had moved it.  " },
    });
    fireEvent.click(screen.getByTestId("rule-save-r-edited"));
    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0]![0]).toEqual({
      id: "r-edited",
      data: {
        pattern: "EXACT SCIENCES",
        matchType: "contains",
        categoryId: "cat-pay",
        priority: 50,
        note: "The old hand-filing flow had moved it.",
      },
    });
  });

  it("sends no note at all when the why is left empty (or blank)", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("rule-edit-btn-r-plain"));
    fireEvent.change(screen.getByTestId("rule-edit-note-r-plain"), { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("rule-save-r-plain"));
    expect(updateMutate.mock.calls[0]![0].data).not.toHaveProperty("note");
  });

  it("starts empty on every edit", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("rule-edit-btn-r-edited"));
    fireEvent.change(screen.getByTestId("rule-edit-note-r-edited"), { target: { value: "draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel editing rule" }));
    fireEvent.click(screen.getByTestId("rule-edit-btn-r-edited"));
    expect((screen.getByTestId("rule-edit-note-r-edited") as HTMLInputElement).value).toBe("");
  });
});
