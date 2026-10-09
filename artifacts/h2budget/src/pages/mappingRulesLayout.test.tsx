import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, within, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// (C7) Mapping rules on the "H2 evolved" grid. Two things are pinned here:
//
// 1. THE COMPOSITION THE DRAG-AND-DROP NEEDS (parity review §8 C7): one
//    DndContext holds the bulk bar, the category drop strip, every category
//    card and the DragOverlay; that panel is sticky-safe and static; and nothing
//    from the DndContext up to the page root carries an entrance animation (a
//    transform on an ancestor moves the fixed-position DragOverlay away from
//    the pointer).
// 2. THE CAPABILITIES THAT HAD NO CLIENT TEST (§2.13): test a description
//    (MR-14), drag-reorder within a card (MR-22), up/down (MR-23), priority on
//    the row (MR-24), drop on a category chip (MR-25), the sensors and the
//    collision rule (MR-26), the "Show only these" toggle (MR-28), plus the
//    card order, collapse persistence, select-all/clear and the empty and cold
//    states the restyle moved.

const toastMock = vi.fn(() => ({ dismiss: vi.fn() }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: toastMock }) }));

vi.mock("@/hooks/use-bulk-recategorize-prompt", () => ({
  useBulkRecategorizePrompt: () => ({ offerBulkRecategorize: vi.fn(), previewDialog: null }),
  bulkRuleFromRuleAction: vi.fn(() => null),
}));

let searchString = "";
vi.mock("wouter", async () => {
  const { defaultMappingRulesWouterMock } = await import("./__test-helpers__/mapping-rules-mocks");
  return defaultMappingRulesWouterMock({ useSearch: () => searchString });
});

// dnd-kit, recorded: the DndContext renders a marked wrapper and keeps its
// props so a test can drive onDragEnd the way a real drop would.
type DndProps = {
  children: React.ReactNode;
  onDragEnd: (e: { active: { id: string }; over: { id: string } | null }) => void;
  onDragStart: (e: { active: { id: string } }) => void;
  collisionDetection: (args: unknown) => unknown;
};
const dnd: { props: DndProps | null; contexts: number; sensorCalls: Array<[unknown, unknown]> } = {
  props: null,
  contexts: 0,
  sensorCalls: [],
};
const pointerWithinMock = vi.fn((_args: unknown): unknown[] => []);
const closestCenterMock = vi.fn((_args: unknown): unknown[] => [{ id: "closest" }]);
// Hoisted with the mock factory below, which hands these classes out by value.
const { PointerSensor, TouchSensor, KeyboardSensor } = vi.hoisted(() => ({
  PointerSensor: class PointerSensor {},
  TouchSensor: class TouchSensor {},
  KeyboardSensor: class KeyboardSensor {},
}));
vi.mock("@dnd-kit/core", () => ({
  DndContext: (props: DndProps) => {
    dnd.props = props;
    return <div data-testid="dnd-context">{props.children}</div>;
  },
  DragOverlay: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="drag-overlay-slot">{children}</div>
  ),
  PointerSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor: (sensor: unknown, options: unknown) => {
    dnd.sensorCalls.push([sensor, options]);
    return {};
  },
  useSensors: (...s: unknown[]) => s,
  useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
  closestCenter: (args: unknown) => closestCenterMock(args),
  pointerWithin: (args: unknown) => pointerWithinMock(args),
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
  arrayMove: <T,>(arr: T[], from: number, to: number): T[] => {
    const next = arr.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved as T);
    return next;
  },
  verticalListSortingStrategy: null,
  sortableKeyboardCoordinates: () => null,
}));
vi.mock("@dnd-kit/utilities", () => ({ CSS: { Transform: { toString: () => "" } } }));

type Rule = {
  id: string;
  pattern: string;
  matchType: "contains" | "exact" | "starts_with";
  categoryId: string | null;
  priority: number;
};

const BASE_RULES: Rule[] = [
  { id: "a", pattern: "STARBUCKS", matchType: "contains", categoryId: "cat-coffee", priority: 30 },
  { id: "d", pattern: "KROGER", matchType: "contains", categoryId: "cat-grocery", priority: 25 },
  { id: "b", pattern: "PEETS", matchType: "starts_with", categoryId: "cat-coffee", priority: 20 },
  { id: "c", pattern: "DUNKIN", matchType: "exact", categoryId: "cat-coffee", priority: 10 },
  { id: "u", pattern: "MYSTERY", matchType: "contains", categoryId: null, priority: 5 },
];
const CATEGORIES = [
  { id: "cat-grocery", name: "Groceries" },
  { id: "cat-coffee", name: "Coffee" },
  { id: "cat-none", name: "Uncategorized", excludeFromBudget: true },
];

let rulesState: Rule[] | undefined = BASE_RULES;
let rulesLoading = false;
const reorderMutate = vi.fn();
const updateMutate = vi.fn();
const testMutate = vi.fn();
const testReset = vi.fn();
let testData: unknown = undefined;

vi.mock("@workspace/api-client-react/features", async () => {
  const { defaultMappingRulesFeaturesMock } = await import("./__test-helpers__/mapping-rules-mocks");
  return defaultMappingRulesFeaturesMock();
});

vi.mock("@workspace/api-client-react", async () => {
  const { defaultMappingRulesApiClientMock } = await import("./__test-helpers__/mapping-rules-mocks");
  return defaultMappingRulesApiClientMock({
    useListMappingRules: () => ({ data: rulesState, isLoading: rulesLoading }),
    useListCategories: () => ({ data: CATEGORIES, isLoading: false }),
    useReorderMappingRules: () => ({ mutate: reorderMutate, isPending: false }),
    useUpdateMappingRule: () => ({ mutate: updateMutate, isPending: false }),
    useTestMappingRules: () => ({ mutate: testMutate, reset: testReset, data: testData, isPending: false }),
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

const ENTRANCE = /\b(tile-in|rise-in|reveal|stagger|stagger-children|page-in|chart-in|section-enter|sweep-in|spark-fill-in|grow-x)\b/;

beforeEach(() => {
  rulesState = BASE_RULES;
  rulesLoading = false;
  testData = undefined;
  searchString = "";
  dnd.props = null;
  dnd.sensorCalls = [];
  reorderMutate.mockClear();
  updateMutate.mockClear();
  testMutate.mockClear();
  testReset.mockClear();
  pointerWithinMock.mockClear();
  closestCenterMock.mockClear();
  window.localStorage.clear();
});
afterEach(() => cleanup());

describe("(C7) Mapping rules — composition", () => {
  it("lays the page out as Add (8) + Test (4), the filter row, the rules panel and the learned panel, on one grid", () => {
    renderPage();
    const grid = screen.getByTestId("panel-add-rule").parentElement!;
    expect(grid.className).toContain("grid-12");
    const order = Array.from(grid.children).map(
      (el) => (el as HTMLElement).dataset.testid,
    );
    expect(order).toEqual([
      "panel-add-rule",
      "panel-test-description",
      "rules-filter-row",
      "panel-rules",
      "learned-rules-panel",
    ]);
    expect(screen.getByTestId("panel-add-rule").className).toContain("span-8");
    expect(screen.getByTestId("panel-test-description").className).toContain("span-4");
    expect(screen.getByTestId("rules-filter-row").className).toContain("span-12");
    expect(screen.getByTestId("panel-rules").className).toContain("span-12");
    expect(screen.getByTestId("learned-rules-panel").className).toContain("span-12");
    // No panel here is a destination: none lifts on hover.
    for (const id of ["panel-add-rule", "panel-test-description", "panel-rules", "learned-rules-panel"]) {
      expect(screen.getByTestId(id).className).not.toContain("panel-link");
    }
  });

  it("keeps ONE DndContext around the bulk bar, the drop strip, every card and the DragOverlay", () => {
    renderPage();
    const contexts = screen.getAllByTestId("dnd-context");
    expect(contexts).toHaveLength(1);
    const ctx = contexts[0]!;
    expect(within(ctx).getByTestId("rule-bulk-bar")).toBeTruthy();
    expect(within(ctx).getByTestId("category-drop-strip")).toBeTruthy();
    expect(within(ctx).getByTestId("rule-category-cards")).toBeTruthy();
    for (const key of ["cat-coffee", "cat-grocery", "__uncategorized__"]) {
      expect(within(ctx).getByTestId(`rule-category-card-${key}`)).toBeTruthy();
    }
    expect(within(ctx).getByTestId("drag-overlay-slot")).toBeTruthy();
    // The context sits inside the rules panel, which clips without becoming a
    // scroll container (sticky-safe) and never lifts (static).
    const panel = screen.getByTestId("panel-rules");
    expect(panel.contains(ctx)).toBe(true);
    expect(panel.className).toContain("panel-sticky-safe");
  });

  it("puts no entrance animation, transform, filter or containment between the DragOverlay and the page root", () => {
    const { container } = renderPage();
    let el: HTMLElement | null = screen.getByTestId("drag-overlay-slot");
    while (el && el !== container) {
      expect(el.className, el.dataset.testid ?? el.tagName).not.toMatch(ENTRANCE);
      expect(el.style.transform).toBe("");
      expect(el.style.filter).toBe("");
      expect(el.style.contain).toBe("");
      expect(el.className).not.toMatch(/@container|\bcontain-/);
      el = el.parentElement;
    }
    // The cards wrapper is viewport-responsive, never a container query.
    expect(screen.getByTestId("rule-category-cards").className).not.toMatch(/@container/);
  });

  it("has exactly one heading that names the page (the e2e specs wait on it in strict mode)", () => {
    renderPage();
    const named = screen.getAllByRole("heading", { name: /mapping rules/i });
    expect(named).toHaveLength(1);
    expect(named[0]!.tagName).toBe("H1");
  });

  it("cards run A→Z with Uncategorized last; the strip hides excludeFromBudget categories (MR-01, MR-16)", () => {
    renderPage();
    const cards = Array.from(screen.getByTestId("rule-category-cards").children).map(
      (el) => (el as HTMLElement).dataset.testid,
    );
    expect(cards).toEqual([
      "rule-category-card-cat-coffee",
      "rule-category-card-cat-grocery",
      "rule-category-card-__uncategorized__",
    ]);
    expect(screen.getByTestId("category-drop-cat-coffee")).toBeTruthy();
    expect(screen.queryByTestId("category-drop-cat-none")).toBeNull();
    // Within a card the highest priority is first, and each row shows it (MR-24).
    const coffee = within(screen.getByTestId("rule-category-card-list-cat-coffee"));
    expect(coffee.getAllByTestId(/^rule-row-/).map((r) => r.dataset.testid)).toEqual([
      "rule-row-a",
      "rule-row-b",
      "rule-row-c",
    ]);
    expect(screen.getByTestId("rule-priority-a").textContent).toBe("30");
    expect(screen.getByTestId("rule-count").textContent).toContain("5 total");
  });

  it("cold load shows the skeleton; no rules shows the empty note in the rules panel (MR-02)", () => {
    rulesState = undefined;
    rulesLoading = true;
    renderPage();
    expect(screen.getByTestId("page-skeleton")).toBeTruthy();
    cleanup();

    rulesState = [];
    rulesLoading = false;
    renderPage();
    expect(within(screen.getByTestId("panel-rules")).getByText(/No rules yet/)).toBeTruthy();
    expect(screen.queryByTestId("dnd-context")).toBeNull();
    // Search and the learned panel still render.
    expect(screen.getByTestId("input-search-rules")).toBeTruthy();
    expect(screen.getByTestId("learned-rules-panel")).toBeTruthy();
  });
});

describe("(C7) Mapping rules — capabilities with no client test before", () => {
  it("MR-14: Test runs on Enter and on the button, shows the winner and marks Winner / Match rows; Clear resets", () => {
    renderPage();
    const box = screen.getByTestId("input-test-description");
    fireEvent.change(box, { target: { value: "STARBUCKS 4471" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(testMutate).toHaveBeenCalledWith({ data: { description: "STARBUCKS 4471" } });
    fireEvent.click(screen.getByTestId("btn-run-test"));
    expect(testMutate).toHaveBeenCalledTimes(2);
    cleanup();

    testData = {
      matches: [
        { rule: BASE_RULES[0], winner: true },
        { rule: BASE_RULES[2], winner: false },
      ],
      winningCategoryId: "cat-coffee",
    };
    renderPage();
    expect(screen.getByTestId("test-result").textContent).toBe("2 matching rules. Winner: Coffee.");
    expect(within(screen.getByTestId("rule-row-a")).getByText("Winner")).toBeTruthy();
    expect(within(screen.getByTestId("rule-row-b")).getByText("Match")).toBeTruthy();
    expect(within(screen.getByTestId("rule-row-c")).queryByText(/Winner|Match/)).toBeNull();
    fireEvent.click(screen.getByTestId("btn-clear-test"));
    expect(testReset).toHaveBeenCalledTimes(1);
  });

  it("MR-23: up/down move a rule one slot inside its card and leave other cards' slots alone", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("rule-up-b"));
    // Global order a, d, b, c, u → b takes a's slot; d (another card) stays put.
    expect(reorderMutate).toHaveBeenLastCalledWith({ data: { orderedIds: ["b", "d", "a", "c", "u"] } });
    fireEvent.click(screen.getByTestId("rule-down-b"));
    expect(reorderMutate).toHaveBeenLastCalledWith({ data: { orderedIds: ["a", "d", "c", "b", "u"] } });
    expect((screen.getByTestId("rule-up-a") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("rule-down-c") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("rule-up-d") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("rule-down-d") as HTMLButtonElement).disabled).toBe(true);
  });

  it("MR-22: a drop on a row of the same card reorders; a drop on another card's row does nothing", () => {
    renderPage();
    act(() => dnd.props!.onDragStart({ active: { id: "a" } }));
    expect(screen.getByTestId("rule-drag-overlay").textContent).toContain("STARBUCKS");
    act(() => dnd.props!.onDragEnd({ active: { id: "a" }, over: { id: "c" } }));
    expect(reorderMutate).toHaveBeenCalledWith({ data: { orderedIds: ["b", "d", "c", "a", "u"] } });
    expect(screen.queryByTestId("rule-drag-overlay")).toBeNull();

    reorderMutate.mockClear();
    act(() => dnd.props!.onDragEnd({ active: { id: "a" }, over: { id: "d" } }));
    act(() => dnd.props!.onDragEnd({ active: { id: "a" }, over: null }));
    act(() => dnd.props!.onDragEnd({ active: { id: "a" }, over: { id: "a" } }));
    expect(reorderMutate).not.toHaveBeenCalled();
  });

  it("MR-25: a drop on a category chip PATCHes the full rule with the new category; its own category is a no-op", () => {
    renderPage();
    act(() => dnd.props!.onDragEnd({ active: { id: "d" }, over: { id: "category:cat-coffee" } }));
    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(updateMutate.mock.calls[0]![0]).toEqual({
      id: "d",
      data: { pattern: "KROGER", matchType: "contains", categoryId: "cat-coffee", priority: 25 },
    });
    act(() => dnd.props!.onDragEnd({ active: { id: "a" }, over: { id: "category:cat-coffee" } }));
    expect(updateMutate).toHaveBeenCalledTimes(1);
    expect(reorderMutate).not.toHaveBeenCalled();
  });

  it("MR-26: pointer (4 px), touch (200 ms / 8 px) and keyboard sensors; the pointer's own target wins, else the closest", () => {
    renderPage();
    const byClass = new Map(dnd.sensorCalls.map(([s, o]) => [s, o]));
    expect(byClass.get(PointerSensor)).toEqual({ activationConstraint: { distance: 4 } });
    expect(byClass.get(TouchSensor)).toEqual({ activationConstraint: { delay: 200, tolerance: 8 } });
    expect(byClass.get(KeyboardSensor)).toEqual({ coordinateGetter: expect.any(Function) });

    pointerWithinMock.mockReturnValueOnce([{ id: "category:cat-grocery" }]);
    expect(dnd.props!.collisionDetection({})).toEqual([{ id: "category:cat-grocery" }]);
    expect(closestCenterMock).not.toHaveBeenCalled();
    expect(dnd.props!.collisionDetection({})).toEqual([{ id: "closest" }]);
    expect(closestCenterMock).toHaveBeenCalledTimes(1);
  });

  it("drag handles switch off while a search hides rules", () => {
    renderPage();
    expect((screen.getByTestId("rule-drag-a") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByTestId("input-search-rules"), { target: { value: "bucks" } });
    expect((screen.getByTestId("rule-drag-a") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("rule-count").textContent).toContain("· 1 shown");
  });

  it("MR-28: 'Show only these' narrows to the rules the sync matched and 'Show all rules' brings the rest back", () => {
    searchString = "focus=a,d";
    renderPage();
    expect(screen.getByTestId("focus-pill-count").textContent).toBe("2");
    fireEvent.click(screen.getByTestId("focus-pill-toggle"));
    expect(screen.getByTestId("focus-pill-toggle").textContent).toBe("Show all rules");
    expect(screen.queryByTestId("rule-row-b")).toBeNull();
    expect(screen.getByTestId("rule-row-a")).toBeTruthy();
    expect(screen.getByTestId("rule-row-d")).toBeTruthy();
    fireEvent.click(screen.getByTestId("focus-pill-toggle"));
    expect(screen.getByTestId("rule-row-b")).toBeTruthy();
  });

  it("MR-17: collapsing a card persists; Collapse all / Expand all flips every card", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("rule-category-card-toggle-cat-coffee"));
    expect(screen.getByTestId("rule-category-card-cat-coffee").dataset.collapsed).toBe("true");
    expect(screen.queryByTestId("rule-category-card-list-cat-coffee")).toBeNull();
    expect(
      JSON.parse(window.localStorage.getItem("h2budget:mappingRules:collapsedCategories")!),
    ).toEqual(["cat-coffee"]);
    const all = screen.getByTestId("rule-collapse-all");
    expect(all.textContent).toBe("Collapse all");
    fireEvent.click(all);
    expect(all.textContent).toBe("Expand all");
    expect(screen.queryByTestId("rule-category-card-list-cat-grocery")).toBeNull();
    fireEvent.click(all);
    expect(screen.getByTestId("rule-category-card-list-cat-coffee")).toBeTruthy();
  });

  it("MR-18 / MR-21: select all ticks every visible rule and Clear empties the selection", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("rule-select-all"));
    for (const id of ["a", "b", "c", "d", "u"]) {
      expect(screen.getByTestId(`rule-row-${id}`).dataset.selected).toBe("true");
    }
    expect(screen.getByTestId("rule-bulk-delete").textContent).toContain("Delete selected (5)");
    fireEvent.click(screen.getByTestId("rule-bulk-clear"));
    expect(screen.getByTestId("rule-row-a").dataset.selected).toBeUndefined();
    expect(screen.queryByTestId("rule-bulk-delete")).toBeNull();
  });
});
