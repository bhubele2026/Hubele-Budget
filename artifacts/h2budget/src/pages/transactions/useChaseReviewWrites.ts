import {
  useBulkReviewMatchingTransactions,
  useBulkUpdateTransactions,
  type LedgerFilter,
} from "@workspace/api-client-react";

/** The bulk-update endpoint's id cap per request. */
const IDS_PER_REQUEST = 200;

export type ReviewIdsOutcome = {
  succeeded: Set<string>;
  /** Ids not saved: refused by the server, or in a request that failed or never ran. */
  failed: string[];
};

export type ReviewMatchingOutcome =
  | { kind: "ok"; matched: number; updated: number; updatedIds: string[] }
  /** 409: a different number of rows matches now. Nothing was written. */
  | { kind: "count_changed"; matchingCount: number | null }
  /** 400: more than 1,000 rows match. Nothing was written. */
  | { kind: "too_many" }
  | { kind: "failed"; message: string };

/**
 * The two ways the Chase list marks rows reviewed. Neither moves money: they
 * write only the `reviewed` field.
 *
 * - By id (a row, a selection): POST /transactions/bulk-update, 200 ids a
 *   request. The outcome names every id that did not save, so failed rows stay
 *   selected.
 * - By filter ("Select all 260 matching"): POST
 *   /transactions/bulk-review-matching with the count the user saw. One
 *   transaction on the server; a different count is a 409 and writes nothing.
 */
export function useChaseReviewWrites() {
  const bulkUpdate = useBulkUpdateTransactions();
  const bulkMatching = useBulkReviewMatchingTransactions();

  const reviewIds = async (ids: string[], reviewed: boolean): Promise<ReviewIdsOutcome> => {
    const succeeded = new Set<string>();
    try {
      for (let i = 0; i < ids.length; i += IDS_PER_REQUEST) {
        const result = await bulkUpdate.mutateAsync({
          data: { ids: ids.slice(i, i + IDS_PER_REQUEST), patch: { reviewed } },
        });
        for (const row of result.results) if (row.ok) succeeded.add(row.id);
      }
    } catch {
      // The failed request's ids, and every id after it, count as failed below.
    }
    return { succeeded, failed: ids.filter((id) => !succeeded.has(id)) };
  };

  const reviewMatching = async (
    filter: LedgerFilter,
    reviewed: boolean,
    expectedCount: number,
  ): Promise<ReviewMatchingOutcome> => {
    try {
      const r = await bulkMatching.mutateAsync({ data: { filter, reviewed, expectedCount } });
      return { kind: "ok", matched: r.matched, updated: r.updated, updatedIds: r.updatedIds };
    } catch (e) {
      const status = (e as { status?: unknown }).status;
      const data = (e as { data?: { code?: unknown; matchingCount?: unknown } | null }).data;
      if (status === 409) {
        return {
          kind: "count_changed",
          matchingCount: typeof data?.matchingCount === "number" ? data.matchingCount : null,
        };
      }
      if (status === 400 && data?.code === "too_many_rows") return { kind: "too_many" };
      return { kind: "failed", message: (e as Error)?.message ?? "Request failed" };
    }
  };

  return {
    reviewIds,
    reviewMatching,
    isPending: bulkUpdate.isPending || bulkMatching.isPending,
  };
}
