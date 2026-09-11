import type { DataTag, DefinedInitialDataOptions, DefinedUseInfiniteQueryResult, DefinedUseQueryResult, InfiniteData, QueryClient, QueryKey, UndefinedInitialDataOptions, UseInfiniteQueryOptions, UseInfiniteQueryResult, UseMutationOptions, UseMutationResult, UseQueryOptions, UseQueryResult } from "@tanstack/react-query";
import type { BulkReviewMatchingInput, BulkReviewMatchingResult, BulkReviewMatchingTransactions409, GetTransactionsBalancesParams, GetTransactionsLedgerParams, LedgerPage, TransactionBalances, UiPreferences } from "./api.schemas";
import { customFetch } from "../../custom-fetch";
import type { ErrorType, BodyType } from "../../custom-fetch";
type AwaitedInput<T> = PromiseLike<T> | T;
type Awaited<O> = O extends AwaitedInput<infer T> ? T : never;
type SecondParameter<T extends (...args: never) => unknown> = Parameters<T>[1];
/**
 * @summary (PR13) One page of the bank ledger, newest first. The server settles
the scope: the Plaid account the snapshot resolves to, its
same-institution mask twins, and manual rows (no Plaid account, source
neither "amex" nor "plaid:*"), which is the rule the bank balance reads
by. A client must not hide rows the register counts. Ordered by
occurredOn desc, occurredAt desc (nulls last), id desc, and paged with
an opaque keyset cursor. Each row carries what it moves the balance by
(`balanceAmount`, `countsInBalance`, `balanceReason`), from the cash
rule over the account's whole history. `matchingCount` counts every
row matching the filters; `totals` and `review` cover every row
matching the filters other than `reviewed`. `runningBalance`,
`balanceStart`, `balanceEnd`, `balanceToday` and `anchor` never depend
on the non-date filters or the page, and no balance is given for a day
after today. The boolean filters take the strings "true" or "false";
anything else is a 400.

 */
export declare const getGetTransactionsLedgerUrl: (params?: GetTransactionsLedgerParams) => string;
export declare const getTransactionsLedger: (params?: GetTransactionsLedgerParams, options?: RequestInit) => Promise<LedgerPage>;
export declare const getGetTransactionsLedgerInfiniteQueryKey: (params?: GetTransactionsLedgerParams) => readonly ["infinite", "/api/transactions/ledger", ...GetTransactionsLedgerParams[]];
export declare const getGetTransactionsLedgerQueryKey: (params?: GetTransactionsLedgerParams) => readonly ["/api/transactions/ledger", ...GetTransactionsLedgerParams[]];
export declare const getGetTransactionsLedgerInfiniteQueryOptions: <TData = InfiniteData<Awaited<ReturnType<typeof getTransactionsLedger>>, GetTransactionsLedgerParams["cursor"]>, TError = ErrorType<void>>(params?: GetTransactionsLedgerParams, options?: {
    query?: Partial<UseInfiniteQueryOptions<Awaited<ReturnType<typeof getTransactionsLedger>>, TError, TData, QueryKey, GetTransactionsLedgerParams["cursor"]>>;
    request?: SecondParameter<typeof customFetch>;
}) => UseInfiniteQueryOptions<Awaited<ReturnType<typeof getTransactionsLedger>>, TError, TData, QueryKey, GetTransactionsLedgerParams["cursor"]> & {
    queryKey: DataTag<QueryKey, TData, TError>;
};
export type GetTransactionsLedgerInfiniteQueryResult = NonNullable<Awaited<ReturnType<typeof getTransactionsLedger>>>;
export type GetTransactionsLedgerInfiniteQueryError = ErrorType<void>;
export declare function useGetTransactionsLedgerInfinite<TData = InfiniteData<Awaited<ReturnType<typeof getTransactionsLedger>>, GetTransactionsLedgerParams["cursor"]>, TError = ErrorType<void>>(params: undefined | GetTransactionsLedgerParams, options: {
    query: Partial<UseInfiniteQueryOptions<Awaited<ReturnType<typeof getTransactionsLedger>>, TError, TData, QueryKey, GetTransactionsLedgerParams["cursor"]>> & Pick<DefinedInitialDataOptions<Awaited<ReturnType<typeof getTransactionsLedger>>, TError, Awaited<ReturnType<typeof getTransactionsLedger>>, QueryKey>, "initialData">;
    request?: SecondParameter<typeof customFetch>;
}, queryClient?: QueryClient): DefinedUseInfiniteQueryResult<TData, TError> & {
    queryKey: DataTag<QueryKey, TData, TError>;
};
export declare function useGetTransactionsLedgerInfinite<TData = InfiniteData<Awaited<ReturnType<typeof getTransactionsLedger>>, GetTransactionsLedgerParams["cursor"]>, TError = ErrorType<void>>(params?: GetTransactionsLedgerParams, options?: {
    query?: Partial<UseInfiniteQueryOptions<Awaited<ReturnType<typeof getTransactionsLedger>>, TError, TData, QueryKey, GetTransactionsLedgerParams["cursor"]>> & Pick<UndefinedInitialDataOptions<Awaited<ReturnType<typeof getTransactionsLedger>>, TError, Awaited<ReturnType<typeof getTransactionsLedger>>, QueryKey>, "initialData">;
    request?: SecondParameter<typeof customFetch>;
}, queryClient?: QueryClient): UseInfiniteQueryResult<TData, TError> & {
    queryKey: DataTag<QueryKey, TData, TError>;
};
export declare function useGetTransactionsLedgerInfinite<TData = InfiniteData<Awaited<ReturnType<typeof getTransactionsLedger>>, GetTransactionsLedgerParams["cursor"]>, TError = ErrorType<void>>(params?: GetTransactionsLedgerParams, options?: {
    query?: Partial<UseInfiniteQueryOptions<Awaited<ReturnType<typeof getTransactionsLedger>>, TError, TData, QueryKey, GetTransactionsLedgerParams["cursor"]>>;
    request?: SecondParameter<typeof customFetch>;
}, queryClient?: QueryClient): UseInfiniteQueryResult<TData, TError> & {
    queryKey: DataTag<QueryKey, TData, TError>;
};
export declare const getGetTransactionsLedgerQueryOptions: <TData = Awaited<ReturnType<typeof getTransactionsLedger>>, TError = ErrorType<void>>(params?: GetTransactionsLedgerParams, options?: {
    query?: Partial<UseQueryOptions<Awaited<ReturnType<typeof getTransactionsLedger>>, TError, TData>>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getTransactionsLedger>>, TError, TData> & {
    queryKey: DataTag<QueryKey, TData, TError>;
};
export type GetTransactionsLedgerQueryResult = NonNullable<Awaited<ReturnType<typeof getTransactionsLedger>>>;
export type GetTransactionsLedgerQueryError = ErrorType<void>;
export declare function useGetTransactionsLedger<TData = Awaited<ReturnType<typeof getTransactionsLedger>>, TError = ErrorType<void>>(params: undefined | GetTransactionsLedgerParams, options: {
    query: Partial<UseQueryOptions<Awaited<ReturnType<typeof getTransactionsLedger>>, TError, TData>> & Pick<DefinedInitialDataOptions<Awaited<ReturnType<typeof getTransactionsLedger>>, TError, Awaited<ReturnType<typeof getTransactionsLedger>>>, "initialData">;
    request?: SecondParameter<typeof customFetch>;
}, queryClient?: QueryClient): DefinedUseQueryResult<TData, TError> & {
    queryKey: DataTag<QueryKey, TData, TError>;
};
export declare function useGetTransactionsLedger<TData = Awaited<ReturnType<typeof getTransactionsLedger>>, TError = ErrorType<void>>(params?: GetTransactionsLedgerParams, options?: {
    query?: Partial<UseQueryOptions<Awaited<ReturnType<typeof getTransactionsLedger>>, TError, TData>> & Pick<UndefinedInitialDataOptions<Awaited<ReturnType<typeof getTransactionsLedger>>, TError, Awaited<ReturnType<typeof getTransactionsLedger>>>, "initialData">;
    request?: SecondParameter<typeof customFetch>;
}, queryClient?: QueryClient): UseQueryResult<TData, TError> & {
    queryKey: DataTag<QueryKey, TData, TError>;
};
export declare function useGetTransactionsLedger<TData = Awaited<ReturnType<typeof getTransactionsLedger>>, TError = ErrorType<void>>(params?: GetTransactionsLedgerParams, options?: {
    query?: Partial<UseQueryOptions<Awaited<ReturnType<typeof getTransactionsLedger>>, TError, TData>>;
    request?: SecondParameter<typeof customFetch>;
}, queryClient?: QueryClient): UseQueryResult<TData, TError> & {
    queryKey: DataTag<QueryKey, TData, TError>;
};
/**
 * @summary (PR13) End-of-day balances of the ledger account for up to 120 dates,
on the same register as GET /transactions/ledger: a date's balance is
the runningBalance after the last account row dated on or before it.
Today's equals the bank balance on the spine. A date after today, and
every date without a bank snapshot, has a null balance: the register
is not a projection.

 */
export declare const getGetTransactionsBalancesUrl: (params: GetTransactionsBalancesParams) => string;
export declare const getTransactionsBalances: (params: GetTransactionsBalancesParams, options?: RequestInit) => Promise<TransactionBalances>;
export declare const getGetTransactionsBalancesQueryKey: (params?: GetTransactionsBalancesParams) => readonly ["/api/transactions/balances", ...GetTransactionsBalancesParams[]];
export declare const getGetTransactionsBalancesQueryOptions: <TData = Awaited<ReturnType<typeof getTransactionsBalances>>, TError = ErrorType<void>>(params: GetTransactionsBalancesParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getTransactionsBalances>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getTransactionsBalances>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetTransactionsBalancesQueryResult = NonNullable<Awaited<ReturnType<typeof getTransactionsBalances>>>;
export type GetTransactionsBalancesQueryError = ErrorType<void>;
/**
 * @summary (PR13) End-of-day balances of the ledger account for up to 120 dates,
on the same register as GET /transactions/ledger: a date's balance is
the runningBalance after the last account row dated on or before it.
Today's equals the bank balance on the spine. A date after today, and
every date without a bank snapshot, has a null balance: the register
is not a projection.

 */
export declare function useGetTransactionsBalances<TData = Awaited<ReturnType<typeof getTransactionsBalances>>, TError = ErrorType<void>>(params: GetTransactionsBalancesParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getTransactionsBalances>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary (PR13) Mark every ledger row matching a filter reviewed (or not) in
one request, without the client holding the ids. The filter is the
ledger's, `reviewed` included. `expectedCount` is the `matchingCount`
the client showed: when a different number of rows matches now, the
request is refused with 409 and nothing changes. More than 1,000
matching rows is a 400. Rows already in the target state count in
`matched` but not in `updated`.

 */
export declare const getBulkReviewMatchingTransactionsUrl: () => string;
export declare const bulkReviewMatchingTransactions: (bulkReviewMatchingInput: BulkReviewMatchingInput, options?: RequestInit) => Promise<BulkReviewMatchingResult>;
export declare const getBulkReviewMatchingTransactionsMutationOptions: <TError = ErrorType<void | BulkReviewMatchingTransactions409>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof bulkReviewMatchingTransactions>>, TError, {
        data: BodyType<BulkReviewMatchingInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof bulkReviewMatchingTransactions>>, TError, {
    data: BodyType<BulkReviewMatchingInput>;
}, TContext>;
export type BulkReviewMatchingTransactionsMutationResult = NonNullable<Awaited<ReturnType<typeof bulkReviewMatchingTransactions>>>;
export type BulkReviewMatchingTransactionsMutationBody = BodyType<BulkReviewMatchingInput>;
export type BulkReviewMatchingTransactionsMutationError = ErrorType<void | BulkReviewMatchingTransactions409>;
/**
 * @summary (PR13) Mark every ledger row matching a filter reviewed (or not) in
one request, without the client holding the ids. The filter is the
ledger's, `reviewed` included. `expectedCount` is the `matchingCount`
the client showed: when a different number of rows matches now, the
request is refused with 409 and nothing changes. More than 1,000
matching rows is a 400. Rows already in the target state count in
`matched` but not in `updated`.

 */
export declare const useBulkReviewMatchingTransactions: <TError = ErrorType<void | BulkReviewMatchingTransactions409>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof bulkReviewMatchingTransactions>>, TError, {
        data: BodyType<BulkReviewMatchingInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof bulkReviewMatchingTransactions>>, TError, {
    data: BodyType<BulkReviewMatchingInput>;
}, TContext>;
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
export {};
//# sourceMappingURL=api.d.ts.map