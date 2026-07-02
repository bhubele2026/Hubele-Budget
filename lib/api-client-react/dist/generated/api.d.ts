import type { QueryKey, UseMutationOptions, UseMutationResult, UseQueryOptions, UseQueryResult } from "@tanstack/react-query";
import type { AdvisorChatRequest, AdvisorChatResponse, AdvisorNudge, AdvisorProposalErrorResponse, AdvisorProposalResolveResponse, AdvisorUndoErrorResponse, AdvisorUndoResponse, AmexAnchor, AmexAnchorInput, AmexWeeklyPayoff, AprilChaseSeedResult, AvalancheExtra, AvalancheSchedule, AvalancheSettings, AvalancheSettingsInput, BankSnapshot, BankingInsightsSummary, BehaviorFacts, BillsSummary, BudgetFacts, BudgetLine, BudgetLineInput, BudgetMonthDetail, BulkCreateDebtsFromPlaidRequest, BulkCreateDebtsFromPlaidResponse, BulkSetForecastFlagInput, BulkSetForecastFlagResult, BulkUpdateTransactionsInput, BulkUpdateTransactionsResult, CashSignal, Category, CategoryInput, CategoryPatchInput, CheckInvitationInput, CheckInvitationResult, CleanupNonProdPlaidItems200, CloseForecastMonthBody, CreateDebtFromPlaidAccount409, CreateDebtFromPlaidResult, CreateInvitationInput, CreateMappingRuleResponse, CreateTransactionInput, CreateTransactionResponse, DashboardBudget, DashboardBudgetInput, DashboardSummary, Debt, DebtBalanceHistoryEntry, DebtInput, DebtLinkInput, DebtPaymentInput, DebtPaymentResult, DedupeTransactionsReport, DeleteAmexAnchor200, DeleteDashboardBudgetParams, DeleteMerchantAliasParams, DeleteMerchantAliasResult, DuplicateTransactionCount, ForecastBundle, ForecastClosedMonth, ForecastResolution, ForecastResolutionInput, ForecastSettings, ForecastSettingsInput, GetAmexWeeklyPayoffParams, GetBankingInsightsSummaryParams, GetBillsSummaryParams, GetForecastAvalancheScheduleParams, GetForecastCashSignalParams, GetForecastParams, GetReportsAdvisorSummaryParams, GetReportsBehaviorFactsParams, GetReportsBudgetFactsParams, GetReportsSpendingFactsParams, HealthStatus, ImportSummary, ImportWorkbookBody, Invitation, ListDashboardBudgetsParams, ListPlaidLiabilityAccountsParams, ListTransactionsParams, ListWeeklyDebriefsParams, ListWeeklySettlementsParams, MappingRule, MappingRuleInput, MappingRulePatternRecategorizePreview, MappingRulePatternRecategorizePreviewInput, MappingRuleRecategorizePreview, MappingRuleRecategorizePreviewInput, MeResponse, Member, PinBudgetLineInput, PinBudgetMonthInput, PinResult, PlaidConsentRefreshResult, PlaidEnvironmentInfo, PlaidExchangeInput, PlaidItemDetail, PlaidLiabilityAccount, PlaidLinkToken, PlaidMalformedTokenSweepResult, PlaidSyncAttemptsResult, PlaidSyncInput, PlaidSyncResult, PlaidUpdateLinkTokenInput, PutMerchantAliasInput, PutMerchantAliasResult, RecategorizeByPatternInput, RecategorizeByPatternResult, RecurringItem, RecurringItemInput, RefreshBankInput, ReopenWeekParams, ReorderMappingRulesInput, ReportsAdvisorSummary, SeedDefaultBudgetResult, SendTransactionsToReviewInput, SendTransactionsToReviewResult, SetBankSnapshotInput, Settings, SettingsInput, SpendingFacts, SuggestMerchantNameInput, SuggestMerchantNameResult, SyncMinimumsResult, TestMappingRulesInput, TestMappingRulesResult, Transaction, TransactionInput, UiPreferences, UncategorizeByIdsInput, UncategorizeByIdsResult, UnlockWeeklyDebriefBody, UpdatePlaidImportCutoffDate200, UpdatePlaidImportCutoffDateBody, UpdateTransactionResponse, VersionInfo, WeeklyDebriefDetail, WeeklyDebriefList, WeeklySettlement, WeeklySettlementInput } from "./api.schemas";
import { customFetch } from "../custom-fetch";
import type { ErrorType, BodyType } from "../custom-fetch";
type AwaitedInput<T> = PromiseLike<T> | T;
type Awaited<O> = O extends AwaitedInput<infer T> ? T : never;
type SecondParameter<T extends (...args: never) => unknown> = Parameters<T>[1];
/**
 * @summary Health check
 */
export declare const getHealthCheckUrl: () => string;
export declare const healthCheck: (options?: RequestInit) => Promise<HealthStatus>;
export declare const getHealthCheckQueryKey: () => readonly ["/api/healthz"];
export declare const getHealthCheckQueryOptions: <TData = Awaited<ReturnType<typeof healthCheck>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof healthCheck>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof healthCheck>>, TError, TData> & {
    queryKey: QueryKey;
};
export type HealthCheckQueryResult = NonNullable<Awaited<ReturnType<typeof healthCheck>>>;
export type HealthCheckQueryError = ErrorType<unknown>;
/**
 * @summary Health check
 */
export declare function useHealthCheck<TData = Awaited<ReturnType<typeof healthCheck>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof healthCheck>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary Stable per-deploy build identifier. The web bundle bakes the
same identifier at build time; a client poller compares the two
and prompts the user to reload when they differ (i.e. a new
version has been deployed). No auth — GET only.

 */
export declare const getGetVersionUrl: () => string;
export declare const getVersion: (options?: RequestInit) => Promise<VersionInfo>;
export declare const getGetVersionQueryKey: () => readonly ["/api/version"];
export declare const getGetVersionQueryOptions: <TData = Awaited<ReturnType<typeof getVersion>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getVersion>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getVersion>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetVersionQueryResult = NonNullable<Awaited<ReturnType<typeof getVersion>>>;
export type GetVersionQueryError = ErrorType<unknown>;
/**
 * @summary Stable per-deploy build identifier. The web bundle bakes the
same identifier at build time; a client poller compares the two
and prompts the user to reload when they differ (i.e. a new
version has been deployed). No auth — GET only.

 */
export declare function useGetVersion<TData = Awaited<ReturnType<typeof getVersion>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getVersion>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary Dashboard summary
 */
export declare const getGetDashboardUrl: () => string;
export declare const getDashboard: (options?: RequestInit) => Promise<DashboardSummary>;
export declare const getGetDashboardQueryKey: () => readonly ["/api/dashboard"];
export declare const getGetDashboardQueryOptions: <TData = Awaited<ReturnType<typeof getDashboard>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getDashboard>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getDashboard>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetDashboardQueryResult = NonNullable<Awaited<ReturnType<typeof getDashboard>>>;
export type GetDashboardQueryError = ErrorType<unknown>;
/**
 * @summary Dashboard summary
 */
export declare function useGetDashboard<TData = Awaited<ReturnType<typeof getDashboard>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getDashboard>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getListTransactionsUrl: (params?: ListTransactionsParams) => string;
export declare const listTransactions: (params?: ListTransactionsParams, options?: RequestInit) => Promise<Transaction[]>;
export declare const getListTransactionsQueryKey: (params?: ListTransactionsParams) => readonly ["/api/transactions", ...ListTransactionsParams[]];
export declare const getListTransactionsQueryOptions: <TData = Awaited<ReturnType<typeof listTransactions>>, TError = ErrorType<unknown>>(params?: ListTransactionsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listTransactions>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listTransactions>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListTransactionsQueryResult = NonNullable<Awaited<ReturnType<typeof listTransactions>>>;
export type ListTransactionsQueryError = ErrorType<unknown>;
export declare function useListTransactions<TData = Awaited<ReturnType<typeof listTransactions>>, TError = ErrorType<unknown>>(params?: ListTransactionsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listTransactions>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getCreateTransactionUrl: () => string;
export declare const createTransaction: (createTransactionInput: CreateTransactionInput, options?: RequestInit) => Promise<CreateTransactionResponse>;
export declare const getCreateTransactionMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createTransaction>>, TError, {
        data: BodyType<CreateTransactionInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof createTransaction>>, TError, {
    data: BodyType<CreateTransactionInput>;
}, TContext>;
export type CreateTransactionMutationResult = NonNullable<Awaited<ReturnType<typeof createTransaction>>>;
export type CreateTransactionMutationBody = BodyType<CreateTransactionInput>;
export type CreateTransactionMutationError = ErrorType<unknown>;
export declare const useCreateTransaction: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createTransaction>>, TError, {
        data: BodyType<CreateTransactionInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof createTransaction>>, TError, {
    data: BodyType<CreateTransactionInput>;
}, TContext>;
export declare const getUpdateTransactionUrl: (id: string) => string;
export declare const updateTransaction: (id: string, transactionInput: TransactionInput, options?: RequestInit) => Promise<UpdateTransactionResponse>;
export declare const getUpdateTransactionMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateTransaction>>, TError, {
        id: string;
        data: BodyType<TransactionInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof updateTransaction>>, TError, {
    id: string;
    data: BodyType<TransactionInput>;
}, TContext>;
export type UpdateTransactionMutationResult = NonNullable<Awaited<ReturnType<typeof updateTransaction>>>;
export type UpdateTransactionMutationBody = BodyType<TransactionInput>;
export type UpdateTransactionMutationError = ErrorType<unknown>;
export declare const useUpdateTransaction: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateTransaction>>, TError, {
        id: string;
        data: BodyType<TransactionInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof updateTransaction>>, TError, {
    id: string;
    data: BodyType<TransactionInput>;
}, TContext>;
export declare const getDeleteTransactionUrl: (id: string) => string;
export declare const deleteTransaction: (id: string, options?: RequestInit) => Promise<void>;
export declare const getDeleteTransactionMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deleteTransaction>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof deleteTransaction>>, TError, {
    id: string;
}, TContext>;
export type DeleteTransactionMutationResult = NonNullable<Awaited<ReturnType<typeof deleteTransaction>>>;
export type DeleteTransactionMutationError = ErrorType<unknown>;
export declare const useDeleteTransaction: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deleteTransaction>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof deleteTransaction>>, TError, {
    id: string;
}, TContext>;
/**
 * @summary Clear the `isTransferUserOverridden` flag on a single transaction so
that the next Plaid sync (or XLSX import / aprilChaseSeed pass) can
re-apply the description+PFC auto-Transfer heuristic to it. Used by
the "Reset to auto" affordance surfaced in the row's Edit dialog
when the user has previously toggled the Transfer flag manually.

 */
export declare const getClearTransferOverrideUrl: (id: string) => string;
export declare const clearTransferOverride: (id: string, options?: RequestInit) => Promise<Transaction>;
export declare const getClearTransferOverrideMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof clearTransferOverride>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof clearTransferOverride>>, TError, {
    id: string;
}, TContext>;
export type ClearTransferOverrideMutationResult = NonNullable<Awaited<ReturnType<typeof clearTransferOverride>>>;
export type ClearTransferOverrideMutationError = ErrorType<void>;
/**
 * @summary Clear the `isTransferUserOverridden` flag on a single transaction so
that the next Plaid sync (or XLSX import / aprilChaseSeed pass) can
re-apply the description+PFC auto-Transfer heuristic to it. Used by
the "Reset to auto" affordance surfaced in the row's Edit dialog
when the user has previously toggled the Transfer flag manually.

 */
export declare const useClearTransferOverride: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof clearTransferOverride>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof clearTransferOverride>>, TError, {
    id: string;
}, TContext>;
/**
 * @summary Bulk re-categorize past transactions whose description matches a
mapping rule's pattern and that currently sit in the rule's old
category. Used by the "apply this rule to past transactions too"
prompt that surfaces after the auto-relearn flow repoints a seed
rule (e.g. an Amex/Cap One/Discover debt-payment rule moving from
"Misc / Buffer" onto the user's real per-debt category).

 */
export declare const getRecategorizeTransactionsByPatternUrl: () => string;
export declare const recategorizeTransactionsByPattern: (recategorizeByPatternInput: RecategorizeByPatternInput, options?: RequestInit) => Promise<RecategorizeByPatternResult>;
export declare const getRecategorizeTransactionsByPatternMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof recategorizeTransactionsByPattern>>, TError, {
        data: BodyType<RecategorizeByPatternInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof recategorizeTransactionsByPattern>>, TError, {
    data: BodyType<RecategorizeByPatternInput>;
}, TContext>;
export type RecategorizeTransactionsByPatternMutationResult = NonNullable<Awaited<ReturnType<typeof recategorizeTransactionsByPattern>>>;
export type RecategorizeTransactionsByPatternMutationBody = BodyType<RecategorizeByPatternInput>;
export type RecategorizeTransactionsByPatternMutationError = ErrorType<unknown>;
/**
 * @summary Bulk re-categorize past transactions whose description matches a
mapping rule's pattern and that currently sit in the rule's old
category. Used by the "apply this rule to past transactions too"
prompt that surfaces after the auto-relearn flow repoints a seed
rule (e.g. an Amex/Cap One/Discover debt-payment rule moving from
"Misc / Buffer" onto the user's real per-debt category).

 */
export declare const useRecategorizeTransactionsByPattern: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof recategorizeTransactionsByPattern>>, TError, {
        data: BodyType<RecategorizeByPatternInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof recategorizeTransactionsByPattern>>, TError, {
    data: BodyType<RecategorizeByPatternInput>;
}, TContext>;
/**
 * @summary (#888) Set or update a friendly merchant name (alias) for a
transaction's stable signature. The caller passes the raw bank
`description` (the server owns signature derivation so client and
server can never drift) plus the desired `alias`. The alias is
household-scoped and keyed on the signature, so it applies to every
current AND future transaction that shares the same signature. The
response reports how many existing transactions share the signature
so the UI can say "applies to N transactions".

 */
export declare const getPutMerchantAliasUrl: () => string;
export declare const putMerchantAlias: (putMerchantAliasInput: PutMerchantAliasInput, options?: RequestInit) => Promise<PutMerchantAliasResult>;
export declare const getPutMerchantAliasMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof putMerchantAlias>>, TError, {
        data: BodyType<PutMerchantAliasInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof putMerchantAlias>>, TError, {
    data: BodyType<PutMerchantAliasInput>;
}, TContext>;
export type PutMerchantAliasMutationResult = NonNullable<Awaited<ReturnType<typeof putMerchantAlias>>>;
export type PutMerchantAliasMutationBody = BodyType<PutMerchantAliasInput>;
export type PutMerchantAliasMutationError = ErrorType<void>;
/**
 * @summary (#888) Set or update a friendly merchant name (alias) for a
transaction's stable signature. The caller passes the raw bank
`description` (the server owns signature derivation so client and
server can never drift) plus the desired `alias`. The alias is
household-scoped and keyed on the signature, so it applies to every
current AND future transaction that shares the same signature. The
response reports how many existing transactions share the signature
so the UI can say "applies to N transactions".

 */
export declare const usePutMerchantAlias: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof putMerchantAlias>>, TError, {
        data: BodyType<PutMerchantAliasInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof putMerchantAlias>>, TError, {
    data: BodyType<PutMerchantAliasInput>;
}, TContext>;
/**
 * @summary (#888) Remove a merchant alias, resetting the row headline back to the
deterministic bank-default name (cleanMerchant). Idempotent — deleting
a non-existent alias succeeds as a no-op.

 */
export declare const getDeleteMerchantAliasUrl: (params: DeleteMerchantAliasParams) => string;
export declare const deleteMerchantAlias: (params: DeleteMerchantAliasParams, options?: RequestInit) => Promise<DeleteMerchantAliasResult>;
export declare const getDeleteMerchantAliasMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deleteMerchantAlias>>, TError, {
        params: DeleteMerchantAliasParams;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof deleteMerchantAlias>>, TError, {
    params: DeleteMerchantAliasParams;
}, TContext>;
export type DeleteMerchantAliasMutationResult = NonNullable<Awaited<ReturnType<typeof deleteMerchantAlias>>>;
export type DeleteMerchantAliasMutationError = ErrorType<unknown>;
/**
 * @summary (#888) Remove a merchant alias, resetting the row headline back to the
deterministic bank-default name (cleanMerchant). Idempotent — deleting
a non-existent alias succeeds as a no-op.

 */
export declare const useDeleteMerchantAlias: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deleteMerchantAlias>>, TError, {
        params: DeleteMerchantAliasParams;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof deleteMerchantAlias>>, TError, {
    params: DeleteMerchantAliasParams;
}, TContext>;
/**
 * @summary (#888) Suggest a clean, human-friendly merchant name for a raw bank
`description` using Anthropic. Read-only — does NOT persist an alias.
Always returns a usable suggestion: on any AI error/timeout it falls
back to the deterministic cleanMerchant label (`source: "fallback"`).

 */
export declare const getSuggestMerchantNameUrl: () => string;
export declare const suggestMerchantName: (suggestMerchantNameInput: SuggestMerchantNameInput, options?: RequestInit) => Promise<SuggestMerchantNameResult>;
export declare const getSuggestMerchantNameMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof suggestMerchantName>>, TError, {
        data: BodyType<SuggestMerchantNameInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof suggestMerchantName>>, TError, {
    data: BodyType<SuggestMerchantNameInput>;
}, TContext>;
export type SuggestMerchantNameMutationResult = NonNullable<Awaited<ReturnType<typeof suggestMerchantName>>>;
export type SuggestMerchantNameMutationBody = BodyType<SuggestMerchantNameInput>;
export type SuggestMerchantNameMutationError = ErrorType<unknown>;
/**
 * @summary (#888) Suggest a clean, human-friendly merchant name for a raw bank
`description` using Anthropic. Read-only — does NOT persist an alias.
Always returns a usable suggestion: on any AI error/timeout it falls
back to the deterministic cleanMerchant label (`source: "fallback"`).

 */
export declare const useSuggestMerchantName: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof suggestMerchantName>>, TError, {
        data: BodyType<SuggestMerchantNameInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof suggestMerchantName>>, TError, {
    data: BodyType<SuggestMerchantNameInput>;
}, TContext>;
/**
 * @summary Bulk clear the categoryId on a list of transactions, scoped by an
optional `fromCategoryId` guard so manual edits made between the
original recategorize and the Undo click are preserved. Used by the
"Rule added · moved N past transactions" toast on the Mapping Rules
page so the user can one-click Undo a freshly-added rule's bulk
sweep — the existing /transactions/recategorize-by-pattern endpoint
can't model the swap because it requires a non-null toCategoryId.
Reusable for any future "from anywhere" bulk that needs a null
target.

 */
export declare const getUncategorizeTransactionsByIdsUrl: () => string;
export declare const uncategorizeTransactionsByIds: (uncategorizeByIdsInput: UncategorizeByIdsInput, options?: RequestInit) => Promise<UncategorizeByIdsResult>;
export declare const getUncategorizeTransactionsByIdsMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof uncategorizeTransactionsByIds>>, TError, {
        data: BodyType<UncategorizeByIdsInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof uncategorizeTransactionsByIds>>, TError, {
    data: BodyType<UncategorizeByIdsInput>;
}, TContext>;
export type UncategorizeTransactionsByIdsMutationResult = NonNullable<Awaited<ReturnType<typeof uncategorizeTransactionsByIds>>>;
export type UncategorizeTransactionsByIdsMutationBody = BodyType<UncategorizeByIdsInput>;
export type UncategorizeTransactionsByIdsMutationError = ErrorType<unknown>;
/**
 * @summary Bulk clear the categoryId on a list of transactions, scoped by an
optional `fromCategoryId` guard so manual edits made between the
original recategorize and the Undo click are preserved. Used by the
"Rule added · moved N past transactions" toast on the Mapping Rules
page so the user can one-click Undo a freshly-added rule's bulk
sweep — the existing /transactions/recategorize-by-pattern endpoint
can't model the swap because it requires a non-null toCategoryId.
Reusable for any future "from anywhere" bulk that needs a null
target.

 */
export declare const useUncategorizeTransactionsByIds: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof uncategorizeTransactionsByIds>>, TError, {
        data: BodyType<UncategorizeByIdsInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof uncategorizeTransactionsByIds>>, TError, {
    data: BodyType<UncategorizeByIdsInput>;
}, TContext>;
/**
 * @summary Apply the same patch to a list of transactions in a single
request. Replaces the per-row PATCH /transactions/{id} fan-out
used by the Amex / All-transactions bulk action bar (bulk
recategorize, bulk bucket, bulk owed-by, bulk reimbursable,
bulk reviewed) so a 500-row selection costs one round-trip
instead of 500. The patch is the same shape as TransactionInput
but only the fields the caller wants changed should be set —
omitted fields are left alone. Unlike the per-row PATCH this
endpoint does NOT trigger the auto-learn mapping-rule flow:
bulk recategorize is an explicit user-driven action and the
rule-learning toast is only meaningful for one-off edits.

 */
export declare const getBulkUpdateTransactionsUrl: () => string;
export declare const bulkUpdateTransactions: (bulkUpdateTransactionsInput: BulkUpdateTransactionsInput, options?: RequestInit) => Promise<BulkUpdateTransactionsResult>;
export declare const getBulkUpdateTransactionsMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof bulkUpdateTransactions>>, TError, {
        data: BodyType<BulkUpdateTransactionsInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof bulkUpdateTransactions>>, TError, {
    data: BodyType<BulkUpdateTransactionsInput>;
}, TContext>;
export type BulkUpdateTransactionsMutationResult = NonNullable<Awaited<ReturnType<typeof bulkUpdateTransactions>>>;
export type BulkUpdateTransactionsMutationBody = BodyType<BulkUpdateTransactionsInput>;
export type BulkUpdateTransactionsMutationError = ErrorType<unknown>;
/**
 * @summary Apply the same patch to a list of transactions in a single
request. Replaces the per-row PATCH /transactions/{id} fan-out
used by the Amex / All-transactions bulk action bar (bulk
recategorize, bulk bucket, bulk owed-by, bulk reimbursable,
bulk reviewed) so a 500-row selection costs one round-trip
instead of 500. The patch is the same shape as TransactionInput
but only the fields the caller wants changed should be set —
omitted fields are left alone. Unlike the per-row PATCH this
endpoint does NOT trigger the auto-learn mapping-rule flow:
bulk recategorize is an explicit user-driven action and the
rule-learning toast is only meaningful for one-off edits.

 */
export declare const useBulkUpdateTransactions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof bulkUpdateTransactions>>, TError, {
        data: BodyType<BulkUpdateTransactionsInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof bulkUpdateTransactions>>, TError, {
    data: BodyType<BulkUpdateTransactionsInput>;
}, TContext>;
/**
 * @summary (#762 — Phase B) Promote up to 200 transactions into the Review
workflow by stamping `sent_to_review_at = NOW()`. The Chase /
Amex / source-of-truth views are unaffected — only the Review
pipeline on /forecast filters on the column. Rows already sent
are silently skipped. Scoped to the caller's household so other
households' ids are no-ops.

 */
export declare const getSendTransactionsToReviewUrl: () => string;
export declare const sendTransactionsToReview: (sendTransactionsToReviewInput: SendTransactionsToReviewInput, options?: RequestInit) => Promise<SendTransactionsToReviewResult>;
export declare const getSendTransactionsToReviewMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof sendTransactionsToReview>>, TError, {
        data: BodyType<SendTransactionsToReviewInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof sendTransactionsToReview>>, TError, {
    data: BodyType<SendTransactionsToReviewInput>;
}, TContext>;
export type SendTransactionsToReviewMutationResult = NonNullable<Awaited<ReturnType<typeof sendTransactionsToReview>>>;
export type SendTransactionsToReviewMutationBody = BodyType<SendTransactionsToReviewInput>;
export type SendTransactionsToReviewMutationError = ErrorType<unknown>;
/**
 * @summary (#762 — Phase B) Promote up to 200 transactions into the Review
workflow by stamping `sent_to_review_at = NOW()`. The Chase /
Amex / source-of-truth views are unaffected — only the Review
pipeline on /forecast filters on the column. Rows already sent
are silently skipped. Scoped to the caller's household so other
households' ids are no-ops.

 */
export declare const useSendTransactionsToReview: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof sendTransactionsToReview>>, TError, {
        data: BodyType<SendTransactionsToReviewInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof sendTransactionsToReview>>, TError, {
    data: BodyType<SendTransactionsToReviewInput>;
}, TContext>;
/**
 * @summary (#762 — Phase B) Reverse a Send-to-Review by clearing
`sent_to_review_at = NULL` on up to 200 transactions. Used by
the 5-second "Undo" affordance on the success toast and by the
symmetric Review-tab "unsend" flow. Same household scoping and
batch ceiling as /transactions/send-to-review.

 */
export declare const getUnsendTransactionsFromReviewUrl: () => string;
export declare const unsendTransactionsFromReview: (sendTransactionsToReviewInput: SendTransactionsToReviewInput, options?: RequestInit) => Promise<SendTransactionsToReviewResult>;
export declare const getUnsendTransactionsFromReviewMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof unsendTransactionsFromReview>>, TError, {
        data: BodyType<SendTransactionsToReviewInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof unsendTransactionsFromReview>>, TError, {
    data: BodyType<SendTransactionsToReviewInput>;
}, TContext>;
export type UnsendTransactionsFromReviewMutationResult = NonNullable<Awaited<ReturnType<typeof unsendTransactionsFromReview>>>;
export type UnsendTransactionsFromReviewMutationBody = BodyType<SendTransactionsToReviewInput>;
export type UnsendTransactionsFromReviewMutationError = ErrorType<unknown>;
/**
 * @summary (#762 — Phase B) Reverse a Send-to-Review by clearing
`sent_to_review_at = NULL` on up to 200 transactions. Used by
the 5-second "Undo" affordance on the success toast and by the
symmetric Review-tab "unsend" flow. Same household scoping and
batch ceiling as /transactions/send-to-review.

 */
export declare const useUnsendTransactionsFromReview: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof unsendTransactionsFromReview>>, TError, {
        data: BodyType<SendTransactionsToReviewInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof unsendTransactionsFromReview>>, TError, {
    data: BodyType<SendTransactionsToReviewInput>;
}, TContext>;
/**
 * @summary Bulk set the forecast_flag on a list of transactions to a target
boolean value. Returns the ids that were actually flipped (rows
whose flag already matched the target are skipped) so the client
can offer a one-click Undo on the success toast that's safe even
when the user has since toggled some of the rows back manually.

 */
export declare const getBulkSetForecastFlagUrl: () => string;
export declare const bulkSetForecastFlag: (bulkSetForecastFlagInput: BulkSetForecastFlagInput, options?: RequestInit) => Promise<BulkSetForecastFlagResult>;
export declare const getBulkSetForecastFlagMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof bulkSetForecastFlag>>, TError, {
        data: BodyType<BulkSetForecastFlagInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof bulkSetForecastFlag>>, TError, {
    data: BodyType<BulkSetForecastFlagInput>;
}, TContext>;
export type BulkSetForecastFlagMutationResult = NonNullable<Awaited<ReturnType<typeof bulkSetForecastFlag>>>;
export type BulkSetForecastFlagMutationBody = BodyType<BulkSetForecastFlagInput>;
export type BulkSetForecastFlagMutationError = ErrorType<unknown>;
/**
 * @summary Bulk set the forecast_flag on a list of transactions to a target
boolean value. Returns the ids that were actually flipped (rows
whose flag already matched the target are skipped) so the client
can offer a one-click Undo on the success toast that's safe even
when the user has since toggled some of the rows back manually.

 */
export declare const useBulkSetForecastFlag: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof bulkSetForecastFlag>>, TError, {
        data: BodyType<BulkSetForecastFlagInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof bulkSetForecastFlag>>, TError, {
    data: BodyType<BulkSetForecastFlagInput>;
}, TContext>;
export declare const getListDebtsUrl: () => string;
export declare const listDebts: (options?: RequestInit) => Promise<Debt[]>;
export declare const getListDebtsQueryKey: () => readonly ["/api/debts"];
export declare const getListDebtsQueryOptions: <TData = Awaited<ReturnType<typeof listDebts>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listDebts>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listDebts>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListDebtsQueryResult = NonNullable<Awaited<ReturnType<typeof listDebts>>>;
export type ListDebtsQueryError = ErrorType<unknown>;
export declare function useListDebts<TData = Awaited<ReturnType<typeof listDebts>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listDebts>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getCreateDebtUrl: () => string;
export declare const createDebt: (debtInput: DebtInput, options?: RequestInit) => Promise<Debt>;
export declare const getCreateDebtMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createDebt>>, TError, {
        data: BodyType<DebtInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof createDebt>>, TError, {
    data: BodyType<DebtInput>;
}, TContext>;
export type CreateDebtMutationResult = NonNullable<Awaited<ReturnType<typeof createDebt>>>;
export type CreateDebtMutationBody = BodyType<DebtInput>;
export type CreateDebtMutationError = ErrorType<unknown>;
export declare const useCreateDebt: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createDebt>>, TError, {
        data: BodyType<DebtInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof createDebt>>, TError, {
    data: BodyType<DebtInput>;
}, TContext>;
export declare const getLinkDebtToPlaidUrl: (id: string) => string;
export declare const linkDebtToPlaid: (id: string, debtLinkInput: DebtLinkInput, options?: RequestInit) => Promise<Debt>;
export declare const getLinkDebtToPlaidMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof linkDebtToPlaid>>, TError, {
        id: string;
        data: BodyType<DebtLinkInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof linkDebtToPlaid>>, TError, {
    id: string;
    data: BodyType<DebtLinkInput>;
}, TContext>;
export type LinkDebtToPlaidMutationResult = NonNullable<Awaited<ReturnType<typeof linkDebtToPlaid>>>;
export type LinkDebtToPlaidMutationBody = BodyType<DebtLinkInput>;
export type LinkDebtToPlaidMutationError = ErrorType<unknown>;
export declare const useLinkDebtToPlaid: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof linkDebtToPlaid>>, TError, {
        id: string;
        data: BodyType<DebtLinkInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof linkDebtToPlaid>>, TError, {
    id: string;
    data: BodyType<DebtLinkInput>;
}, TContext>;
export declare const getUnlinkDebtFromPlaidUrl: (id: string) => string;
export declare const unlinkDebtFromPlaid: (id: string, options?: RequestInit) => Promise<Debt>;
export declare const getUnlinkDebtFromPlaidMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof unlinkDebtFromPlaid>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof unlinkDebtFromPlaid>>, TError, {
    id: string;
}, TContext>;
export type UnlinkDebtFromPlaidMutationResult = NonNullable<Awaited<ReturnType<typeof unlinkDebtFromPlaid>>>;
export type UnlinkDebtFromPlaidMutationError = ErrorType<unknown>;
export declare const useUnlinkDebtFromPlaid: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof unlinkDebtFromPlaid>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof unlinkDebtFromPlaid>>, TError, {
    id: string;
}, TContext>;
export declare const getRefreshDebtFromPlaidUrl: (id: string) => string;
export declare const refreshDebtFromPlaid: (id: string, options?: RequestInit) => Promise<Debt>;
export declare const getRefreshDebtFromPlaidMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof refreshDebtFromPlaid>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof refreshDebtFromPlaid>>, TError, {
    id: string;
}, TContext>;
export type RefreshDebtFromPlaidMutationResult = NonNullable<Awaited<ReturnType<typeof refreshDebtFromPlaid>>>;
export type RefreshDebtFromPlaidMutationError = ErrorType<unknown>;
export declare const useRefreshDebtFromPlaid: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof refreshDebtFromPlaid>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof refreshDebtFromPlaid>>, TError, {
    id: string;
}, TContext>;
export declare const getListPlaidLiabilityAccountsUrl: (params?: ListPlaidLiabilityAccountsParams) => string;
export declare const listPlaidLiabilityAccounts: (params?: ListPlaidLiabilityAccountsParams, options?: RequestInit) => Promise<PlaidLiabilityAccount[]>;
export declare const getListPlaidLiabilityAccountsQueryKey: (params?: ListPlaidLiabilityAccountsParams) => readonly ["/api/plaid/liability-accounts", ...ListPlaidLiabilityAccountsParams[]];
export declare const getListPlaidLiabilityAccountsQueryOptions: <TData = Awaited<ReturnType<typeof listPlaidLiabilityAccounts>>, TError = ErrorType<unknown>>(params?: ListPlaidLiabilityAccountsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listPlaidLiabilityAccounts>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listPlaidLiabilityAccounts>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListPlaidLiabilityAccountsQueryResult = NonNullable<Awaited<ReturnType<typeof listPlaidLiabilityAccounts>>>;
export type ListPlaidLiabilityAccountsQueryError = ErrorType<unknown>;
export declare function useListPlaidLiabilityAccounts<TData = Awaited<ReturnType<typeof listPlaidLiabilityAccounts>>, TError = ErrorType<unknown>>(params?: ListPlaidLiabilityAccountsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listPlaidLiabilityAccounts>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getCreateDebtFromPlaidAccountUrl: (plaidAccountId: string) => string;
export declare const createDebtFromPlaidAccount: (plaidAccountId: string, options?: RequestInit) => Promise<CreateDebtFromPlaidResult>;
export declare const getCreateDebtFromPlaidAccountMutationOptions: <TError = ErrorType<CreateDebtFromPlaidAccount409>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createDebtFromPlaidAccount>>, TError, {
        plaidAccountId: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof createDebtFromPlaidAccount>>, TError, {
    plaidAccountId: string;
}, TContext>;
export type CreateDebtFromPlaidAccountMutationResult = NonNullable<Awaited<ReturnType<typeof createDebtFromPlaidAccount>>>;
export type CreateDebtFromPlaidAccountMutationError = ErrorType<CreateDebtFromPlaidAccount409>;
export declare const useCreateDebtFromPlaidAccount: <TError = ErrorType<CreateDebtFromPlaidAccount409>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createDebtFromPlaidAccount>>, TError, {
        plaidAccountId: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof createDebtFromPlaidAccount>>, TError, {
    plaidAccountId: string;
}, TContext>;
export declare const getBulkCreateDebtsFromPlaidAccountsUrl: () => string;
export declare const bulkCreateDebtsFromPlaidAccounts: (bulkCreateDebtsFromPlaidRequest: BulkCreateDebtsFromPlaidRequest, options?: RequestInit) => Promise<BulkCreateDebtsFromPlaidResponse>;
export declare const getBulkCreateDebtsFromPlaidAccountsMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof bulkCreateDebtsFromPlaidAccounts>>, TError, {
        data: BodyType<BulkCreateDebtsFromPlaidRequest>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof bulkCreateDebtsFromPlaidAccounts>>, TError, {
    data: BodyType<BulkCreateDebtsFromPlaidRequest>;
}, TContext>;
export type BulkCreateDebtsFromPlaidAccountsMutationResult = NonNullable<Awaited<ReturnType<typeof bulkCreateDebtsFromPlaidAccounts>>>;
export type BulkCreateDebtsFromPlaidAccountsMutationBody = BodyType<BulkCreateDebtsFromPlaidRequest>;
export type BulkCreateDebtsFromPlaidAccountsMutationError = ErrorType<unknown>;
export declare const useBulkCreateDebtsFromPlaidAccounts: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof bulkCreateDebtsFromPlaidAccounts>>, TError, {
        data: BodyType<BulkCreateDebtsFromPlaidRequest>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof bulkCreateDebtsFromPlaidAccounts>>, TError, {
    data: BodyType<BulkCreateDebtsFromPlaidRequest>;
}, TContext>;
/**
 * @summary All recorded balance snapshots for the current user's debts
 */
export declare const getListDebtBalanceHistoryUrl: () => string;
export declare const listDebtBalanceHistory: (options?: RequestInit) => Promise<DebtBalanceHistoryEntry[]>;
export declare const getListDebtBalanceHistoryQueryKey: () => readonly ["/api/debts/balance-history"];
export declare const getListDebtBalanceHistoryQueryOptions: <TData = Awaited<ReturnType<typeof listDebtBalanceHistory>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listDebtBalanceHistory>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listDebtBalanceHistory>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListDebtBalanceHistoryQueryResult = NonNullable<Awaited<ReturnType<typeof listDebtBalanceHistory>>>;
export type ListDebtBalanceHistoryQueryError = ErrorType<unknown>;
/**
 * @summary All recorded balance snapshots for the current user's debts
 */
export declare function useListDebtBalanceHistory<TData = Awaited<ReturnType<typeof listDebtBalanceHistory>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listDebtBalanceHistory>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getSyncDebtMinimumsUrl: () => string;
export declare const syncDebtMinimums: (options?: RequestInit) => Promise<SyncMinimumsResult>;
export declare const getSyncDebtMinimumsMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof syncDebtMinimums>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof syncDebtMinimums>>, TError, void, TContext>;
export type SyncDebtMinimumsMutationResult = NonNullable<Awaited<ReturnType<typeof syncDebtMinimums>>>;
export type SyncDebtMinimumsMutationError = ErrorType<unknown>;
export declare const useSyncDebtMinimums: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof syncDebtMinimums>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof syncDebtMinimums>>, TError, void, TContext>;
/**
 * @summary Resolved monthly extra-payment amount
 */
export declare const getGetAvalancheExtraUrl: () => string;
export declare const getAvalancheExtra: (options?: RequestInit) => Promise<AvalancheExtra>;
export declare const getGetAvalancheExtraQueryKey: () => readonly ["/api/avalanche/extra"];
export declare const getGetAvalancheExtraQueryOptions: <TData = Awaited<ReturnType<typeof getAvalancheExtra>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getAvalancheExtra>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getAvalancheExtra>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetAvalancheExtraQueryResult = NonNullable<Awaited<ReturnType<typeof getAvalancheExtra>>>;
export type GetAvalancheExtraQueryError = ErrorType<unknown>;
/**
 * @summary Resolved monthly extra-payment amount
 */
export declare function useGetAvalancheExtra<TData = Awaited<ReturnType<typeof getAvalancheExtra>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getAvalancheExtra>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getCreateDebtPaymentUrl: (id: string) => string;
export declare const createDebtPayment: (id: string, debtPaymentInput: DebtPaymentInput, options?: RequestInit) => Promise<DebtPaymentResult>;
export declare const getCreateDebtPaymentMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createDebtPayment>>, TError, {
        id: string;
        data: BodyType<DebtPaymentInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof createDebtPayment>>, TError, {
    id: string;
    data: BodyType<DebtPaymentInput>;
}, TContext>;
export type CreateDebtPaymentMutationResult = NonNullable<Awaited<ReturnType<typeof createDebtPayment>>>;
export type CreateDebtPaymentMutationBody = BodyType<DebtPaymentInput>;
export type CreateDebtPaymentMutationError = ErrorType<unknown>;
export declare const useCreateDebtPayment: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createDebtPayment>>, TError, {
        id: string;
        data: BodyType<DebtPaymentInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof createDebtPayment>>, TError, {
    id: string;
    data: BodyType<DebtPaymentInput>;
}, TContext>;
export declare const getGetAvalancheSettingsUrl: () => string;
export declare const getAvalancheSettings: (options?: RequestInit) => Promise<AvalancheSettings>;
export declare const getGetAvalancheSettingsQueryKey: () => readonly ["/api/avalanche/settings"];
export declare const getGetAvalancheSettingsQueryOptions: <TData = Awaited<ReturnType<typeof getAvalancheSettings>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getAvalancheSettings>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getAvalancheSettings>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetAvalancheSettingsQueryResult = NonNullable<Awaited<ReturnType<typeof getAvalancheSettings>>>;
export type GetAvalancheSettingsQueryError = ErrorType<unknown>;
export declare function useGetAvalancheSettings<TData = Awaited<ReturnType<typeof getAvalancheSettings>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getAvalancheSettings>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getUpdateAvalancheSettingsUrl: () => string;
export declare const updateAvalancheSettings: (avalancheSettingsInput: AvalancheSettingsInput, options?: RequestInit) => Promise<AvalancheSettings>;
export declare const getUpdateAvalancheSettingsMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateAvalancheSettings>>, TError, {
        data: BodyType<AvalancheSettingsInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof updateAvalancheSettings>>, TError, {
    data: BodyType<AvalancheSettingsInput>;
}, TContext>;
export type UpdateAvalancheSettingsMutationResult = NonNullable<Awaited<ReturnType<typeof updateAvalancheSettings>>>;
export type UpdateAvalancheSettingsMutationBody = BodyType<AvalancheSettingsInput>;
export type UpdateAvalancheSettingsMutationError = ErrorType<unknown>;
export declare const useUpdateAvalancheSettings: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateAvalancheSettings>>, TError, {
        data: BodyType<AvalancheSettingsInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof updateAvalancheSettings>>, TError, {
    data: BodyType<AvalancheSettingsInput>;
}, TContext>;
export declare const getUpdateDebtUrl: (id: string) => string;
export declare const updateDebt: (id: string, debtInput: DebtInput, options?: RequestInit) => Promise<Debt>;
export declare const getUpdateDebtMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateDebt>>, TError, {
        id: string;
        data: BodyType<DebtInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof updateDebt>>, TError, {
    id: string;
    data: BodyType<DebtInput>;
}, TContext>;
export type UpdateDebtMutationResult = NonNullable<Awaited<ReturnType<typeof updateDebt>>>;
export type UpdateDebtMutationBody = BodyType<DebtInput>;
export type UpdateDebtMutationError = ErrorType<unknown>;
export declare const useUpdateDebt: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateDebt>>, TError, {
        id: string;
        data: BodyType<DebtInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof updateDebt>>, TError, {
    id: string;
    data: BodyType<DebtInput>;
}, TContext>;
export declare const getDeleteDebtUrl: (id: string) => string;
export declare const deleteDebt: (id: string, options?: RequestInit) => Promise<void>;
export declare const getDeleteDebtMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deleteDebt>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof deleteDebt>>, TError, {
    id: string;
}, TContext>;
export type DeleteDebtMutationResult = NonNullable<Awaited<ReturnType<typeof deleteDebt>>>;
export type DeleteDebtMutationError = ErrorType<unknown>;
export declare const useDeleteDebt: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deleteDebt>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof deleteDebt>>, TError, {
    id: string;
}, TContext>;
export declare const getListRecurringItemsUrl: () => string;
export declare const listRecurringItems: (options?: RequestInit) => Promise<RecurringItem[]>;
export declare const getListRecurringItemsQueryKey: () => readonly ["/api/recurring-items"];
export declare const getListRecurringItemsQueryOptions: <TData = Awaited<ReturnType<typeof listRecurringItems>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listRecurringItems>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listRecurringItems>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListRecurringItemsQueryResult = NonNullable<Awaited<ReturnType<typeof listRecurringItems>>>;
export type ListRecurringItemsQueryError = ErrorType<unknown>;
export declare function useListRecurringItems<TData = Awaited<ReturnType<typeof listRecurringItems>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listRecurringItems>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getCreateRecurringItemUrl: () => string;
export declare const createRecurringItem: (recurringItemInput: RecurringItemInput, options?: RequestInit) => Promise<RecurringItem>;
export declare const getCreateRecurringItemMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createRecurringItem>>, TError, {
        data: BodyType<RecurringItemInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof createRecurringItem>>, TError, {
    data: BodyType<RecurringItemInput>;
}, TContext>;
export type CreateRecurringItemMutationResult = NonNullable<Awaited<ReturnType<typeof createRecurringItem>>>;
export type CreateRecurringItemMutationBody = BodyType<RecurringItemInput>;
export type CreateRecurringItemMutationError = ErrorType<unknown>;
export declare const useCreateRecurringItem: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createRecurringItem>>, TError, {
        data: BodyType<RecurringItemInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof createRecurringItem>>, TError, {
    data: BodyType<RecurringItemInput>;
}, TContext>;
export declare const getUpdateRecurringItemUrl: (id: string) => string;
export declare const updateRecurringItem: (id: string, recurringItemInput: RecurringItemInput, options?: RequestInit) => Promise<RecurringItem>;
export declare const getUpdateRecurringItemMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateRecurringItem>>, TError, {
        id: string;
        data: BodyType<RecurringItemInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof updateRecurringItem>>, TError, {
    id: string;
    data: BodyType<RecurringItemInput>;
}, TContext>;
export type UpdateRecurringItemMutationResult = NonNullable<Awaited<ReturnType<typeof updateRecurringItem>>>;
export type UpdateRecurringItemMutationBody = BodyType<RecurringItemInput>;
export type UpdateRecurringItemMutationError = ErrorType<unknown>;
export declare const useUpdateRecurringItem: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateRecurringItem>>, TError, {
        id: string;
        data: BodyType<RecurringItemInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof updateRecurringItem>>, TError, {
    id: string;
    data: BodyType<RecurringItemInput>;
}, TContext>;
export declare const getDeleteRecurringItemUrl: (id: string) => string;
export declare const deleteRecurringItem: (id: string, options?: RequestInit) => Promise<void>;
export declare const getDeleteRecurringItemMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deleteRecurringItem>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof deleteRecurringItem>>, TError, {
    id: string;
}, TContext>;
export type DeleteRecurringItemMutationResult = NonNullable<Awaited<ReturnType<typeof deleteRecurringItem>>>;
export type DeleteRecurringItemMutationError = ErrorType<unknown>;
export declare const useDeleteRecurringItem: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deleteRecurringItem>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof deleteRecurringItem>>, TError, {
    id: string;
}, TContext>;
export declare const getListCategoriesUrl: () => string;
export declare const listCategories: (options?: RequestInit) => Promise<Category[]>;
export declare const getListCategoriesQueryKey: () => readonly ["/api/budget/categories"];
export declare const getListCategoriesQueryOptions: <TData = Awaited<ReturnType<typeof listCategories>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listCategories>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listCategories>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListCategoriesQueryResult = NonNullable<Awaited<ReturnType<typeof listCategories>>>;
export type ListCategoriesQueryError = ErrorType<unknown>;
export declare function useListCategories<TData = Awaited<ReturnType<typeof listCategories>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listCategories>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getCreateCategoryUrl: () => string;
export declare const createCategory: (categoryInput: CategoryInput, options?: RequestInit) => Promise<Category>;
export declare const getCreateCategoryMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createCategory>>, TError, {
        data: BodyType<CategoryInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof createCategory>>, TError, {
    data: BodyType<CategoryInput>;
}, TContext>;
export type CreateCategoryMutationResult = NonNullable<Awaited<ReturnType<typeof createCategory>>>;
export type CreateCategoryMutationBody = BodyType<CategoryInput>;
export type CreateCategoryMutationError = ErrorType<unknown>;
export declare const useCreateCategory: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createCategory>>, TError, {
        data: BodyType<CategoryInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof createCategory>>, TError, {
    data: BodyType<CategoryInput>;
}, TContext>;
/**
 * @summary Rename and/or reorder a budget category (My budget envelopes)
 */
export declare const getUpdateCategoryUrl: (id: string) => string;
export declare const updateCategory: (id: string, categoryPatchInput: CategoryPatchInput, options?: RequestInit) => Promise<Category>;
export declare const getUpdateCategoryMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateCategory>>, TError, {
        id: string;
        data: BodyType<CategoryPatchInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof updateCategory>>, TError, {
    id: string;
    data: BodyType<CategoryPatchInput>;
}, TContext>;
export type UpdateCategoryMutationResult = NonNullable<Awaited<ReturnType<typeof updateCategory>>>;
export type UpdateCategoryMutationBody = BodyType<CategoryPatchInput>;
export type UpdateCategoryMutationError = ErrorType<unknown>;
/**
 * @summary Rename and/or reorder a budget category (My budget envelopes)
 */
export declare const useUpdateCategory: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateCategory>>, TError, {
        id: string;
        data: BodyType<CategoryPatchInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof updateCategory>>, TError, {
    id: string;
    data: BodyType<CategoryPatchInput>;
}, TContext>;
export declare const getDeleteCategoryUrl: (id: string) => string;
export declare const deleteCategory: (id: string, options?: RequestInit) => Promise<void>;
export declare const getDeleteCategoryMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deleteCategory>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof deleteCategory>>, TError, {
    id: string;
}, TContext>;
export type DeleteCategoryMutationResult = NonNullable<Awaited<ReturnType<typeof deleteCategory>>>;
export type DeleteCategoryMutationError = ErrorType<unknown>;
export declare const useDeleteCategory: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deleteCategory>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof deleteCategory>>, TError, {
    id: string;
}, TContext>;
export declare const getGetBudgetMonthUrl: (monthStart: string) => string;
export declare const getBudgetMonth: (monthStart: string, options?: RequestInit) => Promise<BudgetMonthDetail>;
export declare const getGetBudgetMonthQueryKey: (monthStart: string) => readonly [`/api/budget/months/${string}`];
export declare const getGetBudgetMonthQueryOptions: <TData = Awaited<ReturnType<typeof getBudgetMonth>>, TError = ErrorType<unknown>>(monthStart: string, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getBudgetMonth>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getBudgetMonth>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetBudgetMonthQueryResult = NonNullable<Awaited<ReturnType<typeof getBudgetMonth>>>;
export type GetBudgetMonthQueryError = ErrorType<unknown>;
export declare function useGetBudgetMonth<TData = Awaited<ReturnType<typeof getBudgetMonth>>, TError = ErrorType<unknown>>(monthStart: string, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getBudgetMonth>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary Seed default categories and May 2026 budget lines (idempotent)
 */
export declare const getSeedDefaultBudgetUrl: () => string;
export declare const seedDefaultBudget: (options?: RequestInit) => Promise<SeedDefaultBudgetResult>;
export declare const getSeedDefaultBudgetMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof seedDefaultBudget>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof seedDefaultBudget>>, TError, void, TContext>;
export type SeedDefaultBudgetMutationResult = NonNullable<Awaited<ReturnType<typeof seedDefaultBudget>>>;
export type SeedDefaultBudgetMutationError = ErrorType<unknown>;
/**
 * @summary Seed default categories and May 2026 budget lines (idempotent)
 */
export declare const useSeedDefaultBudget: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof seedDefaultBudget>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof seedDefaultBudget>>, TError, void, TContext>;
export declare const getUpsertBudgetLineUrl: () => string;
export declare const upsertBudgetLine: (budgetLineInput: BudgetLineInput, options?: RequestInit) => Promise<BudgetLine>;
export declare const getUpsertBudgetLineMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof upsertBudgetLine>>, TError, {
        data: BodyType<BudgetLineInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof upsertBudgetLine>>, TError, {
    data: BodyType<BudgetLineInput>;
}, TContext>;
export type UpsertBudgetLineMutationResult = NonNullable<Awaited<ReturnType<typeof upsertBudgetLine>>>;
export type UpsertBudgetLineMutationBody = BodyType<BudgetLineInput>;
export type UpsertBudgetLineMutationError = ErrorType<unknown>;
export declare const useUpsertBudgetLine: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof upsertBudgetLine>>, TError, {
        data: BodyType<BudgetLineInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof upsertBudgetLine>>, TError, {
    data: BodyType<BudgetLineInput>;
}, TContext>;
/**
 * @summary Pin (or unpin) every auto-pulled line in a month to its currently
displayed planned amount, so the persisted value is preferred over the
live Bills/Debts derivation. Pinning snapshots the current derived
amounts into budget_lines; unpinning leaves the snapshot in place but
causes the response to fall back to the live derivation again.

 */
export declare const getPinBudgetMonthUrl: (monthStart: string) => string;
export declare const pinBudgetMonth: (monthStart: string, pinBudgetMonthInput: PinBudgetMonthInput, options?: RequestInit) => Promise<PinResult>;
export declare const getPinBudgetMonthMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof pinBudgetMonth>>, TError, {
        monthStart: string;
        data: BodyType<PinBudgetMonthInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof pinBudgetMonth>>, TError, {
    monthStart: string;
    data: BodyType<PinBudgetMonthInput>;
}, TContext>;
export type PinBudgetMonthMutationResult = NonNullable<Awaited<ReturnType<typeof pinBudgetMonth>>>;
export type PinBudgetMonthMutationBody = BodyType<PinBudgetMonthInput>;
export type PinBudgetMonthMutationError = ErrorType<unknown>;
/**
 * @summary Pin (or unpin) every auto-pulled line in a month to its currently
displayed planned amount, so the persisted value is preferred over the
live Bills/Debts derivation. Pinning snapshots the current derived
amounts into budget_lines; unpinning leaves the snapshot in place but
causes the response to fall back to the live derivation again.

 */
export declare const usePinBudgetMonth: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof pinBudgetMonth>>, TError, {
        monthStart: string;
        data: BodyType<PinBudgetMonthInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof pinBudgetMonth>>, TError, {
    monthStart: string;
    data: BodyType<PinBudgetMonthInput>;
}, TContext>;
/**
 * @summary Pin (or unpin) a single auto-pulled budget line for a given month so
the persisted planned amount is preferred over the live derivation.
Pinning snapshots the current derived amount into budget_lines.

 */
export declare const getPinBudgetLineUrl: () => string;
export declare const pinBudgetLine: (pinBudgetLineInput: PinBudgetLineInput, options?: RequestInit) => Promise<PinResult>;
export declare const getPinBudgetLineMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof pinBudgetLine>>, TError, {
        data: BodyType<PinBudgetLineInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof pinBudgetLine>>, TError, {
    data: BodyType<PinBudgetLineInput>;
}, TContext>;
export type PinBudgetLineMutationResult = NonNullable<Awaited<ReturnType<typeof pinBudgetLine>>>;
export type PinBudgetLineMutationBody = BodyType<PinBudgetLineInput>;
export type PinBudgetLineMutationError = ErrorType<unknown>;
/**
 * @summary Pin (or unpin) a single auto-pulled budget line for a given month so
the persisted planned amount is preferred over the live derivation.
Pinning snapshots the current derived amount into budget_lines.

 */
export declare const usePinBudgetLine: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof pinBudgetLine>>, TError, {
        data: BodyType<PinBudgetLineInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof pinBudgetLine>>, TError, {
    data: BodyType<PinBudgetLineInput>;
}, TContext>;
export declare const getListMappingRulesUrl: () => string;
export declare const listMappingRules: (options?: RequestInit) => Promise<MappingRule[]>;
export declare const getListMappingRulesQueryKey: () => readonly ["/api/mapping-rules"];
export declare const getListMappingRulesQueryOptions: <TData = Awaited<ReturnType<typeof listMappingRules>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listMappingRules>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listMappingRules>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListMappingRulesQueryResult = NonNullable<Awaited<ReturnType<typeof listMappingRules>>>;
export type ListMappingRulesQueryError = ErrorType<unknown>;
export declare function useListMappingRules<TData = Awaited<ReturnType<typeof listMappingRules>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listMappingRules>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getCreateMappingRuleUrl: () => string;
export declare const createMappingRule: (mappingRuleInput: MappingRuleInput, options?: RequestInit) => Promise<CreateMappingRuleResponse>;
export declare const getCreateMappingRuleMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createMappingRule>>, TError, {
        data: BodyType<MappingRuleInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof createMappingRule>>, TError, {
    data: BodyType<MappingRuleInput>;
}, TContext>;
export type CreateMappingRuleMutationResult = NonNullable<Awaited<ReturnType<typeof createMappingRule>>>;
export type CreateMappingRuleMutationBody = BodyType<MappingRuleInput>;
export type CreateMappingRuleMutationError = ErrorType<unknown>;
export declare const useCreateMappingRule: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createMappingRule>>, TError, {
        data: BodyType<MappingRuleInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof createMappingRule>>, TError, {
    data: BodyType<MappingRuleInput>;
}, TContext>;
export declare const getUpdateMappingRuleUrl: (id: string) => string;
export declare const updateMappingRule: (id: string, mappingRuleInput: MappingRuleInput, options?: RequestInit) => Promise<MappingRule>;
export declare const getUpdateMappingRuleMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateMappingRule>>, TError, {
        id: string;
        data: BodyType<MappingRuleInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof updateMappingRule>>, TError, {
    id: string;
    data: BodyType<MappingRuleInput>;
}, TContext>;
export type UpdateMappingRuleMutationResult = NonNullable<Awaited<ReturnType<typeof updateMappingRule>>>;
export type UpdateMappingRuleMutationBody = BodyType<MappingRuleInput>;
export type UpdateMappingRuleMutationError = ErrorType<unknown>;
export declare const useUpdateMappingRule: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateMappingRule>>, TError, {
        id: string;
        data: BodyType<MappingRuleInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof updateMappingRule>>, TError, {
    id: string;
    data: BodyType<MappingRuleInput>;
}, TContext>;
export declare const getDeleteMappingRuleUrl: (id: string) => string;
export declare const deleteMappingRule: (id: string, options?: RequestInit) => Promise<void>;
export declare const getDeleteMappingRuleMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deleteMappingRule>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof deleteMappingRule>>, TError, {
    id: string;
}, TContext>;
export type DeleteMappingRuleMutationResult = NonNullable<Awaited<ReturnType<typeof deleteMappingRule>>>;
export type DeleteMappingRuleMutationError = ErrorType<unknown>;
export declare const useDeleteMappingRule: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deleteMappingRule>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof deleteMappingRule>>, TError, {
    id: string;
}, TContext>;
/**
 * Replace the priority of every rule whose id appears in `orderedIds`.
The first id is treated as the highest-priority rule. The server
rewrites priorities to a contiguous descending sequence so subsequent
single-rule edits and the auto-learn flow have plenty of headroom on
either side. Returns the full updated rule list (priority-sorted,
same shape as GET /mapping-rules).

 */
export declare const getReorderMappingRulesUrl: () => string;
export declare const reorderMappingRules: (reorderMappingRulesInput: ReorderMappingRulesInput, options?: RequestInit) => Promise<MappingRule[]>;
export declare const getReorderMappingRulesMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof reorderMappingRules>>, TError, {
        data: BodyType<ReorderMappingRulesInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof reorderMappingRules>>, TError, {
    data: BodyType<ReorderMappingRulesInput>;
}, TContext>;
export type ReorderMappingRulesMutationResult = NonNullable<Awaited<ReturnType<typeof reorderMappingRules>>>;
export type ReorderMappingRulesMutationBody = BodyType<ReorderMappingRulesInput>;
export type ReorderMappingRulesMutationError = ErrorType<unknown>;
export declare const useReorderMappingRules: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof reorderMappingRules>>, TError, {
        data: BodyType<ReorderMappingRulesInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof reorderMappingRules>>, TError, {
    data: BodyType<ReorderMappingRulesInput>;
}, TContext>;
/**
 * Preview which of the user's mapping rules would match the given
description, in priority order. The first entry (if any) is the rule
the auto-categorize flow would actually pick.

 */
export declare const getTestMappingRulesUrl: () => string;
export declare const testMappingRules: (testMappingRulesInput: TestMappingRulesInput, options?: RequestInit) => Promise<TestMappingRulesResult>;
export declare const getTestMappingRulesMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof testMappingRules>>, TError, {
        data: BodyType<TestMappingRulesInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof testMappingRules>>, TError, {
    data: BodyType<TestMappingRulesInput>;
}, TContext>;
export type TestMappingRulesMutationResult = NonNullable<Awaited<ReturnType<typeof testMappingRules>>>;
export type TestMappingRulesMutationBody = BodyType<TestMappingRulesInput>;
export type TestMappingRulesMutationError = ErrorType<unknown>;
export declare const useTestMappingRules: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof testMappingRules>>, TError, {
        data: BodyType<TestMappingRulesInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof testMappingRules>>, TError, {
    data: BodyType<TestMappingRulesInput>;
}, TContext>;
/**
 * Preview how many existing transactions would be affected if the given
mapping rule's `categoryId` were changed to `toCategoryId`. Returns the
same `{ candidateCount, sampleTransactions }` shape that PATCH
/transactions/:id reports for repointed rules, so the Mapping Rules edit
UI can surface "N past transactions will move into <new category>" and
a "Show matches" preview before the user saves the edit.

Read-only — the rule is not modified and no transactions are touched.

 */
export declare const getPreviewMappingRuleRecategorizeUrl: (id: string) => string;
export declare const previewMappingRuleRecategorize: (id: string, mappingRuleRecategorizePreviewInput: MappingRuleRecategorizePreviewInput, options?: RequestInit) => Promise<MappingRuleRecategorizePreview>;
export declare const getPreviewMappingRuleRecategorizeMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof previewMappingRuleRecategorize>>, TError, {
        id: string;
        data: BodyType<MappingRuleRecategorizePreviewInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof previewMappingRuleRecategorize>>, TError, {
    id: string;
    data: BodyType<MappingRuleRecategorizePreviewInput>;
}, TContext>;
export type PreviewMappingRuleRecategorizeMutationResult = NonNullable<Awaited<ReturnType<typeof previewMappingRuleRecategorize>>>;
export type PreviewMappingRuleRecategorizeMutationBody = BodyType<MappingRuleRecategorizePreviewInput>;
export type PreviewMappingRuleRecategorizeMutationError = ErrorType<void>;
export declare const usePreviewMappingRuleRecategorize: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof previewMappingRuleRecategorize>>, TError, {
        id: string;
        data: BodyType<MappingRuleRecategorizePreviewInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof previewMappingRuleRecategorize>>, TError, {
    id: string;
    data: BodyType<MappingRuleRecategorizePreviewInput>;
}, TContext>;
/**
 * Read-only preview of the bulk-recategorize that *would* happen if the
Mapping Rules "Add New Rule" form created a rule with the given
`{ pattern, matchType, toCategoryId }` and then chained
POST /transactions/recategorize-by-pattern against the older
*uncategorized* rows it would match. Lets the Add form surface the
same "N past transactions will move into <new category>" inline banner
+ "Show matches" affordance the edit flow already shows, before the
user clicks Add.

`fromCategoryId` is implicitly `null` (uncategorized rows only) since
no rule exists yet to scope by — mirrors how the post-create
`ruleAction` toast already counts candidates for brand-new rules.

Read-only — no rule is created and no transactions are touched.

 */
export declare const getPreviewMappingRuleRecategorizeByPatternUrl: () => string;
export declare const previewMappingRuleRecategorizeByPattern: (mappingRulePatternRecategorizePreviewInput: MappingRulePatternRecategorizePreviewInput, options?: RequestInit) => Promise<MappingRulePatternRecategorizePreview>;
export declare const getPreviewMappingRuleRecategorizeByPatternMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof previewMappingRuleRecategorizeByPattern>>, TError, {
        data: BodyType<MappingRulePatternRecategorizePreviewInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof previewMappingRuleRecategorizeByPattern>>, TError, {
    data: BodyType<MappingRulePatternRecategorizePreviewInput>;
}, TContext>;
export type PreviewMappingRuleRecategorizeByPatternMutationResult = NonNullable<Awaited<ReturnType<typeof previewMappingRuleRecategorizeByPattern>>>;
export type PreviewMappingRuleRecategorizeByPatternMutationBody = BodyType<MappingRulePatternRecategorizePreviewInput>;
export type PreviewMappingRuleRecategorizeByPatternMutationError = ErrorType<unknown>;
export declare const usePreviewMappingRuleRecategorizeByPattern: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof previewMappingRuleRecategorizeByPattern>>, TError, {
        data: BodyType<MappingRulePatternRecategorizePreviewInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof previewMappingRuleRecategorizeByPattern>>, TError, {
    data: BodyType<MappingRulePatternRecategorizePreviewInput>;
}, TContext>;
export declare const getGetSettingsUrl: () => string;
export declare const getSettings: (options?: RequestInit) => Promise<Settings>;
export declare const getGetSettingsQueryKey: () => readonly ["/api/settings"];
export declare const getGetSettingsQueryOptions: <TData = Awaited<ReturnType<typeof getSettings>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getSettings>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getSettings>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetSettingsQueryResult = NonNullable<Awaited<ReturnType<typeof getSettings>>>;
export type GetSettingsQueryError = ErrorType<unknown>;
export declare function useGetSettings<TData = Awaited<ReturnType<typeof getSettings>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getSettings>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getUpdateSettingsUrl: () => string;
export declare const updateSettings: (settingsInput: SettingsInput, options?: RequestInit) => Promise<Settings>;
export declare const getUpdateSettingsMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateSettings>>, TError, {
        data: BodyType<SettingsInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof updateSettings>>, TError, {
    data: BodyType<SettingsInput>;
}, TContext>;
export type UpdateSettingsMutationResult = NonNullable<Awaited<ReturnType<typeof updateSettings>>>;
export type UpdateSettingsMutationBody = BodyType<SettingsInput>;
export type UpdateSettingsMutationError = ErrorType<unknown>;
export declare const useUpdateSettings: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateSettings>>, TError, {
        data: BodyType<SettingsInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof updateSettings>>, TError, {
    data: BodyType<SettingsInput>;
}, TContext>;
export declare const getGetForecastUrl: (params?: GetForecastParams) => string;
export declare const getForecast: (params?: GetForecastParams, options?: RequestInit) => Promise<ForecastBundle>;
export declare const getGetForecastQueryKey: (params?: GetForecastParams) => readonly ["/api/forecast", ...GetForecastParams[]];
export declare const getGetForecastQueryOptions: <TData = Awaited<ReturnType<typeof getForecast>>, TError = ErrorType<unknown>>(params?: GetForecastParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getForecast>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getForecast>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetForecastQueryResult = NonNullable<Awaited<ReturnType<typeof getForecast>>>;
export type GetForecastQueryError = ErrorType<unknown>;
export declare function useGetForecast<TData = Awaited<ReturnType<typeof getForecast>>, TError = ErrorType<unknown>>(params?: GetForecastParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getForecast>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetForecastSettingsUrl: () => string;
export declare const getForecastSettings: (options?: RequestInit) => Promise<ForecastSettings>;
export declare const getGetForecastSettingsQueryKey: () => readonly ["/api/forecast/settings"];
export declare const getGetForecastSettingsQueryOptions: <TData = Awaited<ReturnType<typeof getForecastSettings>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getForecastSettings>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getForecastSettings>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetForecastSettingsQueryResult = NonNullable<Awaited<ReturnType<typeof getForecastSettings>>>;
export type GetForecastSettingsQueryError = ErrorType<unknown>;
export declare function useGetForecastSettings<TData = Awaited<ReturnType<typeof getForecastSettings>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getForecastSettings>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getUpdateForecastSettingsUrl: () => string;
export declare const updateForecastSettings: (forecastSettingsInput: ForecastSettingsInput, options?: RequestInit) => Promise<ForecastSettings>;
export declare const getUpdateForecastSettingsMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateForecastSettings>>, TError, {
        data: BodyType<ForecastSettingsInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof updateForecastSettings>>, TError, {
    data: BodyType<ForecastSettingsInput>;
}, TContext>;
export type UpdateForecastSettingsMutationResult = NonNullable<Awaited<ReturnType<typeof updateForecastSettings>>>;
export type UpdateForecastSettingsMutationBody = BodyType<ForecastSettingsInput>;
export type UpdateForecastSettingsMutationError = ErrorType<unknown>;
export declare const useUpdateForecastSettings: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateForecastSettings>>, TError, {
        data: BodyType<ForecastSettingsInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof updateForecastSettings>>, TError, {
    data: BodyType<ForecastSettingsInput>;
}, TContext>;
export declare const getUpsertForecastResolutionUrl: () => string;
export declare const upsertForecastResolution: (forecastResolutionInput: ForecastResolutionInput, options?: RequestInit) => Promise<ForecastResolution>;
export declare const getUpsertForecastResolutionMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof upsertForecastResolution>>, TError, {
        data: BodyType<ForecastResolutionInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof upsertForecastResolution>>, TError, {
    data: BodyType<ForecastResolutionInput>;
}, TContext>;
export type UpsertForecastResolutionMutationResult = NonNullable<Awaited<ReturnType<typeof upsertForecastResolution>>>;
export type UpsertForecastResolutionMutationBody = BodyType<ForecastResolutionInput>;
export type UpsertForecastResolutionMutationError = ErrorType<unknown>;
export declare const useUpsertForecastResolution: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof upsertForecastResolution>>, TError, {
        data: BodyType<ForecastResolutionInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof upsertForecastResolution>>, TError, {
    data: BodyType<ForecastResolutionInput>;
}, TContext>;
export declare const getDeleteForecastResolutionUrl: (id: string) => string;
export declare const deleteForecastResolution: (id: string, options?: RequestInit) => Promise<void>;
export declare const getDeleteForecastResolutionMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deleteForecastResolution>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof deleteForecastResolution>>, TError, {
    id: string;
}, TContext>;
export type DeleteForecastResolutionMutationResult = NonNullable<Awaited<ReturnType<typeof deleteForecastResolution>>>;
export type DeleteForecastResolutionMutationError = ErrorType<unknown>;
export declare const useDeleteForecastResolution: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deleteForecastResolution>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof deleteForecastResolution>>, TError, {
    id: string;
}, TContext>;
export declare const getSetForecastBankSnapshotUrl: () => string;
export declare const setForecastBankSnapshot: (setBankSnapshotInput: SetBankSnapshotInput, options?: RequestInit) => Promise<BankSnapshot>;
export declare const getSetForecastBankSnapshotMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof setForecastBankSnapshot>>, TError, {
        data: BodyType<SetBankSnapshotInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof setForecastBankSnapshot>>, TError, {
    data: BodyType<SetBankSnapshotInput>;
}, TContext>;
export type SetForecastBankSnapshotMutationResult = NonNullable<Awaited<ReturnType<typeof setForecastBankSnapshot>>>;
export type SetForecastBankSnapshotMutationBody = BodyType<SetBankSnapshotInput>;
export type SetForecastBankSnapshotMutationError = ErrorType<unknown>;
export declare const useSetForecastBankSnapshot: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof setForecastBankSnapshot>>, TError, {
        data: BodyType<SetBankSnapshotInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof setForecastBankSnapshot>>, TError, {
    data: BodyType<SetBankSnapshotInput>;
}, TContext>;
export declare const getDedupeTransactionsUrl: () => string;
export declare const dedupeTransactions: (options?: RequestInit) => Promise<DedupeTransactionsReport>;
export declare const getDedupeTransactionsMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof dedupeTransactions>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof dedupeTransactions>>, TError, void, TContext>;
export type DedupeTransactionsMutationResult = NonNullable<Awaited<ReturnType<typeof dedupeTransactions>>>;
export type DedupeTransactionsMutationError = ErrorType<unknown>;
export declare const useDedupeTransactions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof dedupeTransactions>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof dedupeTransactions>>, TError, void, TContext>;
export declare const getGetDuplicateTransactionCountUrl: () => string;
export declare const getDuplicateTransactionCount: (options?: RequestInit) => Promise<DuplicateTransactionCount>;
export declare const getGetDuplicateTransactionCountQueryKey: () => readonly ["/api/forecast/duplicate-transaction-count"];
export declare const getGetDuplicateTransactionCountQueryOptions: <TData = Awaited<ReturnType<typeof getDuplicateTransactionCount>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getDuplicateTransactionCount>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getDuplicateTransactionCount>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetDuplicateTransactionCountQueryResult = NonNullable<Awaited<ReturnType<typeof getDuplicateTransactionCount>>>;
export type GetDuplicateTransactionCountQueryError = ErrorType<unknown>;
export declare function useGetDuplicateTransactionCount<TData = Awaited<ReturnType<typeof getDuplicateTransactionCount>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getDuplicateTransactionCount>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getRefreshForecastBankUrl: () => string;
export declare const refreshForecastBank: (refreshBankInput?: RefreshBankInput, options?: RequestInit) => Promise<BankSnapshot>;
export declare const getRefreshForecastBankMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof refreshForecastBank>>, TError, {
        data: BodyType<RefreshBankInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof refreshForecastBank>>, TError, {
    data: BodyType<RefreshBankInput>;
}, TContext>;
export type RefreshForecastBankMutationResult = NonNullable<Awaited<ReturnType<typeof refreshForecastBank>>>;
export type RefreshForecastBankMutationBody = BodyType<RefreshBankInput>;
export type RefreshForecastBankMutationError = ErrorType<unknown>;
export declare const useRefreshForecastBank: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof refreshForecastBank>>, TError, {
        data: BodyType<RefreshBankInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof refreshForecastBank>>, TError, {
    data: BodyType<RefreshBankInput>;
}, TContext>;
export declare const getGetForecastCashSignalUrl: (params?: GetForecastCashSignalParams) => string;
export declare const getForecastCashSignal: (params?: GetForecastCashSignalParams, options?: RequestInit) => Promise<CashSignal>;
export declare const getGetForecastCashSignalQueryKey: (params?: GetForecastCashSignalParams) => readonly ["/api/forecast/cash-signal", ...GetForecastCashSignalParams[]];
export declare const getGetForecastCashSignalQueryOptions: <TData = Awaited<ReturnType<typeof getForecastCashSignal>>, TError = ErrorType<unknown>>(params?: GetForecastCashSignalParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getForecastCashSignal>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getForecastCashSignal>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetForecastCashSignalQueryResult = NonNullable<Awaited<ReturnType<typeof getForecastCashSignal>>>;
export type GetForecastCashSignalQueryError = ErrorType<unknown>;
export declare function useGetForecastCashSignal<TData = Awaited<ReturnType<typeof getForecastCashSignal>>, TError = ErrorType<unknown>>(params?: GetForecastCashSignalParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getForecastCashSignal>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * Returns a deterministic schedule of avalanche extra payments
across the next ~12 months (one per safe paycheck-to-paycheck
window) plus a Claude-written narrative. The narrative is cached
on a hash of the deterministic facts; pass `refresh=true` to force
a fresh regeneration.

 * @summary AI-driven multi-date avalanche extra-payment schedule
 */
export declare const getGetForecastAvalancheScheduleUrl: (params?: GetForecastAvalancheScheduleParams) => string;
export declare const getForecastAvalancheSchedule: (params?: GetForecastAvalancheScheduleParams, options?: RequestInit) => Promise<AvalancheSchedule>;
export declare const getGetForecastAvalancheScheduleQueryKey: (params?: GetForecastAvalancheScheduleParams) => readonly ["/api/forecast/avalanche-schedule", ...GetForecastAvalancheScheduleParams[]];
export declare const getGetForecastAvalancheScheduleQueryOptions: <TData = Awaited<ReturnType<typeof getForecastAvalancheSchedule>>, TError = ErrorType<unknown>>(params?: GetForecastAvalancheScheduleParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getForecastAvalancheSchedule>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getForecastAvalancheSchedule>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetForecastAvalancheScheduleQueryResult = NonNullable<Awaited<ReturnType<typeof getForecastAvalancheSchedule>>>;
export type GetForecastAvalancheScheduleQueryError = ErrorType<unknown>;
/**
 * @summary AI-driven multi-date avalanche extra-payment schedule
 */
export declare function useGetForecastAvalancheSchedule<TData = Awaited<ReturnType<typeof getForecastAvalancheSchedule>>, TError = ErrorType<unknown>>(params?: GetForecastAvalancheScheduleParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getForecastAvalancheSchedule>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * Returns a short Claude-written narrative (headline + bullets) for
one Reports tab, grounded in deterministic facts computed from the
household's data. The narrative is cached per tab on a hash of the
facts; pass `refresh=true` to force a fresh regeneration.

 * @summary Per-tab Claude narrative for the Reports page
 */
export declare const getGetReportsAdvisorSummaryUrl: (params: GetReportsAdvisorSummaryParams) => string;
export declare const getReportsAdvisorSummary: (params: GetReportsAdvisorSummaryParams, options?: RequestInit) => Promise<ReportsAdvisorSummary>;
export declare const getGetReportsAdvisorSummaryQueryKey: (params?: GetReportsAdvisorSummaryParams) => readonly ["/api/reports/advisor-summary", ...GetReportsAdvisorSummaryParams[]];
export declare const getGetReportsAdvisorSummaryQueryOptions: <TData = Awaited<ReturnType<typeof getReportsAdvisorSummary>>, TError = ErrorType<unknown>>(params: GetReportsAdvisorSummaryParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getReportsAdvisorSummary>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getReportsAdvisorSummary>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetReportsAdvisorSummaryQueryResult = NonNullable<Awaited<ReturnType<typeof getReportsAdvisorSummary>>>;
export type GetReportsAdvisorSummaryQueryError = ErrorType<unknown>;
/**
 * @summary Per-tab Claude narrative for the Reports page
 */
export declare function useGetReportsAdvisorSummary<TData = Awaited<ReturnType<typeof getReportsAdvisorSummary>>, TError = ErrorType<unknown>>(params: GetReportsAdvisorSummaryParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getReportsAdvisorSummary>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * Returns short Claude-written captions (headline + one-liner) for the
four Banking insight buckets — going well, could improve, cancel
these, and paying-for-but-not-budgeted — grounded in deterministic
facts computed server-side from the household's data. Every dollar
figure is computed in code; the model only writes language. Cached
per household on a hash of the facts; pass `refresh=true` to force
a fresh regeneration.

 * @summary Claude captions for the four Banking insight buckets
 */
export declare const getGetBankingInsightsSummaryUrl: (params?: GetBankingInsightsSummaryParams) => string;
export declare const getBankingInsightsSummary: (params?: GetBankingInsightsSummaryParams, options?: RequestInit) => Promise<BankingInsightsSummary>;
export declare const getGetBankingInsightsSummaryQueryKey: (params?: GetBankingInsightsSummaryParams) => readonly ["/api/banking/insights-summary", ...GetBankingInsightsSummaryParams[]];
export declare const getGetBankingInsightsSummaryQueryOptions: <TData = Awaited<ReturnType<typeof getBankingInsightsSummary>>, TError = ErrorType<unknown>>(params?: GetBankingInsightsSummaryParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getBankingInsightsSummary>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getBankingInsightsSummary>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetBankingInsightsSummaryQueryResult = NonNullable<Awaited<ReturnType<typeof getBankingInsightsSummary>>>;
export type GetBankingInsightsSummaryQueryError = ErrorType<unknown>;
/**
 * @summary Claude captions for the four Banking insight buckets
 */
export declare function useGetBankingInsightsSummary<TData = Awaited<ReturnType<typeof getBankingInsightsSummary>>, TError = ErrorType<unknown>>(params?: GetBankingInsightsSummaryParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getBankingInsightsSummary>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * Returns deterministic Spending facts (real spend, excluded buckets,
uncategorized backlog, by-category, by-merchant, daily, day-of-week,
monthly trends, reimbursable) for the Reports Spending tab. `from`/`to`
are optional (default last 30 days); ranges before the tracking start
are clamped server-side (range.floorApplied = true).

 * @summary Clean merchant-centric Spending facts for the Reports Spending tab
 */
export declare const getGetReportsSpendingFactsUrl: (params?: GetReportsSpendingFactsParams) => string;
export declare const getReportsSpendingFacts: (params?: GetReportsSpendingFactsParams, options?: RequestInit) => Promise<SpendingFacts>;
export declare const getGetReportsSpendingFactsQueryKey: (params?: GetReportsSpendingFactsParams) => readonly ["/api/reports/spending-facts", ...GetReportsSpendingFactsParams[]];
export declare const getGetReportsSpendingFactsQueryOptions: <TData = Awaited<ReturnType<typeof getReportsSpendingFacts>>, TError = ErrorType<unknown>>(params?: GetReportsSpendingFactsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getReportsSpendingFacts>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getReportsSpendingFacts>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetReportsSpendingFactsQueryResult = NonNullable<Awaited<ReturnType<typeof getReportsSpendingFacts>>>;
export type GetReportsSpendingFactsQueryError = ErrorType<unknown>;
/**
 * @summary Clean merchant-centric Spending facts for the Reports Spending tab
 */
export declare function useGetReportsSpendingFacts<TData = Awaited<ReturnType<typeof getReportsSpendingFacts>>, TError = ErrorType<unknown>>(params?: GetReportsSpendingFactsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getReportsSpendingFacts>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * Returns deterministic Behavior facts (days-since-last buckets, no-dining
and coffee-free streaks, fun facts, hourly spending clock, day-of-week
spend, hall of fame) for the Reports Behavior & Fun tab, on top of the
same real-spend definition as Spending. `from`/`to` are optional
(default last 30 days); ranges before the tracking start are clamped
server-side (range.floorApplied = true).

 * @summary Clean personality-driven Behavior facts for the Reports Behavior & Fun tab
 */
export declare const getGetReportsBehaviorFactsUrl: (params?: GetReportsBehaviorFactsParams) => string;
export declare const getReportsBehaviorFacts: (params?: GetReportsBehaviorFactsParams, options?: RequestInit) => Promise<BehaviorFacts>;
export declare const getGetReportsBehaviorFactsQueryKey: (params?: GetReportsBehaviorFactsParams) => readonly ["/api/reports/behavior-facts", ...GetReportsBehaviorFactsParams[]];
export declare const getGetReportsBehaviorFactsQueryOptions: <TData = Awaited<ReturnType<typeof getReportsBehaviorFacts>>, TError = ErrorType<unknown>>(params?: GetReportsBehaviorFactsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getReportsBehaviorFacts>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getReportsBehaviorFacts>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetReportsBehaviorFactsQueryResult = NonNullable<Awaited<ReturnType<typeof getReportsBehaviorFacts>>>;
export type GetReportsBehaviorFactsQueryError = ErrorType<unknown>;
/**
 * @summary Clean personality-driven Behavior facts for the Reports Behavior & Fun tab
 */
export declare function useGetReportsBehaviorFacts<TData = Awaited<ReturnType<typeof getReportsBehaviorFacts>>, TError = ErrorType<unknown>>(params?: GetReportsBehaviorFactsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getReportsBehaviorFacts>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * Returns deterministic, class-aware Budget facts (range, income, bills,
debts, flex with pace/projection/burndown, and a trailing streak board)
for the Reports Budget tab. Every line is classified into
income/debt/bill/flex and judged on its own axis. `monthStart` is
optional (defaults to the current month's first day; normalized to the
first of its month and clamped to the 2026-04-01 floor). `monthsBack`
controls the streak-board window (default 6, clamped 1..12).

 * @summary Clean class-aware Budget facts for the Reports Budget tab
 */
export declare const getGetReportsBudgetFactsUrl: (params?: GetReportsBudgetFactsParams) => string;
export declare const getReportsBudgetFacts: (params?: GetReportsBudgetFactsParams, options?: RequestInit) => Promise<BudgetFacts>;
export declare const getGetReportsBudgetFactsQueryKey: (params?: GetReportsBudgetFactsParams) => readonly ["/api/reports/budget-facts", ...GetReportsBudgetFactsParams[]];
export declare const getGetReportsBudgetFactsQueryOptions: <TData = Awaited<ReturnType<typeof getReportsBudgetFacts>>, TError = ErrorType<unknown>>(params?: GetReportsBudgetFactsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getReportsBudgetFacts>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getReportsBudgetFacts>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetReportsBudgetFactsQueryResult = NonNullable<Awaited<ReturnType<typeof getReportsBudgetFacts>>>;
export type GetReportsBudgetFactsQueryError = ErrorType<unknown>;
/**
 * @summary Clean class-aware Budget facts for the Reports Budget tab
 */
export declare function useGetReportsBudgetFacts<TData = Awaited<ReturnType<typeof getReportsBudgetFacts>>, TError = ErrorType<unknown>>(params?: GetReportsBudgetFactsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getReportsBudgetFacts>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getCloseForecastMonthUrl: () => string;
export declare const closeForecastMonth: (closeForecastMonthBody: CloseForecastMonthBody, options?: RequestInit) => Promise<ForecastClosedMonth>;
export declare const getCloseForecastMonthMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof closeForecastMonth>>, TError, {
        data: BodyType<CloseForecastMonthBody>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof closeForecastMonth>>, TError, {
    data: BodyType<CloseForecastMonthBody>;
}, TContext>;
export type CloseForecastMonthMutationResult = NonNullable<Awaited<ReturnType<typeof closeForecastMonth>>>;
export type CloseForecastMonthMutationBody = BodyType<CloseForecastMonthBody>;
export type CloseForecastMonthMutationError = ErrorType<unknown>;
export declare const useCloseForecastMonth: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof closeForecastMonth>>, TError, {
        data: BodyType<CloseForecastMonthBody>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof closeForecastMonth>>, TError, {
    data: BodyType<CloseForecastMonthBody>;
}, TContext>;
export declare const getReopenForecastMonthUrl: (monthKey: string) => string;
export declare const reopenForecastMonth: (monthKey: string, options?: RequestInit) => Promise<void>;
export declare const getReopenForecastMonthMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof reopenForecastMonth>>, TError, {
        monthKey: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof reopenForecastMonth>>, TError, {
    monthKey: string;
}, TContext>;
export type ReopenForecastMonthMutationResult = NonNullable<Awaited<ReturnType<typeof reopenForecastMonth>>>;
export type ReopenForecastMonthMutationError = ErrorType<unknown>;
export declare const useReopenForecastMonth: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof reopenForecastMonth>>, TError, {
        monthKey: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof reopenForecastMonth>>, TError, {
    monthKey: string;
}, TContext>;
export declare const getGetAmexAnchorUrl: () => string;
export declare const getAmexAnchor: (options?: RequestInit) => Promise<AmexAnchor>;
export declare const getGetAmexAnchorQueryKey: () => readonly ["/api/amex/anchor"];
export declare const getGetAmexAnchorQueryOptions: <TData = Awaited<ReturnType<typeof getAmexAnchor>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getAmexAnchor>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getAmexAnchor>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetAmexAnchorQueryResult = NonNullable<Awaited<ReturnType<typeof getAmexAnchor>>>;
export type GetAmexAnchorQueryError = ErrorType<unknown>;
export declare function useGetAmexAnchor<TData = Awaited<ReturnType<typeof getAmexAnchor>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getAmexAnchor>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getSetAmexAnchorUrl: () => string;
export declare const setAmexAnchor: (amexAnchorInput: AmexAnchorInput, options?: RequestInit) => Promise<AmexAnchor>;
export declare const getSetAmexAnchorMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof setAmexAnchor>>, TError, {
        data: BodyType<AmexAnchorInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof setAmexAnchor>>, TError, {
    data: BodyType<AmexAnchorInput>;
}, TContext>;
export type SetAmexAnchorMutationResult = NonNullable<Awaited<ReturnType<typeof setAmexAnchor>>>;
export type SetAmexAnchorMutationBody = BodyType<AmexAnchorInput>;
export type SetAmexAnchorMutationError = ErrorType<unknown>;
export declare const useSetAmexAnchor: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof setAmexAnchor>>, TError, {
        data: BodyType<AmexAnchorInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof setAmexAnchor>>, TError, {
    data: BodyType<AmexAnchorInput>;
}, TContext>;
export declare const getDeleteAmexAnchorUrl: () => string;
export declare const deleteAmexAnchor: (options?: RequestInit) => Promise<DeleteAmexAnchor200>;
export declare const getDeleteAmexAnchorMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deleteAmexAnchor>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof deleteAmexAnchor>>, TError, void, TContext>;
export type DeleteAmexAnchorMutationResult = NonNullable<Awaited<ReturnType<typeof deleteAmexAnchor>>>;
export type DeleteAmexAnchorMutationError = ErrorType<unknown>;
export declare const useDeleteAmexAnchor: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deleteAmexAnchor>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof deleteAmexAnchor>>, TError, void, TContext>;
/**
 * @summary Per-card weekly charges to pay (Blue/Silver/Gold) for one week.
 */
export declare const getGetAmexWeeklyPayoffUrl: (params?: GetAmexWeeklyPayoffParams) => string;
export declare const getAmexWeeklyPayoff: (params?: GetAmexWeeklyPayoffParams, options?: RequestInit) => Promise<AmexWeeklyPayoff>;
export declare const getGetAmexWeeklyPayoffQueryKey: (params?: GetAmexWeeklyPayoffParams) => readonly ["/api/amex/weekly-payoff", ...GetAmexWeeklyPayoffParams[]];
export declare const getGetAmexWeeklyPayoffQueryOptions: <TData = Awaited<ReturnType<typeof getAmexWeeklyPayoff>>, TError = ErrorType<unknown>>(params?: GetAmexWeeklyPayoffParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getAmexWeeklyPayoff>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getAmexWeeklyPayoff>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetAmexWeeklyPayoffQueryResult = NonNullable<Awaited<ReturnType<typeof getAmexWeeklyPayoff>>>;
export type GetAmexWeeklyPayoffQueryError = ErrorType<unknown>;
/**
 * @summary Per-card weekly charges to pay (Blue/Silver/Gold) for one week.
 */
export declare function useGetAmexWeeklyPayoff<TData = Awaited<ReturnType<typeof getAmexWeeklyPayoff>>, TError = ErrorType<unknown>>(params?: GetAmexWeeklyPayoffParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getAmexWeeklyPayoff>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getListDashboardBudgetsUrl: (params?: ListDashboardBudgetsParams) => string;
export declare const listDashboardBudgets: (params?: ListDashboardBudgetsParams, options?: RequestInit) => Promise<DashboardBudget[]>;
export declare const getListDashboardBudgetsQueryKey: (params?: ListDashboardBudgetsParams) => readonly ["/api/dashboard-budgets", ...ListDashboardBudgetsParams[]];
export declare const getListDashboardBudgetsQueryOptions: <TData = Awaited<ReturnType<typeof listDashboardBudgets>>, TError = ErrorType<unknown>>(params?: ListDashboardBudgetsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listDashboardBudgets>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listDashboardBudgets>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListDashboardBudgetsQueryResult = NonNullable<Awaited<ReturnType<typeof listDashboardBudgets>>>;
export type ListDashboardBudgetsQueryError = ErrorType<unknown>;
export declare function useListDashboardBudgets<TData = Awaited<ReturnType<typeof listDashboardBudgets>>, TError = ErrorType<unknown>>(params?: ListDashboardBudgetsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listDashboardBudgets>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getUpsertDashboardBudgetUrl: () => string;
export declare const upsertDashboardBudget: (dashboardBudgetInput: DashboardBudgetInput, options?: RequestInit) => Promise<DashboardBudget>;
export declare const getUpsertDashboardBudgetMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof upsertDashboardBudget>>, TError, {
        data: BodyType<DashboardBudgetInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof upsertDashboardBudget>>, TError, {
    data: BodyType<DashboardBudgetInput>;
}, TContext>;
export type UpsertDashboardBudgetMutationResult = NonNullable<Awaited<ReturnType<typeof upsertDashboardBudget>>>;
export type UpsertDashboardBudgetMutationBody = BodyType<DashboardBudgetInput>;
export type UpsertDashboardBudgetMutationError = ErrorType<unknown>;
export declare const useUpsertDashboardBudget: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof upsertDashboardBudget>>, TError, {
        data: BodyType<DashboardBudgetInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof upsertDashboardBudget>>, TError, {
    data: BodyType<DashboardBudgetInput>;
}, TContext>;
export declare const getDeleteDashboardBudgetUrl: (params: DeleteDashboardBudgetParams) => string;
export declare const deleteDashboardBudget: (params: DeleteDashboardBudgetParams, options?: RequestInit) => Promise<void>;
export declare const getDeleteDashboardBudgetMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deleteDashboardBudget>>, TError, {
        params: DeleteDashboardBudgetParams;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof deleteDashboardBudget>>, TError, {
    params: DeleteDashboardBudgetParams;
}, TContext>;
export type DeleteDashboardBudgetMutationResult = NonNullable<Awaited<ReturnType<typeof deleteDashboardBudget>>>;
export type DeleteDashboardBudgetMutationError = ErrorType<unknown>;
export declare const useDeleteDashboardBudget: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deleteDashboardBudget>>, TError, {
        params: DeleteDashboardBudgetParams;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof deleteDashboardBudget>>, TError, {
    params: DeleteDashboardBudgetParams;
}, TContext>;
export declare const getListWeeklySettlementsUrl: (params?: ListWeeklySettlementsParams) => string;
export declare const listWeeklySettlements: (params?: ListWeeklySettlementsParams, options?: RequestInit) => Promise<WeeklySettlement[]>;
export declare const getListWeeklySettlementsQueryKey: (params?: ListWeeklySettlementsParams) => readonly ["/api/weekly-settlements", ...ListWeeklySettlementsParams[]];
export declare const getListWeeklySettlementsQueryOptions: <TData = Awaited<ReturnType<typeof listWeeklySettlements>>, TError = ErrorType<unknown>>(params?: ListWeeklySettlementsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listWeeklySettlements>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listWeeklySettlements>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListWeeklySettlementsQueryResult = NonNullable<Awaited<ReturnType<typeof listWeeklySettlements>>>;
export type ListWeeklySettlementsQueryError = ErrorType<unknown>;
export declare function useListWeeklySettlements<TData = Awaited<ReturnType<typeof listWeeklySettlements>>, TError = ErrorType<unknown>>(params?: ListWeeklySettlementsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listWeeklySettlements>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getCloseOutWeekUrl: () => string;
export declare const closeOutWeek: (weeklySettlementInput: WeeklySettlementInput, options?: RequestInit) => Promise<WeeklySettlement>;
export declare const getCloseOutWeekMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof closeOutWeek>>, TError, {
        data: BodyType<WeeklySettlementInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof closeOutWeek>>, TError, {
    data: BodyType<WeeklySettlementInput>;
}, TContext>;
export type CloseOutWeekMutationResult = NonNullable<Awaited<ReturnType<typeof closeOutWeek>>>;
export type CloseOutWeekMutationBody = BodyType<WeeklySettlementInput>;
export type CloseOutWeekMutationError = ErrorType<unknown>;
export declare const useCloseOutWeek: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof closeOutWeek>>, TError, {
        data: BodyType<WeeklySettlementInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof closeOutWeek>>, TError, {
    data: BodyType<WeeklySettlementInput>;
}, TContext>;
export declare const getReopenWeekUrl: (params: ReopenWeekParams) => string;
export declare const reopenWeek: (params: ReopenWeekParams, options?: RequestInit) => Promise<void>;
export declare const getReopenWeekMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof reopenWeek>>, TError, {
        params: ReopenWeekParams;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof reopenWeek>>, TError, {
    params: ReopenWeekParams;
}, TContext>;
export type ReopenWeekMutationResult = NonNullable<Awaited<ReturnType<typeof reopenWeek>>>;
export type ReopenWeekMutationError = ErrorType<unknown>;
export declare const useReopenWeek: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof reopenWeek>>, TError, {
        params: ReopenWeekParams;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof reopenWeek>>, TError, {
    params: ReopenWeekParams;
}, TContext>;
export declare const getListWeeklyDebriefsUrl: (params?: ListWeeklyDebriefsParams) => string;
export declare const listWeeklyDebriefs: (params?: ListWeeklyDebriefsParams, options?: RequestInit) => Promise<WeeklyDebriefList>;
export declare const getListWeeklyDebriefsQueryKey: (params?: ListWeeklyDebriefsParams) => readonly ["/api/debrief/weeks", ...ListWeeklyDebriefsParams[]];
export declare const getListWeeklyDebriefsQueryOptions: <TData = Awaited<ReturnType<typeof listWeeklyDebriefs>>, TError = ErrorType<unknown>>(params?: ListWeeklyDebriefsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listWeeklyDebriefs>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listWeeklyDebriefs>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListWeeklyDebriefsQueryResult = NonNullable<Awaited<ReturnType<typeof listWeeklyDebriefs>>>;
export type ListWeeklyDebriefsQueryError = ErrorType<unknown>;
export declare function useListWeeklyDebriefs<TData = Awaited<ReturnType<typeof listWeeklyDebriefs>>, TError = ErrorType<unknown>>(params?: ListWeeklyDebriefsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listWeeklyDebriefs>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getGetWeeklyDebriefUrl: (weekStart: string) => string;
export declare const getWeeklyDebrief: (weekStart: string, options?: RequestInit) => Promise<WeeklyDebriefDetail>;
export declare const getGetWeeklyDebriefQueryKey: (weekStart: string) => readonly [`/api/debrief/weeks/${string}`];
export declare const getGetWeeklyDebriefQueryOptions: <TData = Awaited<ReturnType<typeof getWeeklyDebrief>>, TError = ErrorType<unknown>>(weekStart: string, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getWeeklyDebrief>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getWeeklyDebrief>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetWeeklyDebriefQueryResult = NonNullable<Awaited<ReturnType<typeof getWeeklyDebrief>>>;
export type GetWeeklyDebriefQueryError = ErrorType<unknown>;
export declare function useGetWeeklyDebrief<TData = Awaited<ReturnType<typeof getWeeklyDebrief>>, TError = ErrorType<unknown>>(weekStart: string, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getWeeklyDebrief>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getLockWeeklyDebriefUrl: (weekStart: string) => string;
export declare const lockWeeklyDebrief: (weekStart: string, options?: RequestInit) => Promise<WeeklyDebriefDetail>;
export declare const getLockWeeklyDebriefMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof lockWeeklyDebrief>>, TError, {
        weekStart: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof lockWeeklyDebrief>>, TError, {
    weekStart: string;
}, TContext>;
export type LockWeeklyDebriefMutationResult = NonNullable<Awaited<ReturnType<typeof lockWeeklyDebrief>>>;
export type LockWeeklyDebriefMutationError = ErrorType<unknown>;
export declare const useLockWeeklyDebrief: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof lockWeeklyDebrief>>, TError, {
        weekStart: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof lockWeeklyDebrief>>, TError, {
    weekStart: string;
}, TContext>;
export declare const getGenerateWeeklyDebriefSummaryUrl: (weekStart: string) => string;
export declare const generateWeeklyDebriefSummary: (weekStart: string, options?: RequestInit) => Promise<WeeklyDebriefDetail>;
export declare const getGenerateWeeklyDebriefSummaryMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof generateWeeklyDebriefSummary>>, TError, {
        weekStart: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof generateWeeklyDebriefSummary>>, TError, {
    weekStart: string;
}, TContext>;
export type GenerateWeeklyDebriefSummaryMutationResult = NonNullable<Awaited<ReturnType<typeof generateWeeklyDebriefSummary>>>;
export type GenerateWeeklyDebriefSummaryMutationError = ErrorType<unknown>;
export declare const useGenerateWeeklyDebriefSummary: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof generateWeeklyDebriefSummary>>, TError, {
        weekStart: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof generateWeeklyDebriefSummary>>, TError, {
    weekStart: string;
}, TContext>;
export declare const getUnlockWeeklyDebriefUrl: (weekStart: string) => string;
export declare const unlockWeeklyDebrief: (weekStart: string, unlockWeeklyDebriefBody: UnlockWeeklyDebriefBody, options?: RequestInit) => Promise<WeeklyDebriefDetail>;
export declare const getUnlockWeeklyDebriefMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof unlockWeeklyDebrief>>, TError, {
        weekStart: string;
        data: BodyType<UnlockWeeklyDebriefBody>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof unlockWeeklyDebrief>>, TError, {
    weekStart: string;
    data: BodyType<UnlockWeeklyDebriefBody>;
}, TContext>;
export type UnlockWeeklyDebriefMutationResult = NonNullable<Awaited<ReturnType<typeof unlockWeeklyDebrief>>>;
export type UnlockWeeklyDebriefMutationBody = BodyType<UnlockWeeklyDebriefBody>;
export type UnlockWeeklyDebriefMutationError = ErrorType<unknown>;
export declare const useUnlockWeeklyDebrief: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof unlockWeeklyDebrief>>, TError, {
        weekStart: string;
        data: BodyType<UnlockWeeklyDebriefBody>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof unlockWeeklyDebrief>>, TError, {
    weekStart: string;
    data: BodyType<UnlockWeeklyDebriefBody>;
}, TContext>;
export declare const getCreatePlaidLinkTokenUrl: () => string;
export declare const createPlaidLinkToken: (options?: RequestInit) => Promise<PlaidLinkToken>;
export declare const getCreatePlaidLinkTokenMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createPlaidLinkToken>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof createPlaidLinkToken>>, TError, void, TContext>;
export type CreatePlaidLinkTokenMutationResult = NonNullable<Awaited<ReturnType<typeof createPlaidLinkToken>>>;
export type CreatePlaidLinkTokenMutationError = ErrorType<unknown>;
export declare const useCreatePlaidLinkToken: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createPlaidLinkToken>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof createPlaidLinkToken>>, TError, void, TContext>;
/**
 * @summary Create a Plaid Link token in update mode for an existing item, so the
user can re-authenticate the bank when Plaid reports
ITEM_LOGIN_REQUIRED (or another re-auth code).

 */
export declare const getCreatePlaidUpdateLinkTokenUrl: () => string;
export declare const createPlaidUpdateLinkToken: (plaidUpdateLinkTokenInput: PlaidUpdateLinkTokenInput, options?: RequestInit) => Promise<PlaidLinkToken>;
export declare const getCreatePlaidUpdateLinkTokenMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createPlaidUpdateLinkToken>>, TError, {
        data: BodyType<PlaidUpdateLinkTokenInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof createPlaidUpdateLinkToken>>, TError, {
    data: BodyType<PlaidUpdateLinkTokenInput>;
}, TContext>;
export type CreatePlaidUpdateLinkTokenMutationResult = NonNullable<Awaited<ReturnType<typeof createPlaidUpdateLinkToken>>>;
export type CreatePlaidUpdateLinkTokenMutationBody = BodyType<PlaidUpdateLinkTokenInput>;
export type CreatePlaidUpdateLinkTokenMutationError = ErrorType<unknown>;
/**
 * @summary Create a Plaid Link token in update mode for an existing item, so the
user can re-authenticate the bank when Plaid reports
ITEM_LOGIN_REQUIRED (or another re-auth code).

 */
export declare const useCreatePlaidUpdateLinkToken: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createPlaidUpdateLinkToken>>, TError, {
        data: BodyType<PlaidUpdateLinkTokenInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof createPlaidUpdateLinkToken>>, TError, {
    data: BodyType<PlaidUpdateLinkTokenInput>;
}, TContext>;
export declare const getExchangePlaidPublicTokenUrl: () => string;
export declare const exchangePlaidPublicToken: (plaidExchangeInput: PlaidExchangeInput, options?: RequestInit) => Promise<PlaidItemDetail>;
export declare const getExchangePlaidPublicTokenMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof exchangePlaidPublicToken>>, TError, {
        data: BodyType<PlaidExchangeInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof exchangePlaidPublicToken>>, TError, {
    data: BodyType<PlaidExchangeInput>;
}, TContext>;
export type ExchangePlaidPublicTokenMutationResult = NonNullable<Awaited<ReturnType<typeof exchangePlaidPublicToken>>>;
export type ExchangePlaidPublicTokenMutationBody = BodyType<PlaidExchangeInput>;
export type ExchangePlaidPublicTokenMutationError = ErrorType<unknown>;
export declare const useExchangePlaidPublicToken: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof exchangePlaidPublicToken>>, TError, {
        data: BodyType<PlaidExchangeInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof exchangePlaidPublicToken>>, TError, {
    data: BodyType<PlaidExchangeInput>;
}, TContext>;
export declare const getListPlaidItemsUrl: () => string;
export declare const listPlaidItems: (options?: RequestInit) => Promise<PlaidItemDetail[]>;
export declare const getListPlaidItemsQueryKey: () => readonly ["/api/plaid/items"];
export declare const getListPlaidItemsQueryOptions: <TData = Awaited<ReturnType<typeof listPlaidItems>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listPlaidItems>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listPlaidItems>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListPlaidItemsQueryResult = NonNullable<Awaited<ReturnType<typeof listPlaidItems>>>;
export type ListPlaidItemsQueryError = ErrorType<unknown>;
export declare function useListPlaidItems<TData = Awaited<ReturnType<typeof listPlaidItems>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listPlaidItems>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary (#725) Clear the `refreshProductDisabledAt` short-circuit stamp
on a single Plaid item so the next manual Sync actually calls
/transactions/refresh. Surfaced as a "Re-enable refresh" link
on the Settings bank tile after a user enables the
`transactions_refresh` add-on on their Plaid Dashboard.
Idempotent — returns the refreshed PlaidItemDetail with
`refreshProductDisabledAt: null`.

 */
export declare const getClearPlaidItemRefreshDisabledUrl: (id: string) => string;
export declare const clearPlaidItemRefreshDisabled: (id: string, options?: RequestInit) => Promise<PlaidItemDetail>;
export declare const getClearPlaidItemRefreshDisabledMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof clearPlaidItemRefreshDisabled>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof clearPlaidItemRefreshDisabled>>, TError, {
    id: string;
}, TContext>;
export type ClearPlaidItemRefreshDisabledMutationResult = NonNullable<Awaited<ReturnType<typeof clearPlaidItemRefreshDisabled>>>;
export type ClearPlaidItemRefreshDisabledMutationError = ErrorType<void>;
/**
 * @summary (#725) Clear the `refreshProductDisabledAt` short-circuit stamp
on a single Plaid item so the next manual Sync actually calls
/transactions/refresh. Surfaced as a "Re-enable refresh" link
on the Settings bank tile after a user enables the
`transactions_refresh` add-on on their Plaid Dashboard.
Idempotent — returns the refreshed PlaidItemDetail with
`refreshProductDisabledAt: null`.

 */
export declare const useClearPlaidItemRefreshDisabled: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof clearPlaidItemRefreshDisabled>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof clearPlaidItemRefreshDisabled>>, TError, {
    id: string;
}, TContext>;
export declare const getDeletePlaidItemUrl: (id: string) => string;
export declare const deletePlaidItem: (id: string, options?: RequestInit) => Promise<void>;
export declare const getDeletePlaidItemMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deletePlaidItem>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof deletePlaidItem>>, TError, {
    id: string;
}, TContext>;
export type DeletePlaidItemMutationResult = NonNullable<Awaited<ReturnType<typeof deletePlaidItem>>>;
export type DeletePlaidItemMutationError = ErrorType<unknown>;
export declare const useDeletePlaidItem: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deletePlaidItem>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof deletePlaidItem>>, TError, {
    id: string;
}, TContext>;
/**
 * @summary (#279) Most recent Plaid sync attempts for a single linked item.
Powers the Settings → Linked banks "Recent activity" expander
so users can spot a flaky bank link (e.g. "failed 4 of the
last 10 syncs") instead of only seeing the latest
`lastSyncError` snapshot. Newest first; capped server-side at
~20 rows.

 */
export declare const getListPlaidSyncAttemptsUrl: (id: string) => string;
export declare const listPlaidSyncAttempts: (id: string, options?: RequestInit) => Promise<PlaidSyncAttemptsResult>;
export declare const getListPlaidSyncAttemptsQueryKey: (id: string) => readonly [`/api/plaid/items/${string}/sync-attempts`];
export declare const getListPlaidSyncAttemptsQueryOptions: <TData = Awaited<ReturnType<typeof listPlaidSyncAttempts>>, TError = ErrorType<void>>(id: string, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listPlaidSyncAttempts>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listPlaidSyncAttempts>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListPlaidSyncAttemptsQueryResult = NonNullable<Awaited<ReturnType<typeof listPlaidSyncAttempts>>>;
export type ListPlaidSyncAttemptsQueryError = ErrorType<void>;
/**
 * @summary (#279) Most recent Plaid sync attempts for a single linked item.
Powers the Settings → Linked banks "Recent activity" expander
so users can spot a flaky bank link (e.g. "failed 4 of the
last 10 syncs") instead of only seeing the latest
`lastSyncError` snapshot. Newest first; capped server-side at
~20 rows.

 */
export declare function useListPlaidSyncAttempts<TData = Awaited<ReturnType<typeof listPlaidSyncAttempts>>, TError = ErrorType<void>>(id: string, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listPlaidSyncAttempts>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary (#361) Override the first-sync `import_cutoff_date` for a
single Plaid account. Allowed only while
`firstSyncCompletedAt` is still null — once the first sync
has stamped that timestamp the gate is permanently off and a
later override would silently do nothing (returns 409
instead). Pass `null` to clear the cutoff so the first sync
inserts every row Plaid returns.

 */
export declare const getUpdatePlaidImportCutoffDateUrl: (id: string) => string;
export declare const updatePlaidImportCutoffDate: (id: string, updatePlaidImportCutoffDateBody: UpdatePlaidImportCutoffDateBody, options?: RequestInit) => Promise<UpdatePlaidImportCutoffDate200>;
export declare const getUpdatePlaidImportCutoffDateMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updatePlaidImportCutoffDate>>, TError, {
        id: string;
        data: BodyType<UpdatePlaidImportCutoffDateBody>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof updatePlaidImportCutoffDate>>, TError, {
    id: string;
    data: BodyType<UpdatePlaidImportCutoffDateBody>;
}, TContext>;
export type UpdatePlaidImportCutoffDateMutationResult = NonNullable<Awaited<ReturnType<typeof updatePlaidImportCutoffDate>>>;
export type UpdatePlaidImportCutoffDateMutationBody = BodyType<UpdatePlaidImportCutoffDateBody>;
export type UpdatePlaidImportCutoffDateMutationError = ErrorType<void>;
/**
 * @summary (#361) Override the first-sync `import_cutoff_date` for a
single Plaid account. Allowed only while
`firstSyncCompletedAt` is still null — once the first sync
has stamped that timestamp the gate is permanently off and a
later override would silently do nothing (returns 409
instead). Pass `null` to clear the cutoff so the first sync
inserts every row Plaid returns.

 */
export declare const useUpdatePlaidImportCutoffDate: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updatePlaidImportCutoffDate>>, TError, {
        id: string;
        data: BodyType<UpdatePlaidImportCutoffDateBody>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof updatePlaidImportCutoffDate>>, TError, {
    id: string;
    data: BodyType<UpdatePlaidImportCutoffDateBody>;
}, TContext>;
/**
 * @summary (#274) Persist the user's dismissal of the dashboard "bank
consent expiring soon" banner for this item. The server stamps
`consentWarningDismissedForCutoff` with the current
`consentExpirationAt`, so the alert stays hidden across page
reloads but re-surfaces automatically if Plaid moves the
cutoff (e.g. after a successful re-consent).

 */
export declare const getDismissPlaidExpirationWarningUrl: (id: string) => string;
export declare const dismissPlaidExpirationWarning: (id: string, options?: RequestInit) => Promise<PlaidItemDetail>;
export declare const getDismissPlaidExpirationWarningMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof dismissPlaidExpirationWarning>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof dismissPlaidExpirationWarning>>, TError, {
    id: string;
}, TContext>;
export type DismissPlaidExpirationWarningMutationResult = NonNullable<Awaited<ReturnType<typeof dismissPlaidExpirationWarning>>>;
export type DismissPlaidExpirationWarningMutationError = ErrorType<unknown>;
/**
 * @summary (#274) Persist the user's dismissal of the dashboard "bank
consent expiring soon" banner for this item. The server stamps
`consentWarningDismissedForCutoff` with the current
`consentExpirationAt`, so the alert stays hidden across page
reloads but re-surfaces automatically if Plaid moves the
cutoff (e.g. after a successful re-consent).

 */
export declare const useDismissPlaidExpirationWarning: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof dismissPlaidExpirationWarning>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof dismissPlaidExpirationWarning>>, TError, {
    id: string;
}, TContext>;
export declare const getSyncPlaidTransactionsUrl: () => string;
export declare const syncPlaidTransactions: (plaidSyncInput?: PlaidSyncInput, options?: RequestInit) => Promise<PlaidSyncResult>;
export declare const getSyncPlaidTransactionsMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof syncPlaidTransactions>>, TError, {
        data: BodyType<PlaidSyncInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof syncPlaidTransactions>>, TError, {
    data: BodyType<PlaidSyncInput>;
}, TContext>;
export type SyncPlaidTransactionsMutationResult = NonNullable<Awaited<ReturnType<typeof syncPlaidTransactions>>>;
export type SyncPlaidTransactionsMutationBody = BodyType<PlaidSyncInput>;
export type SyncPlaidTransactionsMutationError = ErrorType<unknown>;
export declare const useSyncPlaidTransactions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof syncPlaidTransactions>>, TError, {
        data: BodyType<PlaidSyncInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof syncPlaidTransactions>>, TError, {
    data: BodyType<PlaidSyncInput>;
}, TContext>;
export declare const getGetPlaidEnvironmentUrl: () => string;
export declare const getPlaidEnvironment: (options?: RequestInit) => Promise<PlaidEnvironmentInfo>;
export declare const getGetPlaidEnvironmentQueryKey: () => readonly ["/api/plaid/environment"];
export declare const getGetPlaidEnvironmentQueryOptions: <TData = Awaited<ReturnType<typeof getPlaidEnvironment>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getPlaidEnvironment>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getPlaidEnvironment>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetPlaidEnvironmentQueryResult = NonNullable<Awaited<ReturnType<typeof getPlaidEnvironment>>>;
export type GetPlaidEnvironmentQueryError = ErrorType<unknown>;
export declare function useGetPlaidEnvironment<TData = Awaited<ReturnType<typeof getPlaidEnvironment>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getPlaidEnvironment>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary (#253) Manually refresh `consent_expiration_time` for every Plaid
item belonging to the caller. Same code path as the daily 03:17
UTC cron job — exposed so users can self-serve from Settings when
they suspect the disconnect-date countdown is stale, without
waiting up to 24h for the next scheduled run.

 */
export declare const getRefreshPlaidConsentExpirationsUrl: () => string;
export declare const refreshPlaidConsentExpirations: (options?: RequestInit) => Promise<PlaidConsentRefreshResult>;
export declare const getRefreshPlaidConsentExpirationsMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof refreshPlaidConsentExpirations>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof refreshPlaidConsentExpirations>>, TError, void, TContext>;
export type RefreshPlaidConsentExpirationsMutationResult = NonNullable<Awaited<ReturnType<typeof refreshPlaidConsentExpirations>>>;
export type RefreshPlaidConsentExpirationsMutationError = ErrorType<unknown>;
/**
 * @summary (#253) Manually refresh `consent_expiration_time` for every Plaid
item belonging to the caller. Same code path as the daily 03:17
UTC cron job — exposed so users can self-serve from Settings when
they suspect the disconnect-date countdown is stale, without
waiting up to 24h for the next scheduled run.

 */
export declare const useRefreshPlaidConsentExpirations: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof refreshPlaidConsentExpirations>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof refreshPlaidConsentExpirations>>, TError, void, TContext>;
/**
 * @summary (#397, #550) Owner-only manual trigger for the daily Plaid
malformed-access-token health check. Same code path the 03:02
UTC cron runs unattended; exposed so an operator who just
investigated a spike alert can re-run the sweep from the app
and see the refreshed `{ scanned, flagged, flaggedItems }`
summary plus the re-evaluated alert outcome inline, instead of
waiting for tomorrow morning's cron tick.

 */
export declare const getRunPlaidMalformedTokenSweepUrl: () => string;
export declare const runPlaidMalformedTokenSweep: (options?: RequestInit) => Promise<PlaidMalformedTokenSweepResult>;
export declare const getRunPlaidMalformedTokenSweepMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof runPlaidMalformedTokenSweep>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof runPlaidMalformedTokenSweep>>, TError, void, TContext>;
export type RunPlaidMalformedTokenSweepMutationResult = NonNullable<Awaited<ReturnType<typeof runPlaidMalformedTokenSweep>>>;
export type RunPlaidMalformedTokenSweepMutationError = ErrorType<unknown>;
/**
 * @summary (#397, #550) Owner-only manual trigger for the daily Plaid
malformed-access-token health check. Same code path the 03:02
UTC cron runs unattended; exposed so an operator who just
investigated a spike alert can re-run the sweep from the app
and see the refreshed `{ scanned, flagged, flaggedItems }`
summary plus the re-evaluated alert outcome inline, instead of
waiting for tomorrow morning's cron tick.

 */
export declare const useRunPlaidMalformedTokenSweep: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof runPlaidMalformedTokenSweep>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof runPlaidMalformedTokenSweep>>, TError, void, TContext>;
export declare const getCleanupNonProdPlaidItemsUrl: () => string;
export declare const cleanupNonProdPlaidItems: (options?: RequestInit) => Promise<CleanupNonProdPlaidItems200>;
export declare const getCleanupNonProdPlaidItemsMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof cleanupNonProdPlaidItems>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof cleanupNonProdPlaidItems>>, TError, void, TContext>;
export type CleanupNonProdPlaidItemsMutationResult = NonNullable<Awaited<ReturnType<typeof cleanupNonProdPlaidItems>>>;
export type CleanupNonProdPlaidItemsMutationError = ErrorType<unknown>;
export declare const useCleanupNonProdPlaidItems: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof cleanupNonProdPlaidItems>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof cleanupNonProdPlaidItems>>, TError, void, TContext>;
export declare const getGetBillsSummaryUrl: (params?: GetBillsSummaryParams) => string;
export declare const getBillsSummary: (params?: GetBillsSummaryParams, options?: RequestInit) => Promise<BillsSummary>;
export declare const getGetBillsSummaryQueryKey: (params?: GetBillsSummaryParams) => readonly ["/api/bills/summary", ...GetBillsSummaryParams[]];
export declare const getGetBillsSummaryQueryOptions: <TData = Awaited<ReturnType<typeof getBillsSummary>>, TError = ErrorType<unknown>>(params?: GetBillsSummaryParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getBillsSummary>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getBillsSummary>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetBillsSummaryQueryResult = NonNullable<Awaited<ReturnType<typeof getBillsSummary>>>;
export type GetBillsSummaryQueryError = ErrorType<unknown>;
export declare function useGetBillsSummary<TData = Awaited<ReturnType<typeof getBillsSummary>>, TError = ErrorType<unknown>>(params?: GetBillsSummaryParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getBillsSummary>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getImportWorkbookUrl: () => string;
export declare const importWorkbook: (importWorkbookBody: ImportWorkbookBody, options?: RequestInit) => Promise<ImportSummary>;
export declare const getImportWorkbookMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof importWorkbook>>, TError, {
        data: BodyType<ImportWorkbookBody>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof importWorkbook>>, TError, {
    data: BodyType<ImportWorkbookBody>;
}, TContext>;
export type ImportWorkbookMutationResult = NonNullable<Awaited<ReturnType<typeof importWorkbook>>>;
export type ImportWorkbookMutationBody = BodyType<ImportWorkbookBody>;
export type ImportWorkbookMutationError = ErrorType<unknown>;
export declare const useImportWorkbook: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof importWorkbook>>, TError, {
        data: BodyType<ImportWorkbookBody>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof importWorkbook>>, TError, {
    data: BodyType<ImportWorkbookBody>;
}, TContext>;
/**
 * @summary Returns information about the current authenticated user, including whether they are the owner.
 */
export declare const getGetMeUrl: () => string;
export declare const getMe: (options?: RequestInit) => Promise<MeResponse>;
export declare const getGetMeQueryKey: () => readonly ["/api/me"];
export declare const getGetMeQueryOptions: <TData = Awaited<ReturnType<typeof getMe>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getMe>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getMe>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetMeQueryResult = NonNullable<Awaited<ReturnType<typeof getMe>>>;
export type GetMeQueryError = ErrorType<unknown>;
/**
 * @summary Returns information about the current authenticated user, including whether they are the owner.
 */
export declare function useGetMe<TData = Awaited<ReturnType<typeof getMe>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getMe>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary Returns the signed-in user's per-user UI preferences.
 */
export declare const getGetUiPreferencesUrl: () => string;
export declare const getUiPreferences: (options?: RequestInit) => Promise<UiPreferences>;
export declare const getGetUiPreferencesQueryKey: () => readonly ["/api/me/ui-preferences"];
export declare const getGetUiPreferencesQueryOptions: <TData = Awaited<ReturnType<typeof getUiPreferences>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getUiPreferences>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getUiPreferences>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetUiPreferencesQueryResult = NonNullable<Awaited<ReturnType<typeof getUiPreferences>>>;
export type GetUiPreferencesQueryError = ErrorType<unknown>;
/**
 * @summary Returns the signed-in user's per-user UI preferences.
 */
export declare function useGetUiPreferences<TData = Awaited<ReturnType<typeof getUiPreferences>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getUiPreferences>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary Updates the signed-in user's per-user UI preferences (merged into the existing record).
 */
export declare const getUpdateUiPreferencesUrl: () => string;
export declare const updateUiPreferences: (uiPreferences: UiPreferences, options?: RequestInit) => Promise<UiPreferences>;
export declare const getUpdateUiPreferencesMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateUiPreferences>>, TError, {
        data: BodyType<UiPreferences>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof updateUiPreferences>>, TError, {
    data: BodyType<UiPreferences>;
}, TContext>;
export type UpdateUiPreferencesMutationResult = NonNullable<Awaited<ReturnType<typeof updateUiPreferences>>>;
export type UpdateUiPreferencesMutationBody = BodyType<UiPreferences>;
export type UpdateUiPreferencesMutationError = ErrorType<unknown>;
/**
 * @summary Updates the signed-in user's per-user UI preferences (merged into the existing record).
 */
export declare const useUpdateUiPreferences: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateUiPreferences>>, TError, {
        data: BodyType<UiPreferences>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof updateUiPreferences>>, TError, {
    data: BodyType<UiPreferences>;
}, TContext>;
/**
 * @summary List all invitations (owner only).
 */
export declare const getListInvitationsUrl: () => string;
export declare const listInvitations: (options?: RequestInit) => Promise<Invitation[]>;
export declare const getListInvitationsQueryKey: () => readonly ["/api/invitations"];
export declare const getListInvitationsQueryOptions: <TData = Awaited<ReturnType<typeof listInvitations>>, TError = ErrorType<void>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listInvitations>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listInvitations>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListInvitationsQueryResult = NonNullable<Awaited<ReturnType<typeof listInvitations>>>;
export type ListInvitationsQueryError = ErrorType<void>;
/**
 * @summary List all invitations (owner only).
 */
export declare function useListInvitations<TData = Awaited<ReturnType<typeof listInvitations>>, TError = ErrorType<void>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listInvitations>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary Send a new invitation by email (owner only).
 */
export declare const getCreateInvitationUrl: () => string;
export declare const createInvitation: (createInvitationInput: CreateInvitationInput, options?: RequestInit) => Promise<Invitation>;
export declare const getCreateInvitationMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createInvitation>>, TError, {
        data: BodyType<CreateInvitationInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof createInvitation>>, TError, {
    data: BodyType<CreateInvitationInput>;
}, TContext>;
export type CreateInvitationMutationResult = NonNullable<Awaited<ReturnType<typeof createInvitation>>>;
export type CreateInvitationMutationBody = BodyType<CreateInvitationInput>;
export type CreateInvitationMutationError = ErrorType<void>;
/**
 * @summary Send a new invitation by email (owner only).
 */
export declare const useCreateInvitation: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createInvitation>>, TError, {
        data: BodyType<CreateInvitationInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof createInvitation>>, TError, {
    data: BodyType<CreateInvitationInput>;
}, TContext>;
/**
 * @summary Revoke a pending invitation (owner only).
 */
export declare const getRevokeInvitationUrl: (id: string) => string;
export declare const revokeInvitation: (id: string, options?: RequestInit) => Promise<Invitation>;
export declare const getRevokeInvitationMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof revokeInvitation>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof revokeInvitation>>, TError, {
    id: string;
}, TContext>;
export type RevokeInvitationMutationResult = NonNullable<Awaited<ReturnType<typeof revokeInvitation>>>;
export type RevokeInvitationMutationError = ErrorType<void>;
/**
 * @summary Revoke a pending invitation (owner only).
 */
export declare const useRevokeInvitation: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof revokeInvitation>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof revokeInvitation>>, TError, {
    id: string;
}, TContext>;
/**
 * @summary Resend a pending invitation (owner only). Revokes the existing invite and creates a new one for the same email.
 */
export declare const getResendInvitationUrl: (id: string) => string;
export declare const resendInvitation: (id: string, options?: RequestInit) => Promise<Invitation>;
export declare const getResendInvitationMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof resendInvitation>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof resendInvitation>>, TError, {
    id: string;
}, TContext>;
export type ResendInvitationMutationResult = NonNullable<Awaited<ReturnType<typeof resendInvitation>>>;
export type ResendInvitationMutationError = ErrorType<void>;
/**
 * @summary Resend a pending invitation (owner only). Revokes the existing invite and creates a new one for the same email.
 */
export declare const useResendInvitation: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof resendInvitation>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof resendInvitation>>, TError, {
    id: string;
}, TContext>;
/**
 * @summary Check whether the given email has a pending invitation. Public endpoint used by the sign-in page to help invited users who try to sign in before accepting their email invite.
 */
export declare const getCheckInvitationUrl: () => string;
export declare const checkInvitation: (checkInvitationInput: CheckInvitationInput, options?: RequestInit) => Promise<CheckInvitationResult>;
export declare const getCheckInvitationMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof checkInvitation>>, TError, {
        data: BodyType<CheckInvitationInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof checkInvitation>>, TError, {
    data: BodyType<CheckInvitationInput>;
}, TContext>;
export type CheckInvitationMutationResult = NonNullable<Awaited<ReturnType<typeof checkInvitation>>>;
export type CheckInvitationMutationBody = BodyType<CheckInvitationInput>;
export type CheckInvitationMutationError = ErrorType<unknown>;
/**
 * @summary Check whether the given email has a pending invitation. Public endpoint used by the sign-in page to help invited users who try to sign in before accepting their email invite.
 */
export declare const useCheckInvitation: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof checkInvitation>>, TError, {
        data: BodyType<CheckInvitationInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof checkInvitation>>, TError, {
    data: BodyType<CheckInvitationInput>;
}, TContext>;
/**
 * @summary List all current members (owner only).
 */
export declare const getListMembersUrl: () => string;
export declare const listMembers: (options?: RequestInit) => Promise<Member[]>;
export declare const getListMembersQueryKey: () => readonly ["/api/members"];
export declare const getListMembersQueryOptions: <TData = Awaited<ReturnType<typeof listMembers>>, TError = ErrorType<void>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listMembers>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listMembers>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListMembersQueryResult = NonNullable<Awaited<ReturnType<typeof listMembers>>>;
export type ListMembersQueryError = ErrorType<void>;
/**
 * @summary List all current members (owner only).
 */
export declare function useListMembers<TData = Awaited<ReturnType<typeof listMembers>>, TError = ErrorType<void>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listMembers>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary Remove a member's access (owner only). Deletes the Clerk user and their profile row.
 */
export declare const getRemoveMemberUrl: (id: string) => string;
export declare const removeMember: (id: string, options?: RequestInit) => Promise<void>;
export declare const getRemoveMemberMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof removeMember>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof removeMember>>, TError, {
    id: string;
}, TContext>;
export type RemoveMemberMutationResult = NonNullable<Awaited<ReturnType<typeof removeMember>>>;
export type RemoveMemberMutationError = ErrorType<void>;
/**
 * @summary Remove a member's access (owner only). Deletes the Clerk user and their profile row.
 */
export declare const useRemoveMember: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof removeMember>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof removeMember>>, TError, {
    id: string;
}, TContext>;
/**
 * @summary Seed the user's Chase checking with April 2026 transactions (idempotent)
 */
export declare const getSeedAprilChaseUrl: () => string;
export declare const seedAprilChase: (options?: RequestInit) => Promise<AprilChaseSeedResult>;
export declare const getSeedAprilChaseMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof seedAprilChase>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof seedAprilChase>>, TError, void, TContext>;
export type SeedAprilChaseMutationResult = NonNullable<Awaited<ReturnType<typeof seedAprilChase>>>;
export type SeedAprilChaseMutationError = ErrorType<unknown>;
/**
 * @summary Seed the user's Chase checking with April 2026 transactions (idempotent)
 */
export declare const useSeedAprilChase: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof seedAprilChase>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof seedAprilChase>>, TError, void, TContext>;
/**
 * Returns a cached (1h TTL) AI-generated observation about the
household's current financial state. The frontend renders this
as a dismissible card on the Dashboard. When the advisor is
disabled (no API key, ADVISOR_ENABLED=false, or no meaningful
data yet), returns `enabled: false` and the UI hides itself.

 * @summary Get a single proactive financial observation for the dashboard
 */
export declare const getGetAdvisorNudgeUrl: () => string;
export declare const getAdvisorNudge: (options?: RequestInit) => Promise<AdvisorNudge>;
export declare const getGetAdvisorNudgeQueryKey: () => readonly ["/api/advisor/nudge"];
export declare const getGetAdvisorNudgeQueryOptions: <TData = Awaited<ReturnType<typeof getAdvisorNudge>>, TError = ErrorType<void>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getAdvisorNudge>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getAdvisorNudge>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetAdvisorNudgeQueryResult = NonNullable<Awaited<ReturnType<typeof getAdvisorNudge>>>;
export type GetAdvisorNudgeQueryError = ErrorType<void>;
/**
 * @summary Get a single proactive financial observation for the dashboard
 */
export declare function useGetAdvisorNudge<TData = Awaited<ReturnType<typeof getAdvisorNudge>>, TError = ErrorType<void>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getAdvisorNudge>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * Stateless chat endpoint. The client passes the full conversation
history each turn; the server tacks on the latest message and
calls the model. The server augments the system prompt with a
live snapshot of the household's budget, cashflow, and debts.

 * @summary Send a message to the AI budget advisor
 */
export declare const getPostAdvisorChatUrl: () => string;
export declare const postAdvisorChat: (advisorChatRequest: AdvisorChatRequest, options?: RequestInit) => Promise<AdvisorChatResponse>;
export declare const getPostAdvisorChatMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof postAdvisorChat>>, TError, {
        data: BodyType<AdvisorChatRequest>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof postAdvisorChat>>, TError, {
    data: BodyType<AdvisorChatRequest>;
}, TContext>;
export type PostAdvisorChatMutationResult = NonNullable<Awaited<ReturnType<typeof postAdvisorChat>>>;
export type PostAdvisorChatMutationBody = BodyType<AdvisorChatRequest>;
export type PostAdvisorChatMutationError = ErrorType<void>;
/**
 * @summary Send a message to the AI budget advisor
 */
export declare const usePostAdvisorChat: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof postAdvisorChat>>, TError, {
        data: BodyType<AdvisorChatRequest>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof postAdvisorChat>>, TError, {
    data: BodyType<AdvisorChatRequest>;
}, TContext>;
/**
 * Undoes the effects of an advisor tool call within a 5-minute window
of its execution. Only tools registered with an undoHandler are
undoable. Household-scoped — a request can only undo tool calls
attached to its own household's audit log.

 * @summary Reverse a previously executed advisor tool call
 */
export declare const getPostAdvisorUndoUrl: (auditLogId: string) => string;
export declare const postAdvisorUndo: (auditLogId: string, options?: RequestInit) => Promise<AdvisorUndoResponse>;
export declare const getPostAdvisorUndoMutationOptions: <TError = ErrorType<AdvisorUndoErrorResponse | void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof postAdvisorUndo>>, TError, {
        auditLogId: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof postAdvisorUndo>>, TError, {
    auditLogId: string;
}, TContext>;
export type PostAdvisorUndoMutationResult = NonNullable<Awaited<ReturnType<typeof postAdvisorUndo>>>;
export type PostAdvisorUndoMutationError = ErrorType<AdvisorUndoErrorResponse | void>;
/**
 * @summary Reverse a previously executed advisor tool call
 */
export declare const usePostAdvisorUndo: <TError = ErrorType<AdvisorUndoErrorResponse | void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof postAdvisorUndo>>, TError, {
        auditLogId: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof postAdvisorUndo>>, TError, {
    auditLogId: string;
}, TContext>;
/**
 * Confirms a destructive tool proposal created during a chat turn.
Re-runs the tool with the originally proposed arguments, writes
an audit log row, and returns the execution result.

 * @summary Confirm and execute a pending advisor proposal
 */
export declare const getPostAdvisorProposalConfirmUrl: (proposalId: string) => string;
export declare const postAdvisorProposalConfirm: (proposalId: string, options?: RequestInit) => Promise<AdvisorProposalResolveResponse>;
export declare const getPostAdvisorProposalConfirmMutationOptions: <TError = ErrorType<AdvisorProposalErrorResponse | void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof postAdvisorProposalConfirm>>, TError, {
        proposalId: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof postAdvisorProposalConfirm>>, TError, {
    proposalId: string;
}, TContext>;
export type PostAdvisorProposalConfirmMutationResult = NonNullable<Awaited<ReturnType<typeof postAdvisorProposalConfirm>>>;
export type PostAdvisorProposalConfirmMutationError = ErrorType<AdvisorProposalErrorResponse | void>;
/**
 * @summary Confirm and execute a pending advisor proposal
 */
export declare const usePostAdvisorProposalConfirm: <TError = ErrorType<AdvisorProposalErrorResponse | void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof postAdvisorProposalConfirm>>, TError, {
        proposalId: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof postAdvisorProposalConfirm>>, TError, {
    proposalId: string;
}, TContext>;
/**
 * Marks a destructive tool proposal as cancelled without executing
it. Tools that were already cancelled or executed cannot be
cancelled again.

 * @summary Cancel a pending advisor proposal
 */
export declare const getPostAdvisorProposalCancelUrl: (proposalId: string) => string;
export declare const postAdvisorProposalCancel: (proposalId: string, options?: RequestInit) => Promise<AdvisorProposalResolveResponse>;
export declare const getPostAdvisorProposalCancelMutationOptions: <TError = ErrorType<AdvisorProposalErrorResponse | void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof postAdvisorProposalCancel>>, TError, {
        proposalId: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof postAdvisorProposalCancel>>, TError, {
    proposalId: string;
}, TContext>;
export type PostAdvisorProposalCancelMutationResult = NonNullable<Awaited<ReturnType<typeof postAdvisorProposalCancel>>>;
export type PostAdvisorProposalCancelMutationError = ErrorType<AdvisorProposalErrorResponse | void>;
/**
 * @summary Cancel a pending advisor proposal
 */
export declare const usePostAdvisorProposalCancel: <TError = ErrorType<AdvisorProposalErrorResponse | void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof postAdvisorProposalCancel>>, TError, {
        proposalId: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof postAdvisorProposalCancel>>, TError, {
    proposalId: string;
}, TContext>;
export {};
//# sourceMappingURL=api.d.ts.map