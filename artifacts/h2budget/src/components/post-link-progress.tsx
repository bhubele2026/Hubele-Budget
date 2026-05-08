import { useEffect, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListPlaidItemsQueryKey,
  getListTransactionsQueryKey,
  getListPlaidLiabilityAccountsQueryKey,
  getListDebtsQueryKey,
  getGetDashboardQueryKey,
  getGetForecastQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { usePlaidSync } from "@/hooks/use-plaid-sync";
import {
  PostLinkProgressPanel,
  type PostLinkStatus,
} from "@/components/plaid-link-button";

// (#379) Shared in-page post-link progress channel. The PlaidLinkButton's
// background poll loop publishes its current state here; pages render a
// <PostLinkProgressBanner /> above their header so a fresh link, a slow
// bank, and a broken bank no longer all look identical for the first
// ~30 seconds. Both the Chase (Transactions) and Amex pages subscribe to
// the same store, so the two surfaces stay in sync regardless of which
// one initiated the link.

export type PostLinkRetryContext = {
  itemId: string | null;
  institutionName: string | null;
};

type StoreValue = {
  status: PostLinkStatus | null;
  retry: PostLinkRetryContext;
};

let value: StoreValue = {
  status: null,
  retry: { itemId: null, institutionName: null },
};
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function getSnapshot(): StoreValue {
  return value;
}

export function setPostLinkProgress(
  status: PostLinkStatus | null,
  retry?: Partial<PostLinkRetryContext>,
) {
  value = {
    status,
    retry: retry
      ? { ...value.retry, ...retry }
      : value.retry,
  };
  emit();
}

export function clearPostLinkProgress() {
  value = {
    status: null,
    retry: { itemId: null, institutionName: null },
  };
  emit();
}

export function getPostLinkProgress(): StoreValue {
  return value;
}

export function usePostLinkProgress(): StoreValue {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * (#379) Banner rendered above the header on both the Chase and Amex
 * pages. Subscribes to the shared post-link progress store so it tracks
 * whichever PlaidLinkButton initiated the most recent link. On `ready`,
 * invalidates every dependent query so transactions, items, debts, the
 * dashboard, and the forecast all light up together. On `error`, shows
 * a Retry button that reruns the sync for just the linked item.
 */
export function PostLinkProgressBanner({
  viewTransactionsPath,
}: {
  viewTransactionsPath: string;
}) {
  const { status, retry } = usePostLinkProgress();
  const qc = useQueryClient();
  const { runSync } = usePlaidSync();
  const [retrying, setRetrying] = useState(false);

  // (#379) When the poll resolves (ready / done), refresh the queries
  // every dependent UI is reading. The post-link poll itself only
  // invalidates items + transactions; the banner widens that to the
  // surfaces a freshly-imported batch is most likely to change so the
  // dashboard, forecast, and debt rows update without a manual refresh.
  const phase = status?.phase ?? null;
  useEffect(() => {
    if (phase !== "ready") return;
    qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
    qc.invalidateQueries({ queryKey: getListPlaidItemsQueryKey() });
    qc.invalidateQueries({ queryKey: getListPlaidLiabilityAccountsQueryKey() });
    qc.invalidateQueries({ queryKey: getListDebtsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetDashboardQueryKey() });
    qc.invalidateQueries({ queryKey: getGetForecastQueryKey() });
  }, [phase, qc]);

  if (!status) return null;

  const handleRetry = async () => {
    if (retrying) return;
    setRetrying(true);
    const itemId = retry.itemId ?? undefined;
    const institutionName = retry.institutionName ?? status.institutionName;
    setPostLinkProgress({
      ...status,
      phase: "polling",
      attempt: Math.max(1, status.attempt),
      errorMessage: null,
    });
    try {
      const totals = await runSync({
        silent: true,
        ...(itemId ? { itemId } : {}),
      });
      if (totals.errors.length > 0) {
        setPostLinkProgress({
          ...status,
          phase: "error",
          institutionName,
          added: status.added + totals.added,
          modified: status.modified + totals.modified,
          errorMessage: totals.errors
            .map((m) => (m.startsWith("Plaid:") ? m : `Plaid: ${m}`))
            .join("; "),
        });
      } else if (totals.added > 0 || totals.modified > 0) {
        const occurredOn = totals.lastOccurredOn;
        const mostRecentMonth =
          occurredOn && occurredOn.length >= 7
            ? `${occurredOn.slice(0, 7)}-01`
            : `${new Date().toISOString().slice(0, 7)}-01`;
        setPostLinkProgress({
          ...status,
          phase: "ready",
          institutionName,
          added: status.added + totals.added,
          modified: status.modified + totals.modified,
          errorMessage: null,
          importedDateRange:
            totals.importedDateRange ?? status.importedDateRange,
          mostRecentMonth,
        });
      } else {
        setPostLinkProgress({
          ...status,
          phase: "still-preparing",
          institutionName,
          errorMessage: null,
        });
      }
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div data-testid="banner-post-link-progress">
      <PostLinkProgressPanel
        status={status}
        viewTransactionsPath={viewTransactionsPath}
        onDismiss={clearPostLinkProgress}
      />
      {status.phase === "error" && (
        <div className="mt-2 flex justify-end">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={handleRetry}
            disabled={retrying}
            data-testid="button-post-link-retry"
          >
            <RefreshCw
              className={`w-4 h-4 mr-1.5 ${retrying ? "animate-spin" : ""}`}
            />
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}
