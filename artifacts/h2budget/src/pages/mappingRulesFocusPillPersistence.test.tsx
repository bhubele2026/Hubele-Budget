import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

// Task #244 — the focus pill on Mapping Rules used to be component-state
// only, so a reload (or a second click on the post-sync toast's "View"
// link) re-showed it for batches the user had already audited. We now
// persist the dismissal in localStorage keyed by the sorted focus ids
// so the same batch stays dismissed across reloads, while a *different*
// combination of ids still surfaces a fresh pill.

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

// Dynamic search/navigate so individual tests can vary the focus param.
let mockSearch = "";
const navigateMock = vi.fn();
vi.mock("wouter", async () => {
  const { defaultMappingRulesWouterMock } = await import(
    "./__test-helpers__/mapping-rules-mocks"
  );
  return defaultMappingRulesWouterMock({
    useSearch: () => mockSearch,
    useLocation: () => ["/mapping-rules", navigateMock] as const,
  });
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

type MappingRule = {
  id: string;
  pattern: string;
  matchType: "contains" | "exact" | "starts_with";
  categoryId: string | null;
  priority: number;
};

const rulesState: MappingRule[] = [
  {
    id: "rule-a",
    pattern: "STARBUCKS",
    matchType: "contains",
    categoryId: "cat-1",
    priority: 110,
  },
  {
    id: "rule-b",
    pattern: "AMAZON",
    matchType: "contains",
    categoryId: "cat-1",
    priority: 100,
  },
  {
    id: "rule-c",
    pattern: "UBER",
    matchType: "contains",
    categoryId: "cat-1",
    priority: 90,
  },
];

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

const STORAGE_KEY = "h2budget:mappingRules:dismissedFocusBatches";

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

beforeEach(() => {
  window.localStorage.clear();
  navigateMock.mockReset();
  mockSearch = "";
  // jsdom doesn't implement Element.prototype.scrollIntoView; the
  // focus-highlight effect on the page calls it via setTimeout after
  // matching a focused row, and the resulting unhandled exception
  // would fail the test even though our assertions pass. Stub it.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
});

afterEach(() => {
  cleanup();
});

describe("(#244) Mapping Rules — focus pill dismissal persists across reloads", () => {
  it("dismissing the pill writes the sorted batch key to localStorage", async () => {
    mockSearch = "focus=rule-b,rule-a";
    renderPage();

    const pill = await screen.findByTestId("focus-pill");
    expect(pill).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByTestId("focus-pill-dismiss"));
    });

    const raw = window.localStorage.getItem(STORAGE_KEY);
    expect(raw).toBeTruthy();
    const stored = JSON.parse(raw!) as string[];
    // Sorted so URL order can't matter.
    expect(stored).toEqual(["rule-a,rule-b"]);
  });

  it("re-mounting with the same focus ids keeps the pill dismissed", async () => {
    // Pre-seed localStorage as if the user had previously dismissed
    // this exact batch.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(["rule-a,rule-b"]),
    );
    // URL ids are intentionally in a different order than the stored
    // key — the sorted hash must still match.
    mockSearch = "focus=rule-b,rule-a";

    renderPage();

    // Wait a tick to let any effects flush.
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByTestId("focus-pill")).toBeNull();
  });

  it("a different combination of focus ids still shows the pill", async () => {
    // User previously audited the (rule-a, rule-b) batch.
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(["rule-a,rule-b"]),
    );
    // A genuinely new sync surfaces a different combination.
    mockSearch = "focus=rule-a,rule-c";

    renderPage();

    expect(await screen.findByTestId("focus-pill")).toBeTruthy();
  });
});
