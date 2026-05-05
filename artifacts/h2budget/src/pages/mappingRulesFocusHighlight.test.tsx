import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Task #239 — when the user lands on /mapping-rules?focus=<id1,id2,...>
// (e.g. via the "View" toast action after a Plaid sync or workbook
// import), every rule whose id is in the comma-separated list must be
// visually highlighted on render so the user can spot the matched rules
// in a long list. The Add-form scroll/data-focused contract is exercised
// here too so a future refactor can't quietly drop one piece.

type ToastCall = {
  title?: React.ReactNode;
  description?: React.ReactNode;
  duration?: number;
  action?: React.ReactNode;
};

const toastMock = vi.fn<(opts: ToastCall) => { dismiss: () => void }>(() => ({
  dismiss: vi.fn(),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

vi.mock("@/hooks/use-bulk-recategorize-prompt", () => ({
  useBulkRecategorizePrompt: () => ({
    offerBulkRecategorize: vi.fn(),
    previewDialog: null,
  }),
  bulkRuleFromRuleAction: vi.fn(() => null),
}));

// Drive the page's deep-link reader. The page calls `useSearch()` and
// parses the `focus` param out of it.
let searchString = "";
vi.mock("wouter", async () => {
  const { defaultMappingRulesWouterMock } = await import(
    "./__test-helpers__/mapping-rules-mocks"
  );
  return defaultMappingRulesWouterMock({ useSearch: () => searchString });
});

// Heavy dnd-kit pieces aren't relevant here — stub them out so the
// rendered DOM is just the rule rows.
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

type MappingRule = {
  id: string;
  pattern: string;
  matchType: "contains" | "exact" | "starts_with";
  categoryId: string | null;
  priority: number;
};

let rulesState: MappingRule[] = [];

vi.mock("@workspace/api-client-react", async () => {
  const { defaultMappingRulesApiClientMock } = await import(
    "./__test-helpers__/mapping-rules-mocks"
  );
  return defaultMappingRulesApiClientMock({
    useListMappingRules: () => ({ data: rulesState, isLoading: false }),
    useListCategories: () => ({
      data: [{ id: "cat-1", name: "Coffee" }],
      isLoading: false,
    }),
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

const scrollIntoViewMock = vi.fn();

beforeEach(() => {
  toastMock.mockClear();
  scrollIntoViewMock.mockClear();
  searchString = "";
  // jsdom doesn't implement scrollIntoView; the focus effect calls it
  // on the first matched row's HTMLDivElement after a small timeout,
  // so stub it on the prototype with a spy so we can also assert the
  // deep-link contract actively scrolls the user to the matched row.
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: scrollIntoViewMock,
    writable: true,
    configurable: true,
  });
  rulesState = [
    {
      id: "rule-a",
      pattern: "STARBUCKS",
      matchType: "contains",
      categoryId: "cat-1",
      priority: 110,
    },
    {
      id: "rule-b",
      pattern: "BLUE BOTTLE",
      matchType: "contains",
      categoryId: "cat-1",
      priority: 100,
    },
    {
      id: "rule-c",
      pattern: "PEET'S",
      matchType: "contains",
      categoryId: "cat-1",
      priority: 90,
    },
  ];
});

afterEach(() => {
  cleanup();
});

describe("(#239) Mapping Rules — ?focus=<ids> highlights matched rule rows", () => {
  it("flags every focused rule with data-focused and applies the highlight ring on render", async () => {
    searchString = "focus=rule-a,rule-b";

    renderPage();

    const rowA = await screen.findByTestId("rule-row-rule-a");
    const rowB = await screen.findByTestId("rule-row-rule-b");
    const rowC = await screen.findByTestId("rule-row-rule-c");

    // Deterministic, URL-derived flag — present on every focused row,
    // never on unfocused rows.
    expect(rowA.getAttribute("data-focused")).toBe("true");
    expect(rowB.getAttribute("data-focused")).toBe("true");
    expect(rowC.getAttribute("data-focused")).toBeNull();

    // Visual highlight (transient ring + tinted background) is applied
    // to every focused row after the focus effect runs. Wait for it so
    // the test isn't racing the effect that sets `highlightedIds`.
    await waitFor(() => {
      expect(rowA.className).toMatch(/ring-2/);
      expect(rowA.className).toMatch(/ring-blue-400/);
      expect(rowB.className).toMatch(/ring-2/);
      expect(rowB.className).toMatch(/ring-blue-400/);
    });

    // Unfocused rows must NOT receive the highlight treatment.
    expect(rowC.className).not.toMatch(/ring-blue-400/);

    // The first focused row must also be scrolled into view so users
    // landing from the toast deep-link don't have to hunt for the rules
    // in a long list.
    await waitFor(() => {
      expect(scrollIntoViewMock).toHaveBeenCalled();
    });
    const callArg = scrollIntoViewMock.mock.calls[0]?.[0];
    expect(callArg).toMatchObject({ behavior: "smooth", block: "center" });
  });

  it("ignores unknown focus ids and does not highlight unrelated rows", async () => {
    searchString = "focus=does-not-exist";

    renderPage();

    const rowA = await screen.findByTestId("rule-row-rule-a");
    const rowB = await screen.findByTestId("rule-row-rule-b");
    const rowC = await screen.findByTestId("rule-row-rule-c");

    // `data-focused` mirrors membership in the URL list, regardless of
    // whether the id matches a real rule — but no row in our fixture
    // has the id "does-not-exist", so none should be flagged.
    expect(rowA.getAttribute("data-focused")).toBeNull();
    expect(rowB.getAttribute("data-focused")).toBeNull();
    expect(rowC.getAttribute("data-focused")).toBeNull();

    // None of the rows pick up the blue highlight ring either.
    expect(rowA.className).not.toMatch(/ring-blue-400/);
    expect(rowB.className).not.toMatch(/ring-blue-400/);
    expect(rowC.className).not.toMatch(/ring-blue-400/);
  });
});
