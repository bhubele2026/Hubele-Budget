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

// Task #233 — restoring a deleted mapping rule via the Undo toast must
// NOT surface the "Apply to past too?" prompt. The contract is now
// explicit at the call site (submitMappingRule receives source:
// "create" | "restore"), but we lock it in here so a future refactor
// of mapping-rules.tsx can't quietly reintroduce the prompt on the
// restore path.

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

vi.mock("@/hooks/use-bulk-recategorize-prompt", () => ({
  useBulkRecategorizePrompt: () => ({
    offerBulkRecategorize: offerBulkRecategorizeMock,
    previewDialog: null,
  }),
  // The page calls this to convert a server `RuleAction` into a bulk-rule
  // shape; in this test the restore path doesn't reach it (we assert
  // offerBulkRecategorize is never called), but the symbol must exist
  // because mapping-rules.tsx imports it at module load time.
  bulkRuleFromRuleAction: vi.fn(() => null),
}));

// wouter is only used for ?focus= deep linking on this page; safe to stub.
vi.mock("wouter", () => ({
  useSearch: () => "",
}));

// Heavy dnd-kit pieces aren't relevant to the restore/Undo flow. Stub
// them out to keep the test focused on the create+delete+undo path.
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
const createMutate = vi.fn();
const deleteMutate = vi.fn();

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
  useDeleteMappingRule: () => ({
    mutate: deleteMutate,
    isPending: false,
  }),
  useReorderMappingRules: () => ({ mutate: vi.fn(), isPending: false }),
  useTestMappingRules: () => ({
    mutate: vi.fn(),
    data: undefined,
    reset: vi.fn(),
    isPending: false,
  }),
  getListMappingRulesQueryKey: () => ["/api/mapping-rules"],
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
  deleteMutate.mockReset();
  rulesState = [
    {
      id: "rule-1",
      pattern: "STARBUCKS",
      matchType: "contains",
      categoryId: "cat-1",
      priority: 110,
    },
  ];
});

afterEach(() => {
  cleanup();
});

describe("(#233) Mapping Rules — Undo restore does not re-prompt 'Apply to past'", () => {
  it("clicking Undo on the delete toast restores the rule without offering the bulk-recategorize prompt", async () => {
    // The delete mutate's onSuccess fires the Undo toast; capture it so
    // we can simulate the server confirming the delete.
    deleteMutate.mockImplementation(
      (
        _vars: { id: string },
        opts?: { onSuccess?: () => void },
      ) => {
        opts?.onSuccess?.();
      },
    );
    // The create mutate's onSuccess fires the "Rule restored" toast.
    // Pass back a server RuleAction so we'd notice if the page ever
    // tried to surface the bulk prompt on restore.
    createMutate.mockImplementation(
      (
        _vars: unknown,
        opts?: {
          onSuccess?: (
            res: { id: string; ruleAction: { kind: string } },
          ) => void;
        },
      ) => {
        opts?.onSuccess?.({
          id: "rule-1-restored",
          ruleAction: {
            kind: "created",
          },
        });
      },
    );

    renderPage();

    // Sanity: the seeded rule is rendered.
    expect(await screen.findByTestId("rule-row-rule-1")).toBeTruthy();

    // Trigger delete.
    await act(async () => {
      fireEvent.click(screen.getByTestId("rule-delete-rule-1"));
    });
    expect(deleteMutate).toHaveBeenCalledTimes(1);

    // The "Rule deleted" toast was shown with an Undo action. Find it.
    const deletedToast = toastMock.mock.calls
      .map((c) => c[0])
      .find((t) => t.title === "Rule deleted" && isValidElement(t.action));
    expect(deletedToast).toBeTruthy();

    // Pull the Undo ToastAction's onClick out and invoke it directly —
    // the toast viewport isn't mounted in this isolated test, so we
    // simulate the click on the action element itself.
    const action = deletedToast!.action as React.ReactElement<{
      onClick?: () => void;
    }>;
    expect(typeof action.props.onClick).toBe("function");

    await act(async () => {
      action.props.onClick!();
    });

    // The restore went through createRule.mutate with the original rule
    // shape — including matchType / categoryId / priority — so the row
    // comes back exactly as it was.
    expect(createMutate).toHaveBeenCalledTimes(1);
    const [createVars] = createMutate.mock.calls[0];
    expect(createVars).toEqual({
      data: {
        pattern: "STARBUCKS",
        matchType: "contains",
        categoryId: "cat-1",
        priority: 110,
      },
    });

    // The "Rule restored" toast was shown.
    await waitFor(() => {
      expect(
        toastMock.mock.calls.some((c) => c[0].title === "Rule restored"),
      ).toBe(true);
    });

    // The whole point of this test: the bulk-recategorize prompt must
    // NOT be surfaced on the restore path, even though the server
    // returned a `ruleAction` shape that would normally trigger it on
    // a fresh create.
    expect(offerBulkRecategorizeMock).not.toHaveBeenCalled();
    expect(
      toastMock.mock.calls.some((c) => c[0].title === "Apply to past too?"),
    ).toBe(false);
  });

});
