import type { QueryKey, UseMutationOptions, UseMutationResult, UseQueryOptions, UseQueryResult } from "@tanstack/react-query";
import type { AprilChaseSeedResult, AvalancheExtra, AvalancheSettings, AvalancheSettingsInput, BankSnapshot, BillsSummary, BudgetLine, BudgetLineInput, BudgetMonthDetail, CashSignal, Category, CategoryInput, CleanupNonProdPlaidItems200, CloseForecastMonthBody, CreateTransactionInput, DashboardBudget, DashboardBudgetInput, DashboardSummary, Debt, DebtBalanceHistoryEntry, DebtInput, DebtLinkInput, DebtPaymentInput, DebtPaymentResult, DeleteDashboardBudgetParams, ForecastBundle, ForecastClosedMonth, ForecastResolution, ForecastResolutionInput, ForecastSettings, ForecastSettingsInput, GetForecastCashSignalParams, GetForecastParams, HealthStatus, ImportSummary, ImportWorkbookBody, ListDashboardBudgetsParams, ListPlaidLiabilityAccountsParams, ListTransactionsParams, MappingRule, MappingRuleInput, PinBudgetLineInput, PinBudgetMonthInput, PinResult, PlaidEnvironmentInfo, PlaidExchangeInput, PlaidItemDetail, PlaidLiabilityAccount, PlaidLinkToken, PlaidSyncInput, PlaidSyncResult, RecurringItem, RecurringItemInput, SeedDefaultBudgetResult, SetBankSnapshotInput, Settings, SettingsInput, SyncMinimumsResult, Transaction, TransactionInput } from "./api.schemas";
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
export declare const createTransaction: (createTransactionInput: CreateTransactionInput, options?: RequestInit) => Promise<Transaction>;
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
export declare const updateTransaction: (id: string, transactionInput: TransactionInput, options?: RequestInit) => Promise<Transaction>;
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
export declare const createMappingRule: (mappingRuleInput: MappingRuleInput, options?: RequestInit) => Promise<MappingRule>;
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
export declare const getRefreshForecastBankUrl: () => string;
export declare const refreshForecastBank: (options?: RequestInit) => Promise<BankSnapshot>;
export declare const getRefreshForecastBankMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof refreshForecastBank>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof refreshForecastBank>>, TError, void, TContext>;
export type RefreshForecastBankMutationResult = NonNullable<Awaited<ReturnType<typeof refreshForecastBank>>>;
export type RefreshForecastBankMutationError = ErrorType<unknown>;
export declare const useRefreshForecastBank: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof refreshForecastBank>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof refreshForecastBank>>, TError, void, TContext>;
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
export declare const getGetBillsSummaryUrl: () => string;
export declare const getBillsSummary: (options?: RequestInit) => Promise<BillsSummary>;
export declare const getGetBillsSummaryQueryKey: () => readonly ["/api/bills/summary"];
export declare const getGetBillsSummaryQueryOptions: <TData = Awaited<ReturnType<typeof getBillsSummary>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getBillsSummary>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getBillsSummary>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetBillsSummaryQueryResult = NonNullable<Awaited<ReturnType<typeof getBillsSummary>>>;
export type GetBillsSummaryQueryError = ErrorType<unknown>;
export declare function useGetBillsSummary<TData = Awaited<ReturnType<typeof getBillsSummary>>, TError = ErrorType<unknown>>(options?: {
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
export {};
//# sourceMappingURL=api.d.ts.map