import { vi } from "vitest";

// Shared default-stub factory for the Mapping Rules page tests.
//
// The page (`../mapping-rules.tsx`) calls roughly a dozen hooks from
// `@workspace/api-client-react` and a couple of `wouter` exports at module
// load time. Every test that mocks the module by hand had to re-list every
// hook, so adding a new hook to the page silently broke every test that
// didn't yet know about it (with a "No <hook> export is defined on the
// mock" runtime error).
//
// To stop that class of failure: every mapping-rules-* test mocks the
// module by importing the factory below from inside the `vi.mock` async
// factory and spreads its overrides on top. Adding a new hook to the
// page only requires adding a default stub here.

type Mutation = { mutate: ReturnType<typeof vi.fn>; isPending: boolean };
type MutationWithData = Mutation & {
  data: undefined;
  reset: ReturnType<typeof vi.fn>;
};
type Query<T> = { data: T; isLoading: boolean };

function noopMutation(): Mutation {
  return { mutate: vi.fn(), isPending: false };
}
function noopMutationWithData(): MutationWithData {
  return { mutate: vi.fn(), data: undefined, reset: vi.fn(), isPending: false };
}
function noopQuery<T>(data: T): () => Query<T> {
  return () => ({ data, isLoading: false });
}

export type MappingRulesApiClientOverrides = Partial<
  ReturnType<typeof defaultMappingRulesApiClientMock>
>;

// Returns the full mock module shape for `@workspace/api-client-react` as
// used by mapping-rules.tsx. Tests pass overrides for the bits they care
// about; everything else falls through to a benign default that won't
// crash the page on render.
export function defaultMappingRulesApiClientMock(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const defaults: Record<string, unknown> = {
    // Queries
    useListMappingRules: noopQuery<unknown[]>([]),
    useListCategories: noopQuery<unknown[]>([]),
    // Mutations
    useCreateMappingRule: noopMutation,
    useUpdateMappingRule: noopMutation,
    useDeleteMappingRule: noopMutation,
    useReorderMappingRules: noopMutation,
    useTestMappingRules: noopMutationWithData,
    usePreviewMappingRuleRecategorize: noopMutationWithData,
    usePreviewMappingRuleRecategorizeByPattern: noopMutationWithData,
    useRecategorizeTransactionsByPattern: noopMutation,
    useUncategorizeTransactionsByIds: noopMutation,
    // (F2) The learned-rules panel names the account a "This account only"
    // rule is narrowed to, and marks the review queue stale after filing.
    useListPlaidItems: noopQuery<unknown[]>([]),
    // Query-key helpers
    getListMappingRulesQueryKey: () => ["/api/mapping-rules"],
    getListTransactionsQueryKey: () => ["/api/transactions"],
    getGetBudgetMonthQueryKey: (m: string) => ["/api/budget-month", m],
    getListPlaidItemsQueryKey: () => ["/api/plaid/items"],
    getListCategorizationReviewQueryKey: () => ["/api/categorization/review"],
    // Direct (non-hook) endpoint helpers
    createMappingRule: vi.fn(),
    updateMappingRule: vi.fn(),
    deleteMappingRule: vi.fn(),
  };
  return { ...defaults, ...overrides };
}

// (C7 / F2) The learned-rules panel on the same page reads the `features`
// sub-module (C0), a separate module specifier from the main client, so every
// mapping-rules test mocks it too:
//
//   vi.mock("@workspace/api-client-react/features", async () => {
//     const { defaultMappingRulesFeaturesMock } = await import(
//       "./__test-helpers__/mapping-rules-mocks"
//     );
//     return defaultMappingRulesFeaturesMock();
//   });
//
// The default is an empty, loaded list — the panel renders its empty note and
// issues no request.
export function defaultMappingRulesFeaturesMock(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const defaults: Record<string, unknown> = {
    useListLearnedRules: () => ({
      data: [],
      isFetching: false,
      isLoadingError: false,
      isRefetchError: false,
      refetch: vi.fn(),
    }),
    getListLearnedRulesQueryKey: () => ["/api/learned-rules"],
    useUpdateLearnedRule: noopMutation,
    useDeleteLearnedRule: noopMutation,
    useApplyLearnedRuleRetroactively: noopMutation,
    // (WP5b) A rule's History popover. Its query only mounts while the popover
    // is open, so the default (an empty history) is never even read by tests
    // that do not open one.
    useGetMappingRuleHistory: () => ({
      data: { ruleId: "", entries: [], truncated: false },
      isFetching: false,
      isLoadingError: false,
      isRefetchError: false,
      refetch: vi.fn(),
    }),
    getGetMappingRuleHistoryQueryKey: (id: string) => [`/api/mapping-rules/${id}/history`],
  };
  return { ...defaults, ...overrides };
}

export type WouterOverrides = {
  useSearch?: () => string;
  useLocation?: () => readonly [string, (path: string) => void];
};

// Default `wouter` mock shape covering the exports the page uses
// (`useSearch` for the ?focus= deep-link param, `useLocation` for
// programmatic navigation, and `Link` in the learned-rules panel's foot).
export function defaultMappingRulesWouterMock(
  overrides: WouterOverrides = {},
): {
  useSearch: () => string;
  useLocation: () => readonly [string, (path: string) => void];
  Link: (props: { href: string; children?: unknown; className?: string }) => unknown;
} {
  return {
    useSearch: overrides.useSearch ?? (() => ""),
    useLocation:
      overrides.useLocation ??
      (() => ["/mapping-rules", vi.fn()] as const),
    // (C8) The learned-rules panel links to Settings › Automation.
    Link: ({ children }) => children ?? null,
  };
}
