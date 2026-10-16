import { RefreshBanner } from "@/components/data-state";
import { dataState, type QueryLike } from "@/lib/queryState";

/** (T4) A query's failed refresh or failed load as the standard banner: the page keeps its figures. */
export function QueryRefreshBanner({
  q,
  "data-testid": testId,
}: {
  q: QueryLike & { dataUpdatedAt?: number; refetch: () => unknown };
  "data-testid"?: string;
}) {
  return (
    <RefreshBanner
      state={dataState(q)}
      updatedAt={q.dataUpdatedAt ? new Date(q.dataUpdatedAt).toISOString() : null}
      onRetry={() => void q.refetch()}
      refreshing={q.isFetching}
      {...(testId ? { "data-testid": testId } : {})}
    />
  );
}
