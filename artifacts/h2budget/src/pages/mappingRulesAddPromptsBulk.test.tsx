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
import React from "react";

// Task #235 — sibling to mappingRulesRestoreNoPrompt.test.tsx. The
// restore branch test locks in that Undo does NOT surface the
// "Apply to past too?" prompt; this test locks in the *opposite*
// for the create branch — the Add form MUST still surface the
// prompt when the server reports older matching transactions.
//
// Together the two tests pin down both sides of the
// `source === "restore"` check inside `submitMappingRule`. If a
// future refactor accidentally inverts the check (or drops it
// entirely so neither branch prompts), this test fails alongside
// its sibling.

type ToastCall = {
  title?: React.ReactNode;
  description?: React.ReactNode;
  duration?: number;
  action?: React.ReactNode;
};

const toastMock = vi.fn<(opts: ToastCall) => { dismiss: () => void }>(() => ({
  dismiss: vi.fn(),
}));

const offerBulkRecategorizeMock = vi.fn();

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: toastMock }),
}));

// Return a realistic BulkRecategorizeRule from the server's
// `RuleAction` so `submitMappingRule` actually has something to
// hand to `offerBulkRecategorize`. The shape mirrors the real
// helper for `kind: "created"` (fromCategoryId: null sweep).
vi.mock("@/hooks/use-bulk-recategorize-prompt", () => ({
  useBulkRecategorizePrompt: () => ({
    offerBulkRecategorize: offerBulkRecategorizeMock,
    previewDialog: null,
  }),
  bulkRuleFromRuleAction: vi.fn(
    (
      action: { kind: string; pattern?: string; matchType?: string; toCategoryId?: string; candidateCount?: number } | undefined,
      toCategoryName?: string,
    ) => {
      if (!action) return null;
      if (
        action.kind !== "created" &&
        action.kind !== "created_priority_bump"
      ) {
        return null;
      }
      if (
        !action.pattern ||
        !action.matchType ||
        !action.toCategoryId ||
        typeof action.candidateCount !== "number" ||
        action.candidateCount <= 0
      ) {
        return null;
      }
      return {
        pattern: action.pattern,
        matchType: action.matchType,
        fromCategoryId: null,
        toCategoryId: action.toCategoryId,
        candidateCount: action.candidateCount,
        toCategoryName,
      };
    },
  ),
}));

vi.mock("wouter", () => ({
  useSearch: () => "",
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
// shim. The Radix popover is awkward to drive in jsdom (portals,
// pointerDown, etc.), so this lets us flip the category select
// with a plain `change` event while keeping the page's `value` /
// `onValueChange` contract intact. SelectTrigger / SelectContent /
// SelectValue collapse to a passthrough fragment so the page's
// JSX still mounts.
vi.mock("@/components/ui/select", () => {
  type SelectProps = {
    value?: string;
    onValueChange?: (v: string) => void;
    children?: React.ReactNode;
  };
  function flattenItems(node: React.ReactNode): React.ReactElement[] {
    const out: React.ReactElement[] = [];
    React.Children.forEach(node, (child) => {
      if (!React.isValidElement(child)) return;
      const props = child.props as { value?: string; children?: React.ReactNode };
      if (typeof props.value === "string") {
        out.push(child);
      } else if (props.children !== undefined) {
        out.push(...flattenItems(props.children));
      }
    });
    return out;
  }
  return {
    Select: ({ value, onValueChange, children }: SelectProps) => {
      const items = flattenItems(children);
      return (
        <select
          data-testid="mock-select"
          value={value ?? ""}
          onChange={(e) => onValueChange?.(e.target.value)}
        >
          <option value="" disabled>
            Select…
          </option>
          {items.map((item) => {
            const p = item.props as { value: string; children?: React.ReactNode };
            return (
              <option key={p.value} value={p.value}>
                {typeof p.children === "string" ? p.children : p.value}
              </option>
            );
          })}
        </select>
      );
    },
    SelectTrigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    SelectContent: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
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
const createMutate = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  useListMappingRules: () => ({ data: rulesState, isLoading: false }),
  useListCategories: () => ({
    data: [{ id: "cat-1", name: "Coffee" }],
    isLoading: false,
  }),
  useCreateMappingRule: () => ({
    mutate: createMutate,
    isPending: false,
  }),
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
  useRecategorizeTransactionsByPattern: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  getListMappingRulesQueryKey: () => ["/api/mapping-rules"],
  getListTransactionsQueryKey: () => ["/api/transactions"],
  getGetBudgetMonthQueryKey: (m: string) => ["/api/budget-month", m],
  createMappingRule: vi.fn(),
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
  offerBulkRecategorizeMock.mockClear();
  createMutate.mockReset();
  rulesState = [];
});

afterEach(() => {
  cleanup();
});

describe("(#235) Mapping Rules — Add form still surfaces 'Apply to past' prompt", () => {
  it("submitting the Add form invokes offerBulkRecategorize and fires the 'Rule added' toast when the server reports older matches", async () => {
    // The create mutate's onSuccess fires the create-branch handler in
    // submitMappingRule. Hand back a server `ruleAction` of
    // `kind: "created"` with a non-zero candidateCount so
    // bulkRuleFromRuleAction returns a real prompt rule.
    createMutate.mockImplementation(
      (
        _vars: unknown,
        opts?: {
          onSuccess?: (res: {
            id: string;
            ruleAction: {
              kind: string;
              pattern: string;
              matchType: string;
              toCategoryId: string;
              candidateCount: number;
            };
          }) => void;
        },
      ) => {
        opts?.onSuccess?.({
          id: "rule-new",
          ruleAction: {
            kind: "created",
            pattern: "STARBUCKS",
            matchType: "contains",
            toCategoryId: "cat-1",
            candidateCount: 4,
          },
        });
      },
    );

    renderPage();

    // Fill the pattern input.
    const patternInput = await screen.findByTestId("input-add-pattern");
    await act(async () => {
      fireEvent.change(patternInput, { target: { value: "STARBUCKS" } });
    });

    // Pick the category. The Add form has two Selects (matchType +
    // category); the matchType already defaults to "contains" so we
    // only need to flip the category select to a real value before
    // the Add button enables.
    const selects = screen.getAllByTestId("mock-select");
    // Find the one whose options include "cat-1" (the category select).
    const categorySelect = selects.find((sel) =>
      Array.from(sel.querySelectorAll("option")).some(
        (o) => (o as HTMLOptionElement).value === "cat-1",
      ),
    ) as HTMLSelectElement | undefined;
    expect(categorySelect).toBeTruthy();
    await act(async () => {
      fireEvent.change(categorySelect!, { target: { value: "cat-1" } });
    });

    // Click Add.
    const addBtn = screen.getByTestId("btn-add-rule") as HTMLButtonElement;
    expect(addBtn.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(addBtn);
    });

    // The create mutate fired with the form's data + the friendly
    // toCategoryName threaded through for the prompt copy.
    expect(createMutate).toHaveBeenCalledTimes(1);
    const [createVars] = createMutate.mock.calls[0];
    expect(createVars).toEqual({
      data: {
        pattern: "STARBUCKS",
        matchType: "contains",
        categoryId: "cat-1",
        // Initial top priority defaults to 100 + 10 = 110 when the
        // rule list is empty (see handleAddRule).
        priority: 110,
      },
    });

    // The "Rule added" toast must fire on the create branch (and
    // it must NOT be the "Rule restored" toast — that's the
    // restore branch this test exists to distinguish from).
    await waitFor(() => {
      expect(
        toastMock.mock.calls.some((c) => c[0].title === "Rule added"),
      ).toBe(true);
    });
    expect(
      toastMock.mock.calls.some((c) => c[0].title === "Rule restored"),
    ).toBe(false);

    // The whole point of this test: the bulk-recategorize prompt
    // MUST be surfaced on the create path when the server reports
    // older matches. The hook receives a rule shaped from the
    // ruleAction with the friendly category name threaded through.
    expect(offerBulkRecategorizeMock).toHaveBeenCalledTimes(1);
    const [bulkRule] = offerBulkRecategorizeMock.mock.calls[0];
    expect(bulkRule).toMatchObject({
      pattern: "STARBUCKS",
      matchType: "contains",
      fromCategoryId: null,
      toCategoryId: "cat-1",
      candidateCount: 4,
      toCategoryName: "Coffee",
    });
  });
});
