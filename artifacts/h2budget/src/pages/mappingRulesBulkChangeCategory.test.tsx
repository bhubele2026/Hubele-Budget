import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  act,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { isValidElement } from "react";

// Task #231 — selecting multiple mapping rules and picking a category
// from the bulk-action bar's "Change category" control must:
//   * call updateMappingRule once per selected rule that isn't
//     already pointed at the chosen category, with that category
//     swapped in,
//   * surface a single "Updated N rules → <category>" toast with
//     an Undo affordance,
//   * clear the selection,
//   * and, when Undo is clicked, restore each rule's prior
//     categoryId in one go.

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

vi.mock("wouter", () => ({
  useSearch: () => "",
  useLocation: () => ["/mapping-rules", vi.fn()],
}));

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

// Replace the Radix-based shadcn Select with a tiny native <select>
// shim so we can drive the bulk-category dropdown with a plain
// `change` event in jsdom (the Radix popover is awkward to drive
// from a test). The shim preserves the page's `value` /
// `onValueChange` contract.
vi.mock("@/components/ui/select", () => {
  type SelectProps = {
    value?: string;
    onValueChange?: (v: string) => void;
    disabled?: boolean;
    children?: React.ReactNode;
  };
  function flattenItems(node: React.ReactNode): React.ReactElement[] {
    const out: React.ReactElement[] = [];
    React.Children.forEach(node, (child) => {
      if (!React.isValidElement(child)) return;
      const props = child.props as {
        value?: string;
        children?: React.ReactNode;
        ["data-testid"]?: string;
      };
      if (typeof props.value === "string") {
        out.push(child);
      } else if (props.children !== undefined) {
        out.push(...flattenItems(props.children));
      }
    });
    return out;
  }
  function findTestId(node: React.ReactNode): string | undefined {
    let found: string | undefined;
    React.Children.forEach(node, (child) => {
      if (found) return;
      if (!React.isValidElement(child)) return;
      const props = child.props as {
        ["data-testid"]?: string;
        children?: React.ReactNode;
      };
      if (props["data-testid"]) {
        found = props["data-testid"];
        return;
      }
      if (props.children !== undefined) {
        found = findTestId(props.children);
      }
    });
    return found;
  }
  return {
    Select: ({ value, onValueChange, disabled, children }: SelectProps) => {
      const items = flattenItems(children);
      const triggerTestId = findTestId(children);
      return (
        <select
          data-testid={triggerTestId ?? "mock-select"}
          value={value ?? ""}
          disabled={disabled}
          onChange={(e) => onValueChange?.(e.target.value)}
        >
          <option value="" disabled>
            Select…
          </option>
          {items.map((item) => {
            const p = item.props as {
              value: string;
              children?: React.ReactNode;
            };
            return (
              <option key={p.value} value={p.value}>
                {typeof p.children === "string" ? p.children : p.value}
              </option>
            );
          })}
        </select>
      );
    },
    SelectTrigger: ({ children }: { children?: React.ReactNode }) => (
      <>{children}</>
    ),
    SelectContent: ({ children }: { children?: React.ReactNode }) => (
      <>{children}</>
    ),
    SelectValue: () => null,
    SelectItem: ({
      value,
      children,
    }: {
      value: string;
      children?: React.ReactNode;
    }) => <option value={value}>{children}</option>,
  };
});

type MappingRule = {
  id: string;
  pattern: string;
  matchType: "contains" | "exact" | "starts_with";
  categoryId: string | null;
  priority: number;
};

let rulesState: MappingRule[] = [];
// `vi.mock` factories are hoisted, so we can't close over a top-level
// `updateMappingRuleMock` variable directly — Vitest evaluates the
// factory before the `const` initializer runs. Define the mock fn
// inside the factory and re-export it via a getter we read from the
// tests below.
const { updateMappingRuleMock } = vi.hoisted(() => {
  const updateMappingRuleMock = vi.fn(
    async (
      id: string,
      body: {
        pattern: string;
        matchType?: string;
        categoryId?: string | null;
        priority?: number;
      },
    ) => ({
      id,
      pattern: body.pattern,
      matchType: body.matchType ?? "contains",
      categoryId: body.categoryId ?? null,
      priority: body.priority ?? 0,
    }),
  );
  return { updateMappingRuleMock };
});

vi.mock("@workspace/api-client-react", () => ({
  useListMappingRules: () => ({ data: rulesState, isLoading: false }),
  useListCategories: () => ({
    data: [
      { id: "cat-1", name: "Coffee" },
      { id: "cat-2", name: "Groceries" },
    ],
    isLoading: false,
  }),
  useCreateMappingRule: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateMappingRule: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteMappingRule: () => ({ mutate: vi.fn(), isPending: false }),
  useReorderMappingRules: () => ({ mutate: vi.fn(), isPending: false }),
  useTestMappingRules: () => ({
    mutate: vi.fn(),
    data: undefined,
    reset: vi.fn(),
    isPending: false,
  }),
  usePreviewMappingRuleRecategorize: () => ({
    mutate: vi.fn(),
    data: undefined,
    reset: vi.fn(),
    isPending: false,
  }),
  usePreviewMappingRuleRecategorizeByPattern: () => ({
    mutate: vi.fn(),
    data: undefined,
    reset: vi.fn(),
    isPending: false,
  }),
  useRecategorizeTransactionsByPattern: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useUncategorizeTransactionsByIds: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  getListMappingRulesQueryKey: () => ["/api/mapping-rules"],
  getListTransactionsQueryKey: () => ["/api/transactions"],
  getGetBudgetMonthQueryKey: (m: string) => ["/api/budget-month", m],
  createMappingRule: vi.fn(),
  updateMappingRule: updateMappingRuleMock,
  deleteMappingRule: vi.fn(),
}));

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

beforeEach(() => {
  toastMock.mockClear();
  updateMappingRuleMock.mockClear();
  rulesState = [
    {
      id: "rule-1",
      pattern: "STARBUCKS",
      matchType: "contains",
      categoryId: "cat-1",
      priority: 110,
    },
    {
      id: "rule-2",
      pattern: "PEET'S",
      matchType: "contains",
      categoryId: "cat-1",
      priority: 100,
    },
    {
      id: "rule-3",
      pattern: "DUTCH BROS",
      matchType: "contains",
      categoryId: null,
      priority: 90,
    },
  ];
});

afterEach(() => {
  cleanup();
});

describe("(#231) Mapping Rules — bulk change category", () => {
  it("re-assigns every selected rule's category in one go and clears the selection", async () => {
    renderPage();

    // Select all three rules.
    await act(async () => {
      fireEvent.click(screen.getByTestId("rule-select-rule-1"));
      fireEvent.click(screen.getByTestId("rule-select-rule-2"));
      fireEvent.click(screen.getByTestId("rule-select-rule-3"));
    });

    // The bulk-change-category control is exposed alongside the
    // bulk-delete button when at least one rule is selected.
    const changeSelect = screen.getByTestId(
      "rule-bulk-change-category",
    ) as HTMLSelectElement;
    expect(changeSelect).toBeTruthy();
    // Sanity: the existing bulk-delete button is still adjacent.
    expect(screen.getByTestId("rule-bulk-delete")).toBeTruthy();

    await act(async () => {
      fireEvent.change(changeSelect, { target: { value: "cat-2" } });
    });

    // One PATCH per selected rule, all swapping in cat-2.
    await waitFor(() => {
      expect(updateMappingRuleMock).toHaveBeenCalledTimes(3);
    });
    const updatedById = new Map(
      updateMappingRuleMock.mock.calls.map(([id, body]) => [id, body]),
    );
    expect(updatedById.get("rule-1")).toMatchObject({
      pattern: "STARBUCKS",
      matchType: "contains",
      categoryId: "cat-2",
      priority: 110,
    });
    expect(updatedById.get("rule-2")).toMatchObject({
      pattern: "PEET'S",
      matchType: "contains",
      categoryId: "cat-2",
      priority: 100,
    });
    expect(updatedById.get("rule-3")).toMatchObject({
      pattern: "DUTCH BROS",
      matchType: "contains",
      categoryId: "cat-2",
      priority: 90,
    });

    // Single toast that names the count + destination category.
    await waitFor(() => {
      expect(
        toastMock.mock.calls.some(
          (c) =>
            typeof c[0].title === "string" &&
            (c[0].title as string).includes("Updated 3 rules") &&
            (c[0].title as string).includes("Groceries"),
        ),
      ).toBe(true);
    });

    // Selection is cleared — the bulk bar collapses back to the
    // baseline "Select all" state with no destructive actions
    // visible.
    await waitFor(() => {
      expect(screen.queryByTestId("rule-bulk-delete")).toBeNull();
    });
  });

  it("skips rules already pointed at the chosen category and Undo restores prior categories in one go", async () => {
    renderPage();

    // Select all three rules. rule-1 and rule-2 are already in cat-1
    // (the destination), so they should be skipped — only rule-3
    // (currently uncategorized) should be PATCHed.
    await act(async () => {
      fireEvent.click(screen.getByTestId("rule-select-rule-1"));
      fireEvent.click(screen.getByTestId("rule-select-rule-2"));
      fireEvent.click(screen.getByTestId("rule-select-rule-3"));
    });

    const changeSelect = screen.getByTestId(
      "rule-bulk-change-category",
    ) as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(changeSelect, { target: { value: "cat-1" } });
    });

    await waitFor(() => {
      expect(updateMappingRuleMock).toHaveBeenCalledTimes(1);
    });
    const [patchedId, patchedBody] = updateMappingRuleMock.mock.calls[0];
    expect(patchedId).toBe("rule-3");
    expect(patchedBody).toMatchObject({
      pattern: "DUTCH BROS",
      matchType: "contains",
      categoryId: "cat-1",
      priority: 90,
    });

    // The toast title is singular and names the destination category.
    const updatedToast = await waitFor(() =>
      toastMock.mock.calls
        .map((c) => c[0])
        .find(
          (t) =>
            typeof t.title === "string" &&
            (t.title as string).includes("Updated 1 rule") &&
            (t.title as string).includes("Coffee"),
        ),
    );
    expect(updatedToast).toBeTruthy();
    expect(isValidElement(updatedToast!.action)).toBe(true);

    // Click Undo. The Undo PATCH must restore rule-3's *prior*
    // categoryId (null) — not the destination we just set.
    updateMappingRuleMock.mockClear();
    const action = updatedToast!.action as React.ReactElement<{
      onClick?: () => void;
    }>;
    expect(typeof action.props.onClick).toBe("function");
    await act(async () => {
      action.props.onClick!();
    });

    await waitFor(() => {
      expect(updateMappingRuleMock).toHaveBeenCalledTimes(1);
    });
    const [undoId, undoBody] = updateMappingRuleMock.mock.calls[0];
    expect(undoId).toBe("rule-3");
    expect(undoBody).toMatchObject({
      pattern: "DUTCH BROS",
      matchType: "contains",
      categoryId: null,
      priority: 90,
    });

    // The "Restored N rules" toast confirms the Undo round-trip.
    await waitFor(() => {
      expect(
        toastMock.mock.calls.some(
          (c) =>
            typeof c[0].title === "string" &&
            (c[0].title as string).startsWith("Restored 1 rule"),
        ),
      ).toBe(true);
    });
  });
});
