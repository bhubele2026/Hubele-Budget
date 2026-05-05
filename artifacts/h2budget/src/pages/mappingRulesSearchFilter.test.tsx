import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  act,
  fireEvent,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Task #281 — lock in the Mapping Rules page's search-input filter.
// The page filters by pattern, category name, and match type, and
// shows "No rules match your search." when nothing matches. There
// are sibling tests covering adjacent behavior (focus pill, restore-
// no-prompt, add-prompts-bulk) but none cover the search/filter UI
// itself. This test pins down all four behaviors so a future regression
// in the `searchQuery` / `filtered` memo can't sneak through.

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn(() => ({ dismiss: vi.fn() })) }),
}));

vi.mock("@/hooks/use-bulk-recategorize-prompt", () => ({
  useBulkRecategorizePrompt: () => ({
    offerBulkRecategorize: vi.fn(),
    previewDialog: null,
  }),
  bulkRuleFromRuleAction: vi.fn(() => null),
}));

vi.mock("wouter", async () => {
  const { defaultMappingRulesWouterMock } = await import(
    "./__test-helpers__/mapping-rules-mocks"
  );
  return defaultMappingRulesWouterMock();
});

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DragOverlay: ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  ),
  PointerSensor: class {},
  TouchSensor: class {},
  KeyboardSensor: class {},
  useSensor: () => ({}),
  useSensors: () => [],
  useDroppable: () => ({ setNodeRef: () => {}, isOver: false }),
  closestCenter: () => null,
  pointerWithin: () => [],
}));
vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
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
vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: () => "" } },
}));

vi.mock("@/components/ui/select", () => {
  return {
    Select: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    SelectTrigger: ({ children }: { children?: React.ReactNode }) => (
      <>{children}</>
    ),
    SelectContent: ({ children }: { children?: React.ReactNode }) => (
      <>{children}</>
    ),
    SelectValue: () => null,
    SelectItem: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  };
});

type MappingRule = {
  id: string;
  pattern: string;
  matchType: "contains" | "exact" | "starts_with";
  categoryId: string | null;
  priority: number;
};

const rules: MappingRule[] = [
  {
    id: "rule-1",
    pattern: "STARBUCKS",
    matchType: "contains",
    categoryId: "cat-coffee",
    priority: 100,
  },
  {
    id: "rule-2",
    pattern: "BLUE BOTTLE",
    matchType: "contains",
    categoryId: "cat-coffee",
    priority: 90,
  },
  {
    id: "rule-3",
    pattern: "SHELL OIL",
    matchType: "starts_with",
    categoryId: "cat-gas",
    priority: 80,
  },
  {
    id: "rule-4",
    pattern: "WHOLE FOODS",
    matchType: "contains",
    categoryId: "cat-grocery",
    priority: 70,
  },
];

const categories = [
  { id: "cat-coffee", name: "Coffee" },
  { id: "cat-gas", name: "Gas" },
  { id: "cat-grocery", name: "Groceries" },
];

vi.mock("@workspace/api-client-react", async () => {
  const { defaultMappingRulesApiClientMock } = await import(
    "./__test-helpers__/mapping-rules-mocks"
  );
  return defaultMappingRulesApiClientMock({
    useListMappingRules: () => ({ data: rules, isLoading: false }),
    useListCategories: () => ({ data: categories, isLoading: false }),
  });
});

import MappingRulesPage from "./mapping-rules";

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MappingRulesPage />
    </QueryClientProvider>,
  );
}

function visibleRuleIds(): string[] {
  return rules
    .map((r) => r.id)
    .filter((id) => screen.queryByTestId(`rule-row-${id}`) !== null);
}

function typeSearch(value: string) {
  const input = screen.getByTestId("input-search-rules") as HTMLInputElement;
  act(() => {
    fireEvent.change(input, { target: { value } });
  });
}

beforeEach(() => {
  renderPage();
});

afterEach(() => {
  cleanup();
});

describe("(#281) Mapping Rules — search input hides non-matching rules", () => {
  it("shows every rule when the search input is empty", () => {
    expect(visibleRuleIds()).toEqual([
      "rule-1",
      "rule-2",
      "rule-3",
      "rule-4",
    ]);
    expect(
      screen.queryByText("No rules match your search."),
    ).toBeNull();
  });

  it("narrows visible rows by pattern (case-insensitive)", () => {
    typeSearch("starbucks");
    expect(visibleRuleIds()).toEqual(["rule-1"]);
  });

  it("narrows visible rows by category name", () => {
    // "Coffee" only matches via the category name lookup — neither
    // rule-1's nor rule-2's pattern contains "coffee".
    typeSearch("coffee");
    expect(visibleRuleIds()).toEqual(["rule-1", "rule-2"]);
  });

  it("shows the empty state when nothing matches", () => {
    typeSearch("nonexistent-xyz");
    expect(visibleRuleIds()).toEqual([]);
    expect(
      screen.getByText("No rules match your search."),
    ).not.toBeNull();
  });

  it("restores the full list when the search input is cleared", () => {
    typeSearch("starbucks");
    expect(visibleRuleIds()).toEqual(["rule-1"]);

    typeSearch("");
    expect(visibleRuleIds()).toEqual([
      "rule-1",
      "rule-2",
      "rule-3",
      "rule-4",
    ]);
    expect(
      screen.queryByText("No rules match your search."),
    ).toBeNull();
  });
});
