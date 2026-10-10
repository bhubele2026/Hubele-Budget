import type { QueryKey, UseMutationOptions, UseMutationResult, UseQueryOptions, UseQueryResult } from "@tanstack/react-query";
import type { AffordResult, AgentAction, AgentActionList, AgentFinding, AgentFindingList, AgentMonitorRunResult, AgentProposal, AgentProposalList, AgentRunList, AiBudget, AiConversation, AiConversationDetail, AiConversationList, AiUsageSummary, AllowancePlan, AllowancePlanUpdate, AllowancePlans, ApplyLearnedRuleRetroactivelyParams, ApplyRetroactivelyResult, CategorizationRunResult, CategorizationSettings, CategorizationSettingsInput, CategoryDecision, CorrectDecisionInput, CreateWeekAdjustmentBody, CreateWishlistItemBody, DebtPlan, EvaluateAffordBody, HealthStatus, LearnedRule, ListAgentActionsParams, ListAgentFindingsParams, ListAgentProposalsParams, ListAgentRunsParams, ListAiConversationsParams, ListCategoryDecisionsParams, ListRecapDeliveriesParams, ListRecapHistoryParams, MappingRuleHistory, MemoryItem, MemoryList, MoneyPosition, OpsJobRetryResult, OpsJobsReport, PutMemoryBody, RecapDeliveryItem, RecapError, RecapHistoryItem, RecapPauseInput, RecapPreview, RecapPreviewInput, RecapSettings, RecapSettingsInput, RecapTestSendResult, RecapVerifyConfirmInput, RecapVerifyStartInput, RecapVerifyStartResult, ReplaceTransactionSplitsInput, ReviewResolution, RunCategorizationInput, TransactionSplits, UndoDecisionResult, UpdateAiBudgetBody, UpdateLearnedRuleInput, UpdateWishlistItemBody, WaysBack, WeekAdjustment, WishlistEvaluationResult, WishlistItem, WishlistList } from "./api.schemas";
import { customFetch } from "../../custom-fetch";
import type { ErrorType, BodyType } from "../../custom-fetch";
type AwaitedInput<T> = PromiseLike<T> | T;
type Awaited<O> = O extends AwaitedInput<infer T> ? T : never;
type SecondParameter<T extends (...args: never) => unknown> = Parameters<T>[1];
/**
 * @summary Health check. Always 200 while the process serves; job, AI and SMS
state are reported as booleans and counts (never secrets) and never
fail the check.

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
 * @summary Health check. Always 200 while the process serves; job, AI and SMS
state are reported as booleans and counts (never secrets) and never
fail the check.

 */
export declare function useHealthCheck<TData = Awaited<ReturnType<typeof healthCheck>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof healthCheck>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary (AI-0, owner only) Job counts per queue and state, plus the 50 most
recent failed jobs. Read straight from the pg-boss tables, so it works
whether or not this instance runs jobs.

 */
export declare const getGetOpsJobsUrl: () => string;
export declare const getOpsJobs: (options?: RequestInit) => Promise<OpsJobsReport>;
export declare const getGetOpsJobsQueryKey: () => readonly ["/api/ops/jobs"];
export declare const getGetOpsJobsQueryOptions: <TData = Awaited<ReturnType<typeof getOpsJobs>>, TError = ErrorType<void>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getOpsJobs>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getOpsJobs>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetOpsJobsQueryResult = NonNullable<Awaited<ReturnType<typeof getOpsJobs>>>;
export type GetOpsJobsQueryError = ErrorType<void>;
/**
 * @summary (AI-0, owner only) Job counts per queue and state, plus the 50 most
recent failed jobs. Read straight from the pg-boss tables, so it works
whether or not this instance runs jobs.

 */
export declare function useGetOpsJobs<TData = Awaited<ReturnType<typeof getOpsJobs>>, TError = ErrorType<void>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getOpsJobs>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary (AI-0, owner only) Put a failed job back in its queue.
 */
export declare const getRetryOpsJobUrl: (id: string) => string;
export declare const retryOpsJob: (id: string, options?: RequestInit) => Promise<OpsJobRetryResult>;
export declare const getRetryOpsJobMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof retryOpsJob>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof retryOpsJob>>, TError, {
    id: string;
}, TContext>;
export type RetryOpsJobMutationResult = NonNullable<Awaited<ReturnType<typeof retryOpsJob>>>;
export type RetryOpsJobMutationError = ErrorType<void>;
/**
 * @summary (AI-0, owner only) Put a failed job back in its queue.
 */
export declare const useRetryOpsJob: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof retryOpsJob>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof retryOpsJob>>, TError, {
    id: string;
}, TContext>;
/**
 * @summary (AI-4b) The caller's own daily-recap text settings (created with defaults
on first read). Never carries the full phone number: only its last four digits.

 */
export declare const getGetRecapSettingsUrl: () => string;
export declare const getRecapSettings: (options?: RequestInit) => Promise<RecapSettings>;
export declare const getGetRecapSettingsQueryKey: () => readonly ["/api/recap/settings"];
export declare const getGetRecapSettingsQueryOptions: <TData = Awaited<ReturnType<typeof getRecapSettings>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getRecapSettings>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getRecapSettings>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetRecapSettingsQueryResult = NonNullable<Awaited<ReturnType<typeof getRecapSettings>>>;
export type GetRecapSettingsQueryError = ErrorType<unknown>;
/**
 * @summary (AI-4b) The caller's own daily-recap text settings (created with defaults
on first read). Never carries the full phone number: only its last four digits.

 */
export declare function useGetRecapSettings<TData = Awaited<ReturnType<typeof getRecapSettings>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getRecapSettings>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary (AI-4b) Change the caller's recap settings. Turning the recap on needs a
verified phone number and recorded consent, and not an opt-out.

 */
export declare const getUpdateRecapSettingsUrl: () => string;
export declare const updateRecapSettings: (recapSettingsInput: RecapSettingsInput, options?: RequestInit) => Promise<RecapSettings>;
export declare const getUpdateRecapSettingsMutationOptions: <TError = ErrorType<RecapError>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateRecapSettings>>, TError, {
        data: BodyType<RecapSettingsInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof updateRecapSettings>>, TError, {
    data: BodyType<RecapSettingsInput>;
}, TContext>;
export type UpdateRecapSettingsMutationResult = NonNullable<Awaited<ReturnType<typeof updateRecapSettings>>>;
export type UpdateRecapSettingsMutationBody = BodyType<RecapSettingsInput>;
export type UpdateRecapSettingsMutationError = ErrorType<RecapError>;
/**
 * @summary (AI-4b) Change the caller's recap settings. Turning the recap on needs a
verified phone number and recorded consent, and not an opt-out.

 */
export declare const useUpdateRecapSettings: <TError = ErrorType<RecapError>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateRecapSettings>>, TError, {
        data: BodyType<RecapSettingsInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof updateRecapSettings>>, TError, {
    data: BodyType<RecapSettingsInput>;
}, TContext>;
/**
 * @summary (AI-4b) Record consent and text a 6-digit code (valid 10 minutes, at most
3 starts per day) to the given US mobile number.

 */
export declare const getStartRecapVerificationUrl: () => string;
export declare const startRecapVerification: (recapVerifyStartInput: RecapVerifyStartInput, options?: RequestInit) => Promise<RecapVerifyStartResult>;
export declare const getStartRecapVerificationMutationOptions: <TError = ErrorType<RecapError>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof startRecapVerification>>, TError, {
        data: BodyType<RecapVerifyStartInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof startRecapVerification>>, TError, {
    data: BodyType<RecapVerifyStartInput>;
}, TContext>;
export type StartRecapVerificationMutationResult = NonNullable<Awaited<ReturnType<typeof startRecapVerification>>>;
export type StartRecapVerificationMutationBody = BodyType<RecapVerifyStartInput>;
export type StartRecapVerificationMutationError = ErrorType<RecapError>;
/**
 * @summary (AI-4b) Record consent and text a 6-digit code (valid 10 minutes, at most
3 starts per day) to the given US mobile number.

 */
export declare const useStartRecapVerification: <TError = ErrorType<RecapError>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof startRecapVerification>>, TError, {
        data: BodyType<RecapVerifyStartInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof startRecapVerification>>, TError, {
    data: BodyType<RecapVerifyStartInput>;
}, TContext>;
/**
 * @summary (AI-4b) Confirm the 6-digit code (5 tries per code). Marks the number verified.
 */
export declare const getConfirmRecapVerificationUrl: () => string;
export declare const confirmRecapVerification: (recapVerifyConfirmInput: RecapVerifyConfirmInput, options?: RequestInit) => Promise<RecapSettings>;
export declare const getConfirmRecapVerificationMutationOptions: <TError = ErrorType<RecapError>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof confirmRecapVerification>>, TError, {
        data: BodyType<RecapVerifyConfirmInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof confirmRecapVerification>>, TError, {
    data: BodyType<RecapVerifyConfirmInput>;
}, TContext>;
export type ConfirmRecapVerificationMutationResult = NonNullable<Awaited<ReturnType<typeof confirmRecapVerification>>>;
export type ConfirmRecapVerificationMutationBody = BodyType<RecapVerifyConfirmInput>;
export type ConfirmRecapVerificationMutationError = ErrorType<RecapError>;
/**
 * @summary (AI-4b) Confirm the 6-digit code (5 tries per code). Marks the number verified.
 */
export declare const useConfirmRecapVerification: <TError = ErrorType<RecapError>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof confirmRecapVerification>>, TError, {
        data: BodyType<RecapVerifyConfirmInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof confirmRecapVerification>>, TError, {
    data: BodyType<RecapVerifyConfirmInput>;
}, TContext>;
/**
 * @summary (AI-4b) Text the fixed test line to the caller's verified number (3 per day).
 */
export declare const getSendRecapTestUrl: () => string;
export declare const sendRecapTest: (options?: RequestInit) => Promise<RecapTestSendResult>;
export declare const getSendRecapTestMutationOptions: <TError = ErrorType<RecapError>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof sendRecapTest>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof sendRecapTest>>, TError, void, TContext>;
export type SendRecapTestMutationResult = NonNullable<Awaited<ReturnType<typeof sendRecapTest>>>;
export type SendRecapTestMutationError = ErrorType<RecapError>;
/**
 * @summary (AI-4b) Text the fixed test line to the caller's verified number (3 per day).
 */
export declare const useSendRecapTest: <TError = ErrorType<RecapError>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof sendRecapTest>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof sendRecapTest>>, TError, void, TContext>;
/**
 * @summary (AI-4b) Pause recap texts until the given time (null or a past time resumes).
 */
export declare const getPauseRecapUrl: () => string;
export declare const pauseRecap: (recapPauseInput: RecapPauseInput, options?: RequestInit) => Promise<RecapSettings>;
export declare const getPauseRecapMutationOptions: <TError = ErrorType<RecapError>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof pauseRecap>>, TError, {
        data: BodyType<RecapPauseInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof pauseRecap>>, TError, {
    data: BodyType<RecapPauseInput>;
}, TContext>;
export type PauseRecapMutationResult = NonNullable<Awaited<ReturnType<typeof pauseRecap>>>;
export type PauseRecapMutationBody = BodyType<RecapPauseInput>;
export type PauseRecapMutationError = ErrorType<RecapError>;
/**
 * @summary (AI-4b) Pause recap texts until the given time (null or a past time resumes).
 */
export declare const usePauseRecap: <TError = ErrorType<RecapError>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof pauseRecap>>, TError, {
        data: BodyType<RecapPauseInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof pauseRecap>>, TError, {
    data: BodyType<RecapPauseInput>;
}, TContext>;
/**
 * @summary (AI-4b) Opt out of recap texts and turn the recap off.
 */
export declare const getUnsubscribeRecapUrl: () => string;
export declare const unsubscribeRecap: (options?: RequestInit) => Promise<RecapSettings>;
export declare const getUnsubscribeRecapMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof unsubscribeRecap>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof unsubscribeRecap>>, TError, void, TContext>;
export type UnsubscribeRecapMutationResult = NonNullable<Awaited<ReturnType<typeof unsubscribeRecap>>>;
export type UnsubscribeRecapMutationError = ErrorType<unknown>;
/**
 * @summary (AI-4b) Opt out of recap texts and turn the recap off.
 */
export declare const useUnsubscribeRecap: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof unsubscribeRecap>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof unsubscribeRecap>>, TError, void, TContext>;
/**
 * @summary (AI-4b) The caller's most recent text deliveries (newest first, at most 30).
 */
export declare const getListRecapDeliveriesUrl: (params?: ListRecapDeliveriesParams) => string;
export declare const listRecapDeliveries: (params?: ListRecapDeliveriesParams, options?: RequestInit) => Promise<RecapDeliveryItem[]>;
export declare const getListRecapDeliveriesQueryKey: (params?: ListRecapDeliveriesParams) => readonly ["/api/recap/deliveries", ...ListRecapDeliveriesParams[]];
export declare const getListRecapDeliveriesQueryOptions: <TData = Awaited<ReturnType<typeof listRecapDeliveries>>, TError = ErrorType<unknown>>(params?: ListRecapDeliveriesParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listRecapDeliveries>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listRecapDeliveries>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListRecapDeliveriesQueryResult = NonNullable<Awaited<ReturnType<typeof listRecapDeliveries>>>;
export type ListRecapDeliveriesQueryError = ErrorType<unknown>;
/**
 * @summary (AI-4b) The caller's most recent text deliveries (newest first, at most 30).
 */
export declare function useListRecapDeliveries<TData = Awaited<ReturnType<typeof listRecapDeliveries>>, TError = ErrorType<unknown>>(params?: ListRecapDeliveriesParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listRecapDeliveries>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * Builds the facts for the caller and returns both drafts. The model draft counts against the
household's daily `recap` call cap; it is null when AI is off, over budget, refused, or when
its text failed validation twice. With the demo provider the model text is a labelled fixture.
Nothing is stored and nothing is sent.

 * @summary (AI-4a) Draft the morning recap for a day without storing or sending it (model draft and template).
 */
export declare const getPreviewRecapUrl: () => string;
export declare const previewRecap: (recapPreviewInput?: RecapPreviewInput, options?: RequestInit) => Promise<RecapPreview>;
export declare const getPreviewRecapMutationOptions: <TError = ErrorType<RecapError>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof previewRecap>>, TError, {
        data: BodyType<RecapPreviewInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof previewRecap>>, TError, {
    data: BodyType<RecapPreviewInput>;
}, TContext>;
export type PreviewRecapMutationResult = NonNullable<Awaited<ReturnType<typeof previewRecap>>>;
export type PreviewRecapMutationBody = BodyType<RecapPreviewInput>;
export type PreviewRecapMutationError = ErrorType<RecapError>;
/**
 * @summary (AI-4a) Draft the morning recap for a day without storing or sending it (model draft and template).
 */
export declare const usePreviewRecap: <TError = ErrorType<RecapError>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof previewRecap>>, TError, {
        data: BodyType<RecapPreviewInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof previewRecap>>, TError, {
    data: BodyType<RecapPreviewInput>;
}, TContext>;
/**
 * @summary (AI-4a) The caller's most recent recaps, newest first (at most 30), with their delivery status.
 */
export declare const getListRecapHistoryUrl: (params?: ListRecapHistoryParams) => string;
export declare const listRecapHistory: (params?: ListRecapHistoryParams, options?: RequestInit) => Promise<RecapHistoryItem[]>;
export declare const getListRecapHistoryQueryKey: (params?: ListRecapHistoryParams) => readonly ["/api/recap/history", ...ListRecapHistoryParams[]];
export declare const getListRecapHistoryQueryOptions: <TData = Awaited<ReturnType<typeof listRecapHistory>>, TError = ErrorType<unknown>>(params?: ListRecapHistoryParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listRecapHistory>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listRecapHistory>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListRecapHistoryQueryResult = NonNullable<Awaited<ReturnType<typeof listRecapHistory>>>;
export type ListRecapHistoryQueryError = ErrorType<unknown>;
/**
 * @summary (AI-4a) The caller's most recent recaps, newest first (at most 30), with their delivery status.
 */
export declare function useListRecapHistory<TData = Awaited<ReturnType<typeof listRecapHistory>>, TError = ErrorType<unknown>>(params?: ListRecapHistoryParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listRecapHistory>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * (WP5b) Every recorded change to one mapping rule, newest first:
created, seeded, edited, reordered, deleted, with the rule before and
after, who changed it and the note given. A deleted rule keeps its
history, so this answers for an id that no longer exists; an id from
another household has no entries here. Read-only.

 */
export declare const getGetMappingRuleHistoryUrl: (id: string) => string;
export declare const getMappingRuleHistory: (id: string, options?: RequestInit) => Promise<MappingRuleHistory>;
export declare const getGetMappingRuleHistoryQueryKey: (id: string) => readonly [`/api/mapping-rules/${string}/history`];
export declare const getGetMappingRuleHistoryQueryOptions: <TData = Awaited<ReturnType<typeof getMappingRuleHistory>>, TError = ErrorType<unknown>>(id: string, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getMappingRuleHistory>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getMappingRuleHistory>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetMappingRuleHistoryQueryResult = NonNullable<Awaited<ReturnType<typeof getMappingRuleHistory>>>;
export type GetMappingRuleHistoryQueryError = ErrorType<unknown>;
export declare function useGetMappingRuleHistory<TData = Awaited<ReturnType<typeof getMappingRuleHistory>>, TError = ErrorType<unknown>>(id: string, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getMappingRuleHistory>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary The debt plan — strategies, debt-free range, milestones, planned vs confirmed
 */
export declare const getGetDebtPlanUrl: () => string;
export declare const getDebtPlan: (options?: RequestInit) => Promise<DebtPlan>;
export declare const getGetDebtPlanQueryKey: () => readonly ["/api/debt-plan"];
export declare const getGetDebtPlanQueryOptions: <TData = Awaited<ReturnType<typeof getDebtPlan>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getDebtPlan>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getDebtPlan>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetDebtPlanQueryResult = NonNullable<Awaited<ReturnType<typeof getDebtPlan>>>;
export type GetDebtPlanQueryError = ErrorType<unknown>;
/**
 * @summary The debt plan — strategies, debt-free range, milestones, planned vs confirmed
 */
export declare function useGetDebtPlan<TData = Awaited<ReturnType<typeof getDebtPlan>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getDebtPlan>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * computePosition (avalanche-core) over one read of the household: the forecast curve computeCashSignal builds (the spine's own horizon of 90 days), the current Sunday–Saturday week classified by classifyMovement, the weekly cap from allowance_plans and the bank's freshness. The spine's `position` is the same call; an integration test asserts they agree to the cent. Never carries credit, a limit, a debt balance or an amount owed.
 * @summary How much is safe to spend now, until payday and this week (the money position)
 */
export declare const getGetMoneyPositionUrl: () => string;
export declare const getMoneyPosition: (options?: RequestInit) => Promise<MoneyPosition>;
export declare const getGetMoneyPositionQueryKey: () => readonly ["/api/money/position"];
export declare const getGetMoneyPositionQueryOptions: <TData = Awaited<ReturnType<typeof getMoneyPosition>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getMoneyPosition>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getMoneyPosition>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetMoneyPositionQueryResult = NonNullable<Awaited<ReturnType<typeof getMoneyPosition>>>;
export type GetMoneyPositionQueryError = ErrorType<unknown>;
/**
 * @summary How much is safe to spend now, until payday and this week (the money position)
 */
export declare function useGetMoneyPosition<TData = Awaited<ReturnType<typeof getMoneyPosition>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getMoneyPosition>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * evaluateAfford (avalanche-core) over one read of the household — the same read GET /money/position makes, plus the debt plan's debts and settings and this month's category plans. The purchase is one more outflow on the same curve: the curve is re-walked, the position re-computed (a purchase this week counts against this week's cap) and the debt-free range re-run with that month's extra cut when what is left until payday falls under it. A $0 purchase reproduces the baseline to the cent, and a purchase never shows a higher figure than the baseline. Stateless; nothing is written.
 * @summary Can we afford this? One purchase against the money position, before and after
 */
export declare const getEvaluateAffordUrl: () => string;
export declare const evaluateAfford: (evaluateAffordBody: EvaluateAffordBody, options?: RequestInit) => Promise<AffordResult>;
export declare const getEvaluateAffordMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof evaluateAfford>>, TError, {
        data: BodyType<EvaluateAffordBody>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof evaluateAfford>>, TError, {
    data: BodyType<EvaluateAffordBody>;
}, TContext>;
export type EvaluateAffordMutationResult = NonNullable<Awaited<ReturnType<typeof evaluateAfford>>>;
export type EvaluateAffordMutationBody = BodyType<EvaluateAffordBody>;
export type EvaluateAffordMutationError = ErrorType<void>;
/**
 * @summary Can we afford this? One purchase against the money position, before and after
 */
export declare const useEvaluateAfford: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof evaluateAfford>>, TError, {
        data: BodyType<EvaluateAffordBody>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof evaluateAfford>>, TError, {
    data: BodyType<EvaluateAffordBody>;
}, TContext>;
/**
 * @summary The household's allowance plans and the suggested weekly cap with its working
 */
export declare const getListAllowancePlansUrl: () => string;
export declare const listAllowancePlans: (options?: RequestInit) => Promise<AllowancePlans>;
export declare const getListAllowancePlansQueryKey: () => readonly ["/api/allowance-plans"];
export declare const getListAllowancePlansQueryOptions: <TData = Awaited<ReturnType<typeof listAllowancePlans>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listAllowancePlans>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listAllowancePlans>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListAllowancePlansQueryResult = NonNullable<Awaited<ReturnType<typeof listAllowancePlans>>>;
export type ListAllowancePlansQueryError = ErrorType<unknown>;
/**
 * @summary The household's allowance plans and the suggested weekly cap with its working
 */
export declare function useListAllowancePlans<TData = Awaited<ReturnType<typeof listAllowancePlans>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listAllowancePlans>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary Set a plan's amount (household owner only; writes source "owner")
 */
export declare const getUpdateAllowancePlanUrl: (id: string) => string;
export declare const updateAllowancePlan: (id: string, allowancePlanUpdate: AllowancePlanUpdate, options?: RequestInit) => Promise<AllowancePlan>;
export declare const getUpdateAllowancePlanMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateAllowancePlan>>, TError, {
        id: string;
        data: BodyType<AllowancePlanUpdate>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof updateAllowancePlan>>, TError, {
    id: string;
    data: BodyType<AllowancePlanUpdate>;
}, TContext>;
export type UpdateAllowancePlanMutationResult = NonNullable<Awaited<ReturnType<typeof updateAllowancePlan>>>;
export type UpdateAllowancePlanMutationBody = BodyType<AllowancePlanUpdate>;
export type UpdateAllowancePlanMutationError = ErrorType<void>;
/**
 * @summary Set a plan's amount (household owner only; writes source "owner")
 */
export declare const useUpdateAllowancePlan: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateAllowancePlan>>, TError, {
        id: string;
        data: BodyType<AllowancePlanUpdate>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof updateAllowancePlan>>, TError, {
    id: string;
    data: BodyType<AllowancePlanUpdate>;
}, TContext>;
/**
 * computeWaysBack (avalanche-core) over the money position (the same read GET /money/position makes) and the rows of this week and the 8 before it, classified by classifyMovement. Code only; every amount is WHOLE CENTS (integers). Read-only: nothing is written.
 * @summary A way back when the week is over — how far over, what is left per day, what to trim, next week carried
 */
export declare const getGetWaysBackUrl: () => string;
export declare const getWaysBack: (options?: RequestInit) => Promise<WaysBack>;
export declare const getGetWaysBackQueryKey: () => readonly ["/api/money/ways-back"];
export declare const getGetWaysBackQueryOptions: <TData = Awaited<ReturnType<typeof getWaysBack>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getWaysBack>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getWaysBack>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetWaysBackQueryResult = NonNullable<Awaited<ReturnType<typeof getWaysBack>>>;
export type GetWaysBackQueryError = ErrorType<unknown>;
/**
 * @summary A way back when the week is over — how far over, what is left per day, what to trim, next week carried
 */
export declare function useGetWaysBack<TData = Awaited<ReturnType<typeof getWaysBack>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getWaysBack>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * Upserts the household's carry-over for one week (unique on household, week and kind). amountCents is whole cents and must be negative: an adjustment can only LOWER a week. weekStart must be a Sunday, this week or later. The money position subtracts it from that week's remainingWeek.
 * @summary Start a week lower — carry an overage into it (household owner only)
 */
export declare const getCreateWeekAdjustmentUrl: () => string;
export declare const createWeekAdjustment: (createWeekAdjustmentBody: CreateWeekAdjustmentBody, options?: RequestInit) => Promise<WeekAdjustment>;
export declare const getCreateWeekAdjustmentMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createWeekAdjustment>>, TError, {
        data: BodyType<CreateWeekAdjustmentBody>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof createWeekAdjustment>>, TError, {
    data: BodyType<CreateWeekAdjustmentBody>;
}, TContext>;
export type CreateWeekAdjustmentMutationResult = NonNullable<Awaited<ReturnType<typeof createWeekAdjustment>>>;
export type CreateWeekAdjustmentMutationBody = BodyType<CreateWeekAdjustmentBody>;
export type CreateWeekAdjustmentMutationError = ErrorType<void>;
/**
 * @summary Start a week lower — carry an overage into it (household owner only)
 */
export declare const useCreateWeekAdjustment: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createWeekAdjustment>>, TError, {
        data: BodyType<CreateWeekAdjustmentBody>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof createWeekAdjustment>>, TError, {
    data: BodyType<CreateWeekAdjustmentBody>;
}, TContext>;
/**
 * @summary Remove a week's carry-over (household owner only)
 */
export declare const getDeleteWeekAdjustmentUrl: (weekStart: string) => string;
export declare const deleteWeekAdjustment: (weekStart: string, options?: RequestInit) => Promise<void>;
export declare const getDeleteWeekAdjustmentMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deleteWeekAdjustment>>, TError, {
        weekStart: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof deleteWeekAdjustment>>, TError, {
    weekStart: string;
}, TContext>;
export type DeleteWeekAdjustmentMutationResult = NonNullable<Awaited<ReturnType<typeof deleteWeekAdjustment>>>;
export type DeleteWeekAdjustmentMutationError = ErrorType<void>;
/**
 * @summary Remove a week's carry-over (household owner only)
 */
export declare const useDeleteWeekAdjustment: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deleteWeekAdjustment>>, TError, {
        weekStart: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof deleteWeekAdjustment>>, TError, {
    weekStart: string;
}, TContext>;
/**
 * (AI-3) Findings are written by deterministic detectors over the money position, the bills, the budget and the recent rows — no model call. The payload carries ids (refs) and numbers (figures), never a merchant name. `open` = not resolved and not dismissed.
 * @summary What the proactive monitor noticed (open by default), newest first
 */
export declare const getListAgentFindingsUrl: (params?: ListAgentFindingsParams) => string;
export declare const listAgentFindings: (params?: ListAgentFindingsParams, options?: RequestInit) => Promise<AgentFindingList>;
export declare const getListAgentFindingsQueryKey: (params?: ListAgentFindingsParams) => readonly ["/api/agent/findings", ...ListAgentFindingsParams[]];
export declare const getListAgentFindingsQueryOptions: <TData = Awaited<ReturnType<typeof listAgentFindings>>, TError = ErrorType<unknown>>(params?: ListAgentFindingsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listAgentFindings>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listAgentFindings>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListAgentFindingsQueryResult = NonNullable<Awaited<ReturnType<typeof listAgentFindings>>>;
export type ListAgentFindingsQueryError = ErrorType<unknown>;
/**
 * @summary What the proactive monitor noticed (open by default), newest first
 */
export declare function useListAgentFindings<TData = Awaited<ReturnType<typeof listAgentFindings>>, TError = ErrorType<unknown>>(params?: ListAgentFindingsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listAgentFindings>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary Dismiss a finding (it stays in the ledger, out of the open list)
 */
export declare const getDismissAgentFindingUrl: (id: string) => string;
export declare const dismissAgentFinding: (id: string, options?: RequestInit) => Promise<AgentFinding>;
export declare const getDismissAgentFindingMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof dismissAgentFinding>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof dismissAgentFinding>>, TError, {
    id: string;
}, TContext>;
export type DismissAgentFindingMutationResult = NonNullable<Awaited<ReturnType<typeof dismissAgentFinding>>>;
export type DismissAgentFindingMutationError = ErrorType<void>;
/**
 * @summary Dismiss a finding (it stays in the ledger, out of the open list)
 */
export declare const useDismissAgentFinding: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof dismissAgentFinding>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof dismissAgentFinding>>, TError, {
    id: string;
}, TContext>;
/**
 * @summary Mark a finding resolved (it will not re-fire for 7 days unless it gets more severe)
 */
export declare const getResolveAgentFindingUrl: (id: string) => string;
export declare const resolveAgentFinding: (id: string, options?: RequestInit) => Promise<AgentFinding>;
export declare const getResolveAgentFindingMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof resolveAgentFinding>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof resolveAgentFinding>>, TError, {
    id: string;
}, TContext>;
export type ResolveAgentFindingMutationResult = NonNullable<Awaited<ReturnType<typeof resolveAgentFinding>>>;
export type ResolveAgentFindingMutationError = ErrorType<void>;
/**
 * @summary Mark a finding resolved (it will not re-fire for 7 days unless it gets more severe)
 */
export declare const useResolveAgentFinding: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof resolveAgentFinding>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof resolveAgentFinding>>, TError, {
    id: string;
}, TContext>;
/**
 * @summary Run the monitor for this household now (owner only)
 */
export declare const getRunAgentMonitorUrl: () => string;
export declare const runAgentMonitor: (options?: RequestInit) => Promise<AgentMonitorRunResult>;
export declare const getRunAgentMonitorMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof runAgentMonitor>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof runAgentMonitor>>, TError, void, TContext>;
export type RunAgentMonitorMutationResult = NonNullable<Awaited<ReturnType<typeof runAgentMonitor>>>;
export type RunAgentMonitorMutationError = ErrorType<void>;
/**
 * @summary Run the monitor for this household now (owner only)
 */
export declare const useRunAgentMonitor: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof runAgentMonitor>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof runAgentMonitor>>, TError, void, TContext>;
/**
 * @summary The agent's recent runs, newest first
 */
export declare const getListAgentRunsUrl: (params?: ListAgentRunsParams) => string;
export declare const listAgentRuns: (params?: ListAgentRunsParams, options?: RequestInit) => Promise<AgentRunList>;
export declare const getListAgentRunsQueryKey: (params?: ListAgentRunsParams) => readonly ["/api/agent/runs", ...ListAgentRunsParams[]];
export declare const getListAgentRunsQueryOptions: <TData = Awaited<ReturnType<typeof listAgentRuns>>, TError = ErrorType<unknown>>(params?: ListAgentRunsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listAgentRuns>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listAgentRuns>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListAgentRunsQueryResult = NonNullable<Awaited<ReturnType<typeof listAgentRuns>>>;
export type ListAgentRunsQueryError = ErrorType<unknown>;
/**
 * @summary The agent's recent runs, newest first
 */
export declare function useListAgentRuns<TData = Awaited<ReturnType<typeof listAgentRuns>>, TError = ErrorType<unknown>>(params?: ListAgentRunsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listAgentRuns>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary The Activity trail — what the agent did, newest first
 */
export declare const getListAgentActionsUrl: (params?: ListAgentActionsParams) => string;
export declare const listAgentActions: (params?: ListAgentActionsParams, options?: RequestInit) => Promise<AgentActionList>;
export declare const getListAgentActionsQueryKey: (params?: ListAgentActionsParams) => readonly ["/api/agent/actions", ...ListAgentActionsParams[]];
export declare const getListAgentActionsQueryOptions: <TData = Awaited<ReturnType<typeof listAgentActions>>, TError = ErrorType<unknown>>(params?: ListAgentActionsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listAgentActions>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listAgentActions>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListAgentActionsQueryResult = NonNullable<Awaited<ReturnType<typeof listAgentActions>>>;
export type ListAgentActionsQueryError = ErrorType<unknown>;
/**
 * @summary The Activity trail — what the agent did, newest first
 */
export declare function useListAgentActions<TData = Awaited<ReturnType<typeof listAgentActions>>, TError = ErrorType<unknown>>(params?: ListAgentActionsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listAgentActions>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * Only reversible action types can be undone. `set_category` (the categorizer's model pass) undoes the decision it recorded and stamps the action.
 * @summary Undo a reversible agent action
 */
export declare const getUndoAgentActionUrl: (id: string) => string;
export declare const undoAgentAction: (id: string, options?: RequestInit) => Promise<AgentAction>;
export declare const getUndoAgentActionMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof undoAgentAction>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof undoAgentAction>>, TError, {
    id: string;
}, TContext>;
export type UndoAgentActionMutationResult = NonNullable<Awaited<ReturnType<typeof undoAgentAction>>>;
export type UndoAgentActionMutationError = ErrorType<void>;
/**
 * @summary Undo a reversible agent action
 */
export declare const useUndoAgentAction: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof undoAgentAction>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof undoAgentAction>>, TError, {
    id: string;
}, TContext>;
/**
 * @summary Owner only. Run the deterministic categorization stages over the
household's rows dated on/after `since` (default: the last 90 days).
(V7) With `scope: all`, over every row from the household's oldest
(`since` is ignored), in slices of 500 ids, oldest first. Locked rows
and rows a person filed are never touched. When AI is on, the model
pass over the rows still undecided plus the open review queue is
enqueued as background jobs. Idempotent: a second run with nothing
changed records nothing.

 */
export declare const getRunCategorizationUrl: () => string;
export declare const runCategorization: (runCategorizationInput?: RunCategorizationInput, options?: RequestInit) => Promise<CategorizationRunResult>;
export declare const getRunCategorizationMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof runCategorization>>, TError, {
        data: BodyType<RunCategorizationInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof runCategorization>>, TError, {
    data: BodyType<RunCategorizationInput>;
}, TContext>;
export type RunCategorizationMutationResult = NonNullable<Awaited<ReturnType<typeof runCategorization>>>;
export type RunCategorizationMutationBody = BodyType<RunCategorizationInput>;
export type RunCategorizationMutationError = ErrorType<void>;
/**
 * @summary Owner only. Run the deterministic categorization stages over the
household's rows dated on/after `since` (default: the last 90 days).
(V7) With `scope: all`, over every row from the household's oldest
(`since` is ignored), in slices of 500 ids, oldest first. Locked rows
and rows a person filed are never touched. When AI is on, the model
pass over the rows still undecided plus the open review queue is
enqueued as background jobs. Idempotent: a second run with nothing
changed records nothing.

 */
export declare const useRunCategorization: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof runCategorization>>, TError, {
        data: BodyType<RunCategorizationInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof runCategorization>>, TError, {
    data: BodyType<RunCategorizationInput>;
}, TContext>;
/**
 * @summary (V1) What files the household's charges and how far the model may go:
the owner's two switches, AI status, the deterministic engine's
counts, the model's mode and the requirements it still has to meet,
the last 20 decisions (any source) and the review-queue count;
(V7) the backlog (unfiled charges, the oldest one's date, provisional
rows) and one row per linked bank (data through, automatic updates).
Any member. The model's mode is computed by the same function the
categorize job uses.

 */
export declare const getGetCategorizationSettingsUrl: () => string;
export declare const getCategorizationSettings: (options?: RequestInit) => Promise<CategorizationSettings>;
export declare const getGetCategorizationSettingsQueryKey: () => readonly ["/api/categorization/settings"];
export declare const getGetCategorizationSettingsQueryOptions: <TData = Awaited<ReturnType<typeof getCategorizationSettings>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getCategorizationSettings>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getCategorizationSettings>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetCategorizationSettingsQueryResult = NonNullable<Awaited<ReturnType<typeof getCategorizationSettings>>>;
export type GetCategorizationSettingsQueryError = ErrorType<unknown>;
/**
 * @summary (V1) What files the household's charges and how far the model may go:
the owner's two switches, AI status, the deterministic engine's
counts, the model's mode and the requirements it still has to meet,
the last 20 decisions (any source) and the review-queue count;
(V7) the backlog (unfiled charges, the oldest one's date, provisional
rows) and one row per linked bank (data through, automatic updates).
Any member. The model's mode is computed by the same function the
categorize job uses.

 */
export declare function useGetCategorizationSettings<TData = Awaited<ReturnType<typeof getCategorizationSettings>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getCategorizationSettings>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary (V1) Owner only. Set `autoCategorize` and/or `modelAutoCategorize` in
the owner's settings preferences (created when missing; every other
preference key kept). Returns the same view as GET.

 */
export declare const getUpdateCategorizationSettingsUrl: () => string;
export declare const updateCategorizationSettings: (categorizationSettingsInput: CategorizationSettingsInput, options?: RequestInit) => Promise<CategorizationSettings>;
export declare const getUpdateCategorizationSettingsMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateCategorizationSettings>>, TError, {
        data: BodyType<CategorizationSettingsInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof updateCategorizationSettings>>, TError, {
    data: BodyType<CategorizationSettingsInput>;
}, TContext>;
export type UpdateCategorizationSettingsMutationResult = NonNullable<Awaited<ReturnType<typeof updateCategorizationSettings>>>;
export type UpdateCategorizationSettingsMutationBody = BodyType<CategorizationSettingsInput>;
export type UpdateCategorizationSettingsMutationError = ErrorType<void>;
/**
 * @summary (V1) Owner only. Set `autoCategorize` and/or `modelAutoCategorize` in
the owner's settings preferences (created when missing; every other
preference key kept). Returns the same view as GET.

 */
export declare const useUpdateCategorizationSettings: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateCategorizationSettings>>, TError, {
        data: BodyType<CategorizationSettingsInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof updateCategorizationSettings>>, TError, {
    data: BodyType<CategorizationSettingsInput>;
}, TContext>;
export declare const getAcceptCategorizationDecisionUrl: (decisionId: string) => string;
export declare const acceptCategorizationDecision: (decisionId: string, options?: RequestInit) => Promise<ReviewResolution>;
export declare const getAcceptCategorizationDecisionMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof acceptCategorizationDecision>>, TError, {
        decisionId: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof acceptCategorizationDecision>>, TError, {
    decisionId: string;
}, TContext>;
export type AcceptCategorizationDecisionMutationResult = NonNullable<Awaited<ReturnType<typeof acceptCategorizationDecision>>>;
export type AcceptCategorizationDecisionMutationError = ErrorType<void>;
export declare const useAcceptCategorizationDecision: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof acceptCategorizationDecision>>, TError, {
        decisionId: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof acceptCategorizationDecision>>, TError, {
    decisionId: string;
}, TContext>;
export declare const getSkipCategorizationDecisionUrl: (decisionId: string) => string;
export declare const skipCategorizationDecision: (decisionId: string, options?: RequestInit) => Promise<ReviewResolution>;
export declare const getSkipCategorizationDecisionMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof skipCategorizationDecision>>, TError, {
        decisionId: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof skipCategorizationDecision>>, TError, {
    decisionId: string;
}, TContext>;
export type SkipCategorizationDecisionMutationResult = NonNullable<Awaited<ReturnType<typeof skipCategorizationDecision>>>;
export type SkipCategorizationDecisionMutationError = ErrorType<void>;
export declare const useSkipCategorizationDecision: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof skipCategorizationDecision>>, TError, {
        decisionId: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof skipCategorizationDecision>>, TError, {
    decisionId: string;
}, TContext>;
/**
 * @summary File the row by hand (locked), learn merchant memory, and return the
retroactive candidates. Never applies them.

 */
export declare const getCorrectCategorizationDecisionUrl: (decisionId: string) => string;
export declare const correctCategorizationDecision: (decisionId: string, correctDecisionInput: CorrectDecisionInput, options?: RequestInit) => Promise<ReviewResolution>;
export declare const getCorrectCategorizationDecisionMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof correctCategorizationDecision>>, TError, {
        decisionId: string;
        data: BodyType<CorrectDecisionInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof correctCategorizationDecision>>, TError, {
    decisionId: string;
    data: BodyType<CorrectDecisionInput>;
}, TContext>;
export type CorrectCategorizationDecisionMutationResult = NonNullable<Awaited<ReturnType<typeof correctCategorizationDecision>>>;
export type CorrectCategorizationDecisionMutationBody = BodyType<CorrectDecisionInput>;
export type CorrectCategorizationDecisionMutationError = ErrorType<void>;
/**
 * @summary File the row by hand (locked), learn merchant memory, and return the
retroactive candidates. Never applies them.

 */
export declare const useCorrectCategorizationDecision: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof correctCategorizationDecision>>, TError, {
        decisionId: string;
        data: BodyType<CorrectDecisionInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof correctCategorizationDecision>>, TError, {
    decisionId: string;
    data: BodyType<CorrectDecisionInput>;
}, TContext>;
/**
 * @summary (PR-A2) How one charge was filed: its decisions, newest first, at most
20. A charge outside the household answers 404.

 */
export declare const getListCategoryDecisionsUrl: (params: ListCategoryDecisionsParams) => string;
export declare const listCategoryDecisions: (params: ListCategoryDecisionsParams, options?: RequestInit) => Promise<CategoryDecision[]>;
export declare const getListCategoryDecisionsQueryKey: (params?: ListCategoryDecisionsParams) => readonly ["/api/category-decisions", ...ListCategoryDecisionsParams[]];
export declare const getListCategoryDecisionsQueryOptions: <TData = Awaited<ReturnType<typeof listCategoryDecisions>>, TError = ErrorType<void>>(params: ListCategoryDecisionsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listCategoryDecisions>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listCategoryDecisions>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListCategoryDecisionsQueryResult = NonNullable<Awaited<ReturnType<typeof listCategoryDecisions>>>;
export type ListCategoryDecisionsQueryError = ErrorType<void>;
/**
 * @summary (PR-A2) How one charge was filed: its decisions, newest first, at most
20. A charge outside the household answers 404.

 */
export declare function useListCategoryDecisions<TData = Awaited<ReturnType<typeof listCategoryDecisions>>, TError = ErrorType<void>>(params: ListCategoryDecisionsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listCategoryDecisions>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary Restore the decision's previous category, clear provisional, stamp
undone_at and disable the memory it created.

 */
export declare const getUndoCategoryDecisionUrl: (id: string) => string;
export declare const undoCategoryDecision: (id: string, options?: RequestInit) => Promise<UndoDecisionResult>;
export declare const getUndoCategoryDecisionMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof undoCategoryDecision>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof undoCategoryDecision>>, TError, {
    id: string;
}, TContext>;
export type UndoCategoryDecisionMutationResult = NonNullable<Awaited<ReturnType<typeof undoCategoryDecision>>>;
export type UndoCategoryDecisionMutationError = ErrorType<void>;
/**
 * @summary Restore the decision's previous category, clear provisional, stamp
undone_at and disable the memory it created.

 */
export declare const useUndoCategoryDecision: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof undoCategoryDecision>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof undoCategoryDecision>>, TError, {
    id: string;
}, TContext>;
/**
 * @summary Merchant memory, with its evidence counts.
 */
export declare const getListLearnedRulesUrl: () => string;
export declare const listLearnedRules: (options?: RequestInit) => Promise<LearnedRule[]>;
export declare const getListLearnedRulesQueryKey: () => readonly ["/api/learned-rules"];
export declare const getListLearnedRulesQueryOptions: <TData = Awaited<ReturnType<typeof listLearnedRules>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listLearnedRules>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listLearnedRules>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListLearnedRulesQueryResult = NonNullable<Awaited<ReturnType<typeof listLearnedRules>>>;
export type ListLearnedRulesQueryError = ErrorType<unknown>;
/**
 * @summary Merchant memory, with its evidence counts.
 */
export declare function useListLearnedRules<TData = Awaited<ReturnType<typeof listLearnedRules>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listLearnedRules>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
export declare const getUpdateLearnedRuleUrl: (id: string) => string;
export declare const updateLearnedRule: (id: string, updateLearnedRuleInput: UpdateLearnedRuleInput, options?: RequestInit) => Promise<LearnedRule>;
export declare const getUpdateLearnedRuleMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateLearnedRule>>, TError, {
        id: string;
        data: BodyType<UpdateLearnedRuleInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof updateLearnedRule>>, TError, {
    id: string;
    data: BodyType<UpdateLearnedRuleInput>;
}, TContext>;
export type UpdateLearnedRuleMutationResult = NonNullable<Awaited<ReturnType<typeof updateLearnedRule>>>;
export type UpdateLearnedRuleMutationBody = BodyType<UpdateLearnedRuleInput>;
export type UpdateLearnedRuleMutationError = ErrorType<void>;
export declare const useUpdateLearnedRule: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateLearnedRule>>, TError, {
        id: string;
        data: BodyType<UpdateLearnedRuleInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof updateLearnedRule>>, TError, {
    id: string;
    data: BodyType<UpdateLearnedRuleInput>;
}, TContext>;
export declare const getDeleteLearnedRuleUrl: (id: string) => string;
export declare const deleteLearnedRule: (id: string, options?: RequestInit) => Promise<void>;
export declare const getDeleteLearnedRuleMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deleteLearnedRule>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof deleteLearnedRule>>, TError, {
    id: string;
}, TContext>;
export type DeleteLearnedRuleMutationResult = NonNullable<Awaited<ReturnType<typeof deleteLearnedRule>>>;
export type DeleteLearnedRuleMutationError = ErrorType<void>;
export declare const useDeleteLearnedRule: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deleteLearnedRule>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof deleteLearnedRule>>, TError, {
    id: string;
}, TContext>;
/**
 * @summary Explicit request: file every unlocked row of this merchant (within the
rule's scope) into its category. Each write is a `user` decision.
(PR-A2) With `dryRun=true` nothing is written: the answer is how many
rows would move and up to five of them. The server also reads
`{ "dryRun": true }` in the JSON body; the typed client sends the query
parameter, which keeps existing callers of the mutation unchanged.

 */
export declare const getApplyLearnedRuleRetroactivelyUrl: (id: string, params?: ApplyLearnedRuleRetroactivelyParams) => string;
export declare const applyLearnedRuleRetroactively: (id: string, params?: ApplyLearnedRuleRetroactivelyParams, options?: RequestInit) => Promise<ApplyRetroactivelyResult>;
export declare const getApplyLearnedRuleRetroactivelyMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof applyLearnedRuleRetroactively>>, TError, {
        id: string;
        params?: ApplyLearnedRuleRetroactivelyParams;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof applyLearnedRuleRetroactively>>, TError, {
    id: string;
    params?: ApplyLearnedRuleRetroactivelyParams;
}, TContext>;
export type ApplyLearnedRuleRetroactivelyMutationResult = NonNullable<Awaited<ReturnType<typeof applyLearnedRuleRetroactively>>>;
export type ApplyLearnedRuleRetroactivelyMutationError = ErrorType<void>;
/**
 * @summary Explicit request: file every unlocked row of this merchant (within the
rule's scope) into its category. Each write is a `user` decision.
(PR-A2) With `dryRun=true` nothing is written: the answer is how many
rows would move and up to five of them. The server also reads
`{ "dryRun": true }` in the JSON body; the typed client sends the query
parameter, which keeps existing callers of the mutation unchanged.

 */
export declare const useApplyLearnedRuleRetroactively: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof applyLearnedRuleRetroactively>>, TError, {
        id: string;
        params?: ApplyLearnedRuleRetroactivelyParams;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof applyLearnedRuleRetroactively>>, TError, {
    id: string;
    params?: ApplyLearnedRuleRetroactivelyParams;
}, TContext>;
export declare const getGetTransactionSplitsUrl: (id: string) => string;
export declare const getTransactionSplits: (id: string, options?: RequestInit) => Promise<TransactionSplits>;
export declare const getGetTransactionSplitsQueryKey: (id: string) => readonly [`/api/transactions/${string}/splits`];
export declare const getGetTransactionSplitsQueryOptions: <TData = Awaited<ReturnType<typeof getTransactionSplits>>, TError = ErrorType<void>>(id: string, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getTransactionSplits>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getTransactionSplits>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetTransactionSplitsQueryResult = NonNullable<Awaited<ReturnType<typeof getTransactionSplits>>>;
export type GetTransactionSplitsQueryError = ErrorType<void>;
export declare function useGetTransactionSplits<TData = Awaited<ReturnType<typeof getTransactionSplits>>, TError = ErrorType<void>>(id: string, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getTransactionSplits>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary Replace-all. The parts must add up to the charge's amount to the cent;
the charge keeps its own category and becomes locked.

 */
export declare const getReplaceTransactionSplitsUrl: (id: string) => string;
export declare const replaceTransactionSplits: (id: string, replaceTransactionSplitsInput: ReplaceTransactionSplitsInput, options?: RequestInit) => Promise<TransactionSplits>;
export declare const getReplaceTransactionSplitsMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof replaceTransactionSplits>>, TError, {
        id: string;
        data: BodyType<ReplaceTransactionSplitsInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof replaceTransactionSplits>>, TError, {
    id: string;
    data: BodyType<ReplaceTransactionSplitsInput>;
}, TContext>;
export type ReplaceTransactionSplitsMutationResult = NonNullable<Awaited<ReturnType<typeof replaceTransactionSplits>>>;
export type ReplaceTransactionSplitsMutationBody = BodyType<ReplaceTransactionSplitsInput>;
export type ReplaceTransactionSplitsMutationError = ErrorType<void>;
/**
 * @summary Replace-all. The parts must add up to the charge's amount to the cent;
the charge keeps its own category and becomes locked.

 */
export declare const useReplaceTransactionSplits: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof replaceTransactionSplits>>, TError, {
        id: string;
        data: BodyType<ReplaceTransactionSplitsInput>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof replaceTransactionSplits>>, TError, {
    id: string;
    data: BodyType<ReplaceTransactionSplitsInput>;
}, TContext>;
export declare const getDeleteTransactionSplitsUrl: (id: string) => string;
export declare const deleteTransactionSplits: (id: string, options?: RequestInit) => Promise<void>;
export declare const getDeleteTransactionSplitsMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deleteTransactionSplits>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof deleteTransactionSplits>>, TError, {
    id: string;
}, TContext>;
export type DeleteTransactionSplitsMutationResult = NonNullable<Awaited<ReturnType<typeof deleteTransactionSplits>>>;
export type DeleteTransactionSplitsMutationError = ErrorType<void>;
export declare const useDeleteTransactionSplits: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deleteTransactionSplits>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof deleteTransactionSplits>>, TError, {
    id: string;
}, TContext>;
/**
 * @summary Start a conversation with Ask
 */
export declare const getCreateAiConversationUrl: () => string;
export declare const createAiConversation: (options?: RequestInit) => Promise<AiConversation>;
export declare const getCreateAiConversationMutationOptions: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createAiConversation>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof createAiConversation>>, TError, void, TContext>;
export type CreateAiConversationMutationResult = NonNullable<Awaited<ReturnType<typeof createAiConversation>>>;
export type CreateAiConversationMutationError = ErrorType<unknown>;
/**
 * @summary Start a conversation with Ask
 */
export declare const useCreateAiConversation: <TError = ErrorType<unknown>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createAiConversation>>, TError, void, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof createAiConversation>>, TError, void, TContext>;
/**
 * @summary The signed-in person's conversations, newest first
 */
export declare const getListAiConversationsUrl: (params?: ListAiConversationsParams) => string;
export declare const listAiConversations: (params?: ListAiConversationsParams, options?: RequestInit) => Promise<AiConversationList>;
export declare const getListAiConversationsQueryKey: (params?: ListAiConversationsParams) => readonly ["/api/ai/conversations", ...ListAiConversationsParams[]];
export declare const getListAiConversationsQueryOptions: <TData = Awaited<ReturnType<typeof listAiConversations>>, TError = ErrorType<unknown>>(params?: ListAiConversationsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listAiConversations>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listAiConversations>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListAiConversationsQueryResult = NonNullable<Awaited<ReturnType<typeof listAiConversations>>>;
export type ListAiConversationsQueryError = ErrorType<unknown>;
/**
 * @summary The signed-in person's conversations, newest first
 */
export declare function useListAiConversations<TData = Awaited<ReturnType<typeof listAiConversations>>, TError = ErrorType<unknown>>(params?: ListAiConversationsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listAiConversations>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary One conversation with its messages (the polling fallback after a dropped stream)
 */
export declare const getGetAiConversationUrl: (id: string) => string;
export declare const getAiConversation: (id: string, options?: RequestInit) => Promise<AiConversationDetail>;
export declare const getGetAiConversationQueryKey: (id: string) => readonly [`/api/ai/conversations/${string}`];
export declare const getGetAiConversationQueryOptions: <TData = Awaited<ReturnType<typeof getAiConversation>>, TError = ErrorType<void>>(id: string, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getAiConversation>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getAiConversation>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetAiConversationQueryResult = NonNullable<Awaited<ReturnType<typeof getAiConversation>>>;
export type GetAiConversationQueryError = ErrorType<void>;
/**
 * @summary One conversation with its messages (the polling fallback after a dropped stream)
 */
export declare function useGetAiConversation<TData = Awaited<ReturnType<typeof getAiConversation>>, TError = ErrorType<void>>(id: string, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getAiConversation>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary Changes Ask proposed, newest first (open by default)
 */
export declare const getListAgentProposalsUrl: (params?: ListAgentProposalsParams) => string;
export declare const listAgentProposals: (params?: ListAgentProposalsParams, options?: RequestInit) => Promise<AgentProposalList>;
export declare const getListAgentProposalsQueryKey: (params?: ListAgentProposalsParams) => readonly ["/api/agent/proposals", ...ListAgentProposalsParams[]];
export declare const getListAgentProposalsQueryOptions: <TData = Awaited<ReturnType<typeof listAgentProposals>>, TError = ErrorType<unknown>>(params?: ListAgentProposalsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listAgentProposals>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listAgentProposals>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListAgentProposalsQueryResult = NonNullable<Awaited<ReturnType<typeof listAgentProposals>>>;
export type ListAgentProposalsQueryError = ErrorType<unknown>;
/**
 * @summary Changes Ask proposed, newest first (open by default)
 */
export declare function useListAgentProposals<TData = Awaited<ReturnType<typeof listAgentProposals>>, TError = ErrorType<unknown>>(params?: ListAgentProposalsParams, options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listAgentProposals>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary Approve a proposal and apply it through the app's own writer
 */
export declare const getApproveAgentProposalUrl: (id: string) => string;
export declare const approveAgentProposal: (id: string, options?: RequestInit) => Promise<AgentProposal>;
export declare const getApproveAgentProposalMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof approveAgentProposal>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof approveAgentProposal>>, TError, {
    id: string;
}, TContext>;
export type ApproveAgentProposalMutationResult = NonNullable<Awaited<ReturnType<typeof approveAgentProposal>>>;
export type ApproveAgentProposalMutationError = ErrorType<void>;
/**
 * @summary Approve a proposal and apply it through the app's own writer
 */
export declare const useApproveAgentProposal: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof approveAgentProposal>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof approveAgentProposal>>, TError, {
    id: string;
}, TContext>;
/**
 * @summary Reject a proposal
 */
export declare const getRejectAgentProposalUrl: (id: string) => string;
export declare const rejectAgentProposal: (id: string, options?: RequestInit) => Promise<AgentProposal>;
export declare const getRejectAgentProposalMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof rejectAgentProposal>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof rejectAgentProposal>>, TError, {
    id: string;
}, TContext>;
export type RejectAgentProposalMutationResult = NonNullable<Awaited<ReturnType<typeof rejectAgentProposal>>>;
export type RejectAgentProposalMutationError = ErrorType<void>;
/**
 * @summary Reject a proposal
 */
export declare const useRejectAgentProposal: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof rejectAgentProposal>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof rejectAgentProposal>>, TError, {
    id: string;
}, TContext>;
/**
 * @summary What the household (or Ask, visibly) keeps in memory
 */
export declare const getListMemoryUrl: () => string;
export declare const listMemory: (options?: RequestInit) => Promise<MemoryList>;
export declare const getListMemoryQueryKey: () => readonly ["/api/memory"];
export declare const getListMemoryQueryOptions: <TData = Awaited<ReturnType<typeof listMemory>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listMemory>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listMemory>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListMemoryQueryResult = NonNullable<Awaited<ReturnType<typeof listMemory>>>;
export type ListMemoryQueryError = ErrorType<unknown>;
/**
 * @summary What the household (or Ask, visibly) keeps in memory
 */
export declare function useListMemory<TData = Awaited<ReturnType<typeof listMemory>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listMemory>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary State a preference or decision (replaces what the key held)
 */
export declare const getPutMemoryUrl: (scope: "categorization" | "spending" | "debt" | "general", key: string) => string;
export declare const putMemory: (scope: "categorization" | "spending" | "debt" | "general", key: string, putMemoryBody: PutMemoryBody, options?: RequestInit) => Promise<MemoryItem>;
export declare const getPutMemoryMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof putMemory>>, TError, {
        scope: "categorization" | "spending" | "debt" | "general";
        key: string;
        data: BodyType<PutMemoryBody>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof putMemory>>, TError, {
    scope: "categorization" | "spending" | "debt" | "general";
    key: string;
    data: BodyType<PutMemoryBody>;
}, TContext>;
export type PutMemoryMutationResult = NonNullable<Awaited<ReturnType<typeof putMemory>>>;
export type PutMemoryMutationBody = BodyType<PutMemoryBody>;
export type PutMemoryMutationError = ErrorType<void>;
/**
 * @summary State a preference or decision (replaces what the key held)
 */
export declare const usePutMemory: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof putMemory>>, TError, {
        scope: "categorization" | "spending" | "debt" | "general";
        key: string;
        data: BodyType<PutMemoryBody>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof putMemory>>, TError, {
    scope: "categorization" | "spending" | "debt" | "general";
    key: string;
    data: BodyType<PutMemoryBody>;
}, TContext>;
/**
 * @summary Forget one memory (it leaves every list and every prompt)
 */
export declare const getDeleteMemoryUrl: (id: string) => string;
export declare const deleteMemory: (id: string, options?: RequestInit) => Promise<void>;
export declare const getDeleteMemoryMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deleteMemory>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof deleteMemory>>, TError, {
    id: string;
}, TContext>;
export type DeleteMemoryMutationResult = NonNullable<Awaited<ReturnType<typeof deleteMemory>>>;
export type DeleteMemoryMutationError = ErrorType<void>;
/**
 * @summary Forget one memory (it leaves every list and every prompt)
 */
export declare const useDeleteMemory: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof deleteMemory>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof deleteMemory>>, TError, {
    id: string;
}, TContext>;
/**
 * @summary The wish list, with each item's waiting period
 */
export declare const getListWishlistUrl: () => string;
export declare const listWishlist: (options?: RequestInit) => Promise<WishlistList>;
export declare const getListWishlistQueryKey: () => readonly ["/api/wishlist"];
export declare const getListWishlistQueryOptions: <TData = Awaited<ReturnType<typeof listWishlist>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listWishlist>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof listWishlist>>, TError, TData> & {
    queryKey: QueryKey;
};
export type ListWishlistQueryResult = NonNullable<Awaited<ReturnType<typeof listWishlist>>>;
export type ListWishlistQueryError = ErrorType<unknown>;
/**
 * @summary The wish list, with each item's waiting period
 */
export declare function useListWishlist<TData = Awaited<ReturnType<typeof listWishlist>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof listWishlist>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary Add something to the wish list (starts a waiting period)
 */
export declare const getCreateWishlistItemUrl: () => string;
export declare const createWishlistItem: (createWishlistItemBody: CreateWishlistItemBody, options?: RequestInit) => Promise<WishlistItem>;
export declare const getCreateWishlistItemMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createWishlistItem>>, TError, {
        data: BodyType<CreateWishlistItemBody>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof createWishlistItem>>, TError, {
    data: BodyType<CreateWishlistItemBody>;
}, TContext>;
export type CreateWishlistItemMutationResult = NonNullable<Awaited<ReturnType<typeof createWishlistItem>>>;
export type CreateWishlistItemMutationBody = BodyType<CreateWishlistItemBody>;
export type CreateWishlistItemMutationError = ErrorType<void>;
/**
 * @summary Add something to the wish list (starts a waiting period)
 */
export declare const useCreateWishlistItem: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof createWishlistItem>>, TError, {
        data: BodyType<CreateWishlistItemBody>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof createWishlistItem>>, TError, {
    data: BodyType<CreateWishlistItemBody>;
}, TContext>;
/**
 * @summary Edit an item or decide it (a yes waits out the waiting period)
 */
export declare const getUpdateWishlistItemUrl: (id: string) => string;
export declare const updateWishlistItem: (id: string, updateWishlistItemBody: UpdateWishlistItemBody, options?: RequestInit) => Promise<WishlistItem>;
export declare const getUpdateWishlistItemMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateWishlistItem>>, TError, {
        id: string;
        data: BodyType<UpdateWishlistItemBody>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof updateWishlistItem>>, TError, {
    id: string;
    data: BodyType<UpdateWishlistItemBody>;
}, TContext>;
export type UpdateWishlistItemMutationResult = NonNullable<Awaited<ReturnType<typeof updateWishlistItem>>>;
export type UpdateWishlistItemMutationBody = BodyType<UpdateWishlistItemBody>;
export type UpdateWishlistItemMutationError = ErrorType<void>;
/**
 * @summary Edit an item or decide it (a yes waits out the waiting period)
 */
export declare const useUpdateWishlistItem: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateWishlistItem>>, TError, {
        id: string;
        data: BodyType<UpdateWishlistItemBody>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof updateWishlistItem>>, TError, {
    id: string;
    data: BodyType<UpdateWishlistItemBody>;
}, TContext>;
/**
 * The nightly wishlist.evaluate job's work for one item: evaluateAfford with the item's amount (and category) today, stored in the item's last_evaluation.
 * @summary Evaluate one wish-list item now, as if bought today, and store the answer
 */
export declare const getEvaluateWishlistItemUrl: (id: string) => string;
export declare const evaluateWishlistItem: (id: string, options?: RequestInit) => Promise<WishlistEvaluationResult>;
export declare const getEvaluateWishlistItemMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof evaluateWishlistItem>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof evaluateWishlistItem>>, TError, {
    id: string;
}, TContext>;
export type EvaluateWishlistItemMutationResult = NonNullable<Awaited<ReturnType<typeof evaluateWishlistItem>>>;
export type EvaluateWishlistItemMutationError = ErrorType<void>;
/**
 * @summary Evaluate one wish-list item now, as if bought today, and store the answer
 */
export declare const useEvaluateWishlistItem: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof evaluateWishlistItem>>, TError, {
        id: string;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof evaluateWishlistItem>>, TError, {
    id: string;
}, TContext>;
/**
 * @summary This month's AI cost, calls, caps and the latest runs
 */
export declare const getGetAiUsageSummaryUrl: () => string;
export declare const getAiUsageSummary: (options?: RequestInit) => Promise<AiUsageSummary>;
export declare const getGetAiUsageSummaryQueryKey: () => readonly ["/api/ai/usage/summary"];
export declare const getGetAiUsageSummaryQueryOptions: <TData = Awaited<ReturnType<typeof getAiUsageSummary>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getAiUsageSummary>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}) => UseQueryOptions<Awaited<ReturnType<typeof getAiUsageSummary>>, TError, TData> & {
    queryKey: QueryKey;
};
export type GetAiUsageSummaryQueryResult = NonNullable<Awaited<ReturnType<typeof getAiUsageSummary>>>;
export type GetAiUsageSummaryQueryError = ErrorType<unknown>;
/**
 * @summary This month's AI cost, calls, caps and the latest runs
 */
export declare function useGetAiUsageSummary<TData = Awaited<ReturnType<typeof getAiUsageSummary>>, TError = ErrorType<unknown>>(options?: {
    query?: UseQueryOptions<Awaited<ReturnType<typeof getAiUsageSummary>>, TError, TData>;
    request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & {
    queryKey: QueryKey;
};
/**
 * @summary Owner sets the monthly caps and the pause
 */
export declare const getUpdateAiBudgetUrl: () => string;
export declare const updateAiBudget: (updateAiBudgetBody: UpdateAiBudgetBody, options?: RequestInit) => Promise<AiBudget>;
export declare const getUpdateAiBudgetMutationOptions: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateAiBudget>>, TError, {
        data: BodyType<UpdateAiBudgetBody>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationOptions<Awaited<ReturnType<typeof updateAiBudget>>, TError, {
    data: BodyType<UpdateAiBudgetBody>;
}, TContext>;
export type UpdateAiBudgetMutationResult = NonNullable<Awaited<ReturnType<typeof updateAiBudget>>>;
export type UpdateAiBudgetMutationBody = BodyType<UpdateAiBudgetBody>;
export type UpdateAiBudgetMutationError = ErrorType<void>;
/**
 * @summary Owner sets the monthly caps and the pause
 */
export declare const useUpdateAiBudget: <TError = ErrorType<void>, TContext = unknown>(options?: {
    mutation?: UseMutationOptions<Awaited<ReturnType<typeof updateAiBudget>>, TError, {
        data: BodyType<UpdateAiBudgetBody>;
    }, TContext>;
    request?: SecondParameter<typeof customFetch>;
}) => UseMutationResult<Awaited<ReturnType<typeof updateAiBudget>>, TError, {
    data: BodyType<UpdateAiBudgetBody>;
}, TContext>;
export {};
//# sourceMappingURL=api.d.ts.map