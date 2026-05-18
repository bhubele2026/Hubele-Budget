import { useState, useEffect, useMemo } from "react";
import {
  useGetSettings,
  useUpdateSettings,
  useImportWorkbook,
  getGetSettingsQueryKey,
  getListDashboardBudgetsQueryKey,
  useListPlaidItems,
  useDeletePlaidItem,
  useClearPlaidItemRefreshDisabled,
  useGetPlaidEnvironment,
  useCleanupNonProdPlaidItems,
  getGetPlaidEnvironmentQueryKey,
  useListCategories,
  getListPlaidItemsQueryKey,
  useRefreshPlaidConsentExpirations,
  useUpdatePlaidImportCutoffDate,
  useDedupeTransactions,
  useGetDuplicateTransactionCount,
  getGetDuplicateTransactionCountQueryKey,
  getListTransactionsQueryKey,
  getGetForecastQueryKey,
} from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { usePlaidSync, formatPlaidErrorForDisplay } from "@/hooks/use-plaid-sync";
import { useQueryClient } from "@tanstack/react-query";
import { ToastAction } from "@/components/ui/toast";
import { buildRuleAttributionSummary } from "@/lib/rule-attribution-summary";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useToast } from "@/hooks/use-toast";
import { UploadCloud, Download, RefreshCw, Trash2, Building2, Plus } from "lucide-react";
import { SUB_BUCKETS, DEFAULT_WEEKLY_BUCKET_LABELS, resolveWeeklyBucketLabels } from "@/lib/weeklyBuckets";
import { PlaidLinkButton } from "@/components/plaid-link-button";
import {
  formatPreparingElapsed,
  formatRelativeTimeFromNow,
  isPreparingStalled,
} from "@/lib/plaidPreparing";
import {
  formatConsentRefreshAge,
  isConsentRefreshStale,
} from "@/lib/plaidConsentFreshness";
import {
  PlaidReconnectButton,
  isPlaidReauthCode,
  isSyntheticPlaidItem,
  plaidReauthReason,
} from "@/components/plaid-reconnect-button";
import { OwnerInvitationsSection } from "@/components/owner-invitations";
import { OwnerBankHealthSweepSection } from "@/components/owner-bank-health-sweep";
import { PlaidSyncHistory } from "@/components/plaid-sync-history";
import {
  DEFAULT_DAYS_SINCE_TRACKERS,
  compileMatcher,
  newTrackerId,
  type DaysSinceTracker,
} from "@/lib/daysSinceTrackers";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const settingsSchema = z.object({
  weeklyAllowanceAmount: z.string().min(1),
  monthlyAllowanceAmount: z.string().min(1),
  unplannedAllowanceAmount: z.string().min(1),
  primaryAccount: z.string().optional().nullable(),
});

type SettingsFormValues = z.infer<typeof settingsSchema>;

export default function SettingsPage() {
  const { data: settings, isLoading } = useGetSettings();
  const updateSettings = useUpdateSettings();
  const importWorkbook = useImportWorkbook();
  const { data: plaidItems } = useListPlaidItems({
    query: {
      queryKey: getListPlaidItemsQueryKey(),
      // While any linked item is still in Plaid's historical-staging phase,
      // silently refetch every 90s so the "Still preparing" badge disappears
      // on its own once the server flips `stillPreparing` to false. Returning
      // `false` once no item is preparing stops the polling — same gating
      // pattern as the live timer tick below.
      refetchInterval: (query) => {
        const items = query.state.data;
        if (items?.some((it) => it.stillPreparing)) return 90_000;
        return false;
      },
    },
  });
  // Bumped ~once a minute while any item is still preparing so the
  // "Still preparing · Xm" badge and the 6h stalled hint update without a
  // page reload. Reads Date.now() inline at render time via the helpers.
  const [nowTick, setNowTick] = useState(() => Date.now());
  const hasPreparingItem = (plaidItems ?? []).some((it) => it.stillPreparing);
  useEffect(() => {
    if (!hasPreparingItem) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, [hasPreparingItem]);
  const deletePlaidItem = useDeletePlaidItem();
  // (#725) Per-item "Re-enable refresh" link on the bank tile. Clears
  // the server-side `refreshProductDisabledAt` short-circuit stamp so
  // the next Sync click actually calls /transactions/refresh — used
  // when the user just enabled the `transactions_refresh` add-on on
  // their Plaid Dashboard and doesn't want to wait for the 7-day
  // auto-retry window to elapse.
  const clearRefreshDisabled = useClearPlaidItemRefreshDisabled();
  const refreshConsentExpirations = useRefreshPlaidConsentExpirations();
  const dedupeTransactions = useDedupeTransactions();
  // (#470) Read-only count powering the "N duplicates found" badge
  // and the disabled/hidden state of the cleanup button. Shares the
  // same group key the cleanup uses, so a clean ledger reports 0 and
  // the badge collapses entirely.
  const { data: duplicateCountData } = useGetDuplicateTransactionCount();
  const duplicateCount = duplicateCountData?.duplicateCount ?? 0;
  const { runSync, isPending: isSyncPending } = usePlaidSync();
  // Track which row's per-item Sync button was just clicked so only THAT
  // row's spinner spins (the underlying mutation is global, so without this
  // every row would animate at once).
  const [syncingItemId, setSyncingItemId] = useState<string | null>(null);
  // (#707) When the user clicks Disconnect on an item that's in a reauth
  // state (INVALID_ACCESS_TOKEN / ITEM_LOGIN_REQUIRED / etc.), open a
  // confirm dialog steering them to reconnect instead of deleting the
  // item — deletion drops Plaid's transaction cursor, so a fresh-link
  // afterwards would re-import every old transaction from scratch.
  const [disconnectGuardItem, setDisconnectGuardItem] =
    useState<{ id: string; institutionName: string | null } | null>(null);
  // (#707) Once the user successfully reconnects from inside the
  // guard dialog, the next /plaid/items refetch clears the reauth
  // code. Auto-close the dialog at that point so the user isn't left
  // staring at a now-stale "needs reconnecting" prompt. Mirrors the
  // pattern in plaid-link-button.tsx for the #706 fresh-link guard.
  useEffect(() => {
    if (!disconnectGuardItem) return;
    const stillNeedsReauth = (plaidItems ?? []).some(
      (it) =>
        it.id === disconnectGuardItem.id &&
        isPlaidReauthCode(it.lastSyncErrorCode),
    );
    const stillExists = (plaidItems ?? []).some(
      (it) => it.id === disconnectGuardItem.id,
    );
    if (stillExists && !stillNeedsReauth) {
      setDisconnectGuardItem(null);
    }
  }, [plaidItems, disconnectGuardItem]);
  const { data: plaidEnv } = useGetPlaidEnvironment();
  const cleanupNonProd = useCleanupNonProdPlaidItems();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const handleSync = (itemId?: string) => {
    if (itemId) setSyncingItemId(itemId);
    void runSync(itemId ? { itemId } : {}).finally(() => {
      if (itemId) setSyncingItemId((curr) => (curr === itemId ? null : curr));
    });
  };

  // (#261) Manual trigger for the daily consent_expiration_time refresh.
  // The same code path runs unattended at 03:17 UTC, so this button is for
  // users who suspect their disconnect-date countdown is stale and don't
  // want to wait up to 24h. Surfaces the per-item summary in the toast and
  // invalidates the items query so each row's "Disconnect date checked"
  // line updates immediately.
  const handleRefreshConsentExpirations = () => {
    refreshConsentExpirations.mutate(undefined, {
      onSuccess: (res) => {
        queryClient.invalidateQueries({ queryKey: getListPlaidItemsQueryKey() });
        const failedItems = (res.items ?? []).filter((it) => !!it.error);
        // Build a "Checked 4 banks · 1 cutoff updated" headline. Pluralize
        // "bank" only when scanned !== 1 so single-item users don't see
        // "Checked 1 banks".
        const parts = [
          `Checked ${res.scanned} ${res.scanned === 1 ? "bank" : "banks"}`,
          `${res.updated} cutoff${res.updated === 1 ? "" : "s"} updated`,
        ];
        let description = parts.join(" · ");
        // Surface failed items by institution name (falls back to a generic
        // label) so the user knows which bank to reconnect when /item/get
        // fails for it (e.g. ITEM_LOGIN_REQUIRED).
        if (failedItems.length > 0) {
          const names = failedItems
            .map((it) => it.institutionName ?? "Unnamed institution")
            .join(", ");
          description += `. Failed: ${names}.`;
        }
        toast({
          title:
            failedItems.length > 0
              ? "Disconnect dates refreshed (with errors)"
              : "Disconnect dates refreshed",
          description,
          variant: failedItems.length > 0 ? "destructive" : undefined,
        });
      },
      onError: (err) => {
        toast({
          title: "Refresh failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    });
  };

  // (#458) One-click cleanup for users who already have duplicate
  // Chase/Plaid rows from before the post-sync dedupe pass landed.
  // Hits the same /forecast/dedupe-transactions endpoint task #452
  // exposed; idempotent, so re-running on a clean ledger reports 0.
  // Confirms first because the merge is destructive (loser rows are
  // deleted), then invalidates the transactions + forecast caches so
  // any open page reflects the collapsed ledger immediately.
  const handleDedupeTransactions = () => {
    if (
      !confirm(
        "Scan all linked accounts and merge duplicate transactions into one row? This can't be undone, but it's safe to run more than once.",
      )
    )
      return;
    dedupeTransactions.mutate(undefined, {
      onSuccess: (res) => {
        queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetForecastQueryKey() });
        // (#470) Refresh the badge so it drops to "No duplicates"
        // immediately after a successful cleanup instead of waiting
        // for the next page load.
        queryClient.invalidateQueries({
          queryKey: getGetDuplicateTransactionCountQueryKey(),
        });
        const removed = res.duplicatesRemoved;
        const accounts = res.accountsScanned;
        toast({
          title:
            removed === 0
              ? "No duplicates found"
              : `Merged ${removed} duplicate${removed === 1 ? "" : "s"}`,
          description:
            removed === 0
              ? `Scanned ${accounts} account${accounts === 1 ? "" : "s"} — your ledger is already clean.`
              : `Scanned ${accounts} account${accounts === 1 ? "" : "s"} and repointed ${res.resolutionsRepointed} forecast match${res.resolutionsRepointed === 1 ? "" : "es"}.`,
        });
      },
      onError: (err) => {
        toast({
          title: "Cleanup failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    });
  };

  const performUnlink = (id: string) => {
    deletePlaidItem.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListPlaidItemsQueryKey() });
          toast({ title: "Account unlinked" });
        },
      },
    );
  };

  const handleUnlink = (
    id: string,
    name: string | null | undefined,
    needsReconnect: boolean,
  ) => {
    // (#707) Intercept Disconnect on a reauth-pending item with a
    // dialog steering the user to Reconnect via Plaid first. Removing
    // the item drops Plaid's transaction cursor, so any future
    // fresh-link would re-import all history from scratch instead of
    // resuming where the dead item left off. Healthy items keep the
    // existing one-step confirm.
    if (needsReconnect) {
      setDisconnectGuardItem({ id, institutionName: name ?? null });
      return;
    }
    if (!confirm(`Unlink ${name || "this institution"}? Already-synced transactions stay; new ones will stop.`)) return;
    performUnlink(id);
  };

  const form = useForm<SettingsFormValues>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      weeklyAllowanceAmount: "0",
      monthlyAllowanceAmount: "0",
      unplannedAllowanceAmount: "0",
      primaryAccount: "",
    }
  });

  const [bucketLabels, setBucketLabels] = useState<Record<string, string>>(
    () => ({ ...DEFAULT_WEEKLY_BUCKET_LABELS }),
  );
  const [trackers, setTrackers] = useState<DaysSinceTracker[]>(
    () => [...DEFAULT_DAYS_SINCE_TRACKERS],
  );
  const { data: categories } = useListCategories();

  useEffect(() => {
    if (settings) {
      form.reset({
        weeklyAllowanceAmount: settings.weeklyAllowanceAmount,
        monthlyAllowanceAmount: settings.monthlyAllowanceAmount,
        unplannedAllowanceAmount: settings.unplannedAllowanceAmount,
        primaryAccount: settings.primaryAccount || "",
      });
      setBucketLabels(resolveWeeklyBucketLabels(settings));
      const stored = (settings.preferences as { daysSinceTrackers?: DaysSinceTracker[] } | null)
        ?.daysSinceTrackers;
      setTrackers(
        Array.isArray(stored) ? stored : [...DEFAULT_DAYS_SINCE_TRACKERS],
      );
    }
  }, [settings, form]);

  const onSubmit = (values: SettingsFormValues) => {
    updateSettings.mutate({ data: values }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
        // Allowance changes flow into Dashboard bucket caps for any month
        // without an override, so refresh those caches too.
        queryClient.invalidateQueries({ queryKey: getListDashboardBudgetsQueryKey() });
        toast({ title: "Settings updated successfully" });
      }
    });
  };

  const saveBucketLabels = () => {
    const cleaned: Record<string, string> = {};
    for (const k of SUB_BUCKETS) {
      const v = (bucketLabels[k] ?? "").trim();
      cleaned[k] = v || DEFAULT_WEEKLY_BUCKET_LABELS[k];
    }
    const nextPreferences = {
      ...(settings?.preferences ?? {}),
      weeklyBucketLabels: cleaned,
    };
    updateSettings.mutate(
      { data: { preferences: nextPreferences } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
          toast({ title: "Bucket names updated" });
        },
      },
    );
  };

  const resetBucketLabels = () => {
    setBucketLabels({ ...DEFAULT_WEEKLY_BUCKET_LABELS });
  };

  const saveTrackers = () => {
    const cleaned = trackers
      .map((t) => ({
        ...t,
        label: t.label.trim(),
        matchValue: t.matchValue.trim(),
      }))
      .filter((t) => t.label && t.matchValue);
    const nextPreferences = {
      ...(settings?.preferences ?? {}),
      daysSinceTrackers: cleaned,
    };
    updateSettings.mutate(
      { data: { preferences: nextPreferences } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
          toast({ title: "Behavior trackers saved" });
        },
      },
    );
  };

  const addTracker = () => {
    setTrackers((prev) => [
      ...prev,
      { id: newTrackerId(), label: "", matchType: "keyword", matchValue: "" },
    ]);
  };

  const removeTracker = (id: string) => {
    setTrackers((prev) => prev.filter((t) => t.id !== id));
  };

  const updateTracker = (id: string, patch: Partial<DaysSinceTracker>) => {
    setTrackers((prev) =>
      prev.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    );
  };

  const resetTrackers = () => {
    setTrackers([...DEFAULT_DAYS_SINCE_TRACKERS]);
  };

  const trackerErrors = useMemo(() => {
    const catNameById = new Map<string, string>(
      (categories ?? []).map((c) => [c.id, c.name]),
    );
    const errors: Record<string, string | null> = {};
    for (const t of trackers) {
      if (!t.matchValue.trim()) {
        errors[t.id] = null;
        continue;
      }
      errors[t.id] = compileMatcher(t, catNameById).error;
    }
    return errors;
  }, [trackers, categories]);

  const hasInvalidTracker = Object.values(trackerErrors).some((e) => e !== null);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    toast({ title: "Importing workbook..." });
    importWorkbook.mutate({ data: { file } }, {
      onSuccess: (res) => {
        {
          const c = res.counts as Record<string, number>;
          const parts = [`Processed ${c.transactions || 0} transactions.`];
          const rulesKept = c.mapping_rules_preserved || 0;
          const txKept = c.transactions_preserved || 0;
          if (rulesKept || txKept) {
            parts.push(
              `Preserved ${rulesKept} of your mapping rule${rulesKept === 1 ? "" : "s"} and ${txKept} manual category edit${txKept === 1 ? "" : "s"}.`,
            );
          }
          // Append a per-rule attribution line + a "View" deep-link to the
          // Mapping Rules page so users can immediately spot stale rules
          // mis-routing big chunks of the freshly imported workbook.
          const summary = buildRuleAttributionSummary(
            res.ruleAttributions ?? [],
          );
          if (summary.totalAttributed > 0) {
            parts.push(
              `Auto-categorized ${summary.totalAttributed} ${
                summary.totalAttributed === 1 ? "transaction" : "transactions"
              }: ${summary.top
                .map((r) => `${r.count} via '${r.pattern}'`)
                .join(", ")}${summary.extraRules > 0 ? `, +${summary.extraRules} more` : ""}.`,
            );
          }
          toast({
            title: "Import complete",
            description: parts.join(" "),
            action:
              summary.totalAttributed > 0 && summary.ruleIds.length > 0 ? (
                <ToastAction
                  altText="View matched rules"
                  onClick={() =>
                    navigate(
                      `/mapping-rules?focus=${summary.ruleIds
                        .map((id) => encodeURIComponent(id))
                        .join(",")}`,
                    )
                  }
                  data-testid="button-toast-view-import-matched-rules"
                >
                  View
                </ToastAction>
              ) : undefined,
          });
        }
        e.target.value = ''; // reset input
      },
      onError: (err) => {
        toast({ title: "Import failed", description: String(err), variant: "destructive" });
        e.target.value = '';
      }
    });
  };

  if (isLoading) {
    return null;
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">Settings</h1>
        <p className="text-muted-foreground mt-1">Configure allowances and import historical data.</p>
      </div>

      <OwnerInvitationsSection />

      <OwnerBankHealthSweepSection />

      <Card>
        <CardHeader>
          <CardTitle>Allowance Budgets</CardTitle>
          <CardDescription>Set the target amounts for discretionary allowances.</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField control={form.control} name="weeklyAllowanceAmount" render={({ field }) => (
                <FormItem>
                  <FormLabel>Weekly Allowance ($)</FormLabel>
                  <FormControl><Input type="number" step="1" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="monthlyAllowanceAmount" render={({ field }) => (
                <FormItem>
                  <FormLabel>Monthly Allowance ($)</FormLabel>
                  <FormControl><Input type="number" step="1" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <FormField control={form.control} name="unplannedAllowanceAmount" render={({ field }) => (
                <FormItem>
                  <FormLabel>Unplanned Allowance ($)</FormLabel>
                  <FormControl><Input type="number" step="1" {...field} /></FormControl>
                  <FormMessage />
                </FormItem>
              )} />
              <div className="pt-4">
                <Button type="submit" disabled={updateSettings.isPending}>Save Settings</Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              Linked Accounts
              {plaidEnv?.env && (
                <span
                  className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${
                    plaidEnv.env === "production"
                      ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-400"
                      : "border-amber-500/40 text-amber-700 dark:text-amber-400"
                  }`}
                  data-testid="badge-plaid-env"
                  title={`Plaid is running in ${plaidEnv.env} mode`}
                >
                  Plaid: {plaidEnv.env}
                </span>
              )}
            </CardTitle>
            <CardDescription>
              Connect your bank and credit card accounts via Plaid to auto-import transactions.
              {plaidEnv && !plaidEnv.configured && (
                <span className="block mt-1 text-destructive" data-testid="text-plaid-not-configured">
                  Plaid is not configured. Set <code>PLAID_CLIENT_ID</code>,{" "}
                  <code>PLAID_SECRET</code>, and <code>PLAID_ENV</code> in Secrets to
                  enable bank linking.
                </span>
              )}
              {plaidEnv?.configError && (
                <span className="block mt-1 text-destructive">{plaidEnv.configError}</span>
              )}
            </CardDescription>
          </div>
          <PlaidLinkButton />
        </CardHeader>
        {import.meta.env.DEV && plaidEnv && plaidEnv.nonProdItemCount > 0 && (
          <CardContent className="pt-0">
            <div
              className="rounded-md border border-amber-500/40 bg-amber-50 dark:bg-amber-950/20 p-3 text-sm"
              data-testid="banner-non-prod-cleanup"
            >
              <div className="font-medium">
                {plaidEnv.nonProdItemCount} linked institution
                {plaidEnv.nonProdItemCount === 1 ? "" : "s"} from a non-production
                Plaid environment
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                Their access tokens won't work against Plaid Production and will
                fail to sync. Remove them so only real, Production-linked banks
                remain.
              </div>
              <ul className="mt-2 text-xs list-disc list-inside text-muted-foreground">
                {plaidEnv.nonProdItems.map((it) => (
                  <li key={it.id}>
                    {it.institutionName ?? "Unnamed institution"}{" "}
                    <span className="uppercase tracking-wider">({it.env ?? "unknown"})</span>
                  </li>
                ))}
              </ul>
              <div className="mt-2">
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={cleanupNonProd.isPending}
                  onClick={() => {
                    if (
                      !confirm(
                        `Permanently remove ${plaidEnv.nonProdItemCount} non-production Plaid link(s)? Imported transactions stay; new syncs from these institutions will stop.`,
                      )
                    )
                      return;
                    cleanupNonProd.mutate(undefined, {
                      onSuccess: (res) => {
                        queryClient.invalidateQueries({ queryKey: getListPlaidItemsQueryKey() });
                        queryClient.invalidateQueries({ queryKey: getGetPlaidEnvironmentQueryKey() });
                        toast({
                          title: "Cleanup complete",
                          description: `Removed ${res.removed} non-production link(s).`,
                        });
                      },
                      onError: (err) =>
                        toast({
                          title: "Cleanup failed",
                          description: String(err),
                          variant: "destructive",
                        }),
                    });
                  }}
                  data-testid="button-cleanup-non-prod"
                >
                  Remove non-production links
                </Button>
              </div>
            </div>
          </CardContent>
        )}
        <CardContent className="space-y-3">
          {(plaidItems ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">
              No accounts linked yet. Click "Link a Bank or Card" to get started.
            </p>
          )}
          {(plaidItems ?? []).length > 0 && (
            // (#261) Manual entry point for the cron-driven consent
            // refresh job. Rendered above the rows so the action is in
            // sight when users hover the "Disconnect date checked"
            // sublines they're trying to verify, but only once at least
            // one bank is linked (no items = nothing to refresh).
            <div
              className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-muted/10 p-3"
              data-testid="row-refresh-consent-expirations"
            >
              <div className="text-xs text-muted-foreground">
                Disconnect dates auto-refresh once a day. Use this to
                check now if a countdown looks stale.
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefreshConsentExpirations}
                disabled={refreshConsentExpirations.isPending}
                data-testid="button-refresh-consent-expirations"
              >
                <RefreshCw
                  className={`w-3.5 h-3.5 mr-1.5 ${
                    refreshConsentExpirations.isPending ? "animate-spin" : ""
                  }`}
                />
                Refresh disconnect dates
              </Button>
            </div>
          )}
          {(plaidItems ?? []).length > 0 && duplicateCount > 0 && (
            // (#458) Surfaces the /forecast/dedupe-transactions cleanup
            // so users with pre-fix duplicate Chase/Plaid rows can fix
            // their own ledger without contacting support. Sits next to
            // the consent-refresh row so all "maintenance" actions on
            // linked accounts are co-located.
            // (#470) Hidden entirely when the read-only count returns
            // zero so a clean ledger doesn't show a perpetual "Clean
            // up" nudge — the badge next to the button shows the
            // exact count when there is something to clean.
            <div
              className="flex items-center justify-between gap-3 rounded-md border border-border/60 bg-muted/10 p-3"
              data-testid="row-dedupe-transactions"
            >
              <div className="text-xs text-muted-foreground">
                Find and merge duplicate transactions across your linked
                accounts. Safe to run any time.
              </div>
              <div className="flex items-center gap-2">
                <span
                  className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-700 dark:text-amber-400"
                  data-testid="badge-duplicate-transaction-count"
                  title="Approximate number of rows the cleanup would merge into their twins."
                >
                  {duplicateCount} duplicate{duplicateCount === 1 ? "" : "s"} found
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleDedupeTransactions}
                  disabled={dedupeTransactions.isPending}
                  data-testid="button-dedupe-transactions"
                >
                  <RefreshCw
                    className={`w-3.5 h-3.5 mr-1.5 ${
                      dedupeTransactions.isPending ? "animate-spin" : ""
                    }`}
                  />
                  Clean up duplicate transactions
                </Button>
              </div>
            </div>
          )}
          {(plaidItems ?? []).map((item) => {
            const isSyncing = isSyncPending && syncingItemId === item.id;
            const isAnySyncing = isSyncPending;
            // (#710) Synthetic seed rows (item_id like 'seed-…') aren't real
            // Plaid links — Reconnect would no-op. Hide the badge + CTA for
            // them so the user isn't pushed to relink a placeholder.
            const needsReconnect =
              isPlaidReauthCode(item.lastSyncErrorCode) &&
              !isSyntheticPlaidItem({ itemId: item.itemId });
            return (
              <div
                key={item.id}
                className="rounded-md border border-border bg-muted/20 p-4"
                data-testid={`plaid-item-${item.id}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <Building2 className="w-5 h-5 mt-0.5 text-muted-foreground" />
                    <div>
                      <div className="font-medium flex items-center gap-2 flex-wrap">
                        <span>{item.institutionName || "Linked institution"}</span>
                        {needsReconnect && (
                          <span
                            className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-destructive/50 text-destructive bg-destructive/10"
                            data-testid={`badge-needs-reconnect-${item.id}`}
                            // (#228) Use the per-code reason so the tooltip
                            // explains *why* (saved login expired vs.
                            // consent expiring vs. pending disconnect)
                            // before the user clicks Reconnect.
                            // (#238) Pass the item's
                            // `consent_expiration_time` cutoff so
                            // PENDING_EXPIRATION / PENDING_DISCONNECT
                            // tooltips name the actual disconnect date
                            // ("Chase will disconnect on May 21 —
                            // reconnect now to keep it linked.")
                            // instead of vague "soon" copy.
                            title={`${plaidReauthReason(item.lastSyncErrorCode, {
                              consentExpirationAt: item.consentExpirationAt,
                              institutionName: item.institutionName,
                            })} Click Reconnect to fix it.`}
                          >
                            Needs reconnect
                          </span>
                        )}
                        {item.stillPreparing && (
                          <span
                            className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-700 dark:text-amber-400"
                            data-testid={`badge-still-preparing-${item.id}`}
                            title="Plaid is still staging the historical batch for this freshly linked bank — try Sync again in a minute."
                          >
                            {(() => {
                              const elapsed = formatPreparingElapsed(item.stillPreparingSince, nowTick);
                              return elapsed
                                ? `Still preparing · ${elapsed}`
                                : "Still preparing";
                            })()}
                          </span>
                        )}
                      </div>
                      <div
                        className="text-xs text-muted-foreground"
                        data-testid={`text-last-synced-${item.id}`}
                      >
                        {item.lastSyncedAt
                          ? (() => {
                              // (#723) Append a scannable relative-time
                              // hint ("· 4h ago") next to the absolute
                              // timestamp so the user can tell at a
                              // glance whether the bank tile is fresh —
                              // without doing the date math themselves.
                              // Plaid's data is the "as of" anchor; we
                              // word it that way explicitly so the user
                              // stops expecting every click on Sync to
                              // produce instantly fresh pending data on
                              // items whose institutions only update on
                              // Plaid's ~6 h scheduled poll. Re-uses the
                              // `nowTick` from the surrounding component
                              // so the hint advances live without an
                              // additional setInterval.
                              const ts = new Date(item.lastSyncedAt);
                              return `Plaid data as of ${ts.toLocaleString()} · ${formatRelativeTimeFromNow(ts, nowTick)}`;
                            })()
                          : "Not yet synced"}
                      </div>
                      {/* (#258) Show when the disconnect-cutoff was last
                          verified against Plaid so users (and support)
                          can confirm the countdown above the "Needs
                          reconnect" badge is fresh — distinct from the
                          last-synced timestamp, which only reflects the
                          /transactions/sync call. Hidden until the row
                          has been refreshed at least once (e.g. items
                          linked before this column existed). */}
                      {item.consentExpirationLastRefreshedAt && (() => {
                        // (#260) Once the daily refresh hasn't advanced this
                        // timestamp in ~3 days, surface an amber chip so the
                        // user can hit Sync and confirm whether the
                        // disconnect cutoff above is still trustworthy.
                        const isStale = isConsentRefreshStale(
                          item.consentExpirationLastRefreshedAt,
                          nowTick,
                        );
                        const age = formatConsentRefreshAge(
                          item.consentExpirationLastRefreshedAt,
                          nowTick,
                        );
                        return (
                          <div
                            className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap"
                            data-testid={`text-consent-refreshed-${item.id}`}
                            title={
                              item.consentExpirationAt
                                ? `Disconnect date on file: ${new Date(
                                    item.consentExpirationAt,
                                  ).toLocaleString()}`
                                : "Plaid does not report a disconnect date for this item."
                            }
                          >
                            <span>
                              Disconnect date checked{" "}
                              {new Date(
                                item.consentExpirationLastRefreshedAt,
                              ).toLocaleString()}
                            </span>
                            {isStale && (
                              <span
                                className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-700 dark:text-amber-400"
                                data-testid={`badge-consent-refresh-stale-${item.id}`}
                                title={`The daily check hasn't advanced this timestamp in ${age ?? "several days"}. The disconnect date above may be out of date — click Sync to re-verify with Plaid.`}
                              >
                                Disconnect date stale
                              </span>
                            )}
                          </div>
                        );
                      })()}
                      {item.stillPreparing && isPreparingStalled(item.stillPreparingSince, nowTick) && (
                        <div
                          className="text-xs text-amber-700 dark:text-amber-400 mt-1"
                          data-testid={`text-preparing-stalled-${item.id}`}
                        >
                          This is taking longer than usual. Try unlinking and
                          relinking this bank.
                        </div>
                      )}
                      {item.lastSyncError && (
                        <div
                          className="text-xs text-destructive mt-1"
                          data-testid={`text-last-sync-error-${item.id}`}
                        >
                          {formatPlaidErrorForDisplay(item.lastSyncError)}
                        </div>
                      )}
                      {/* (#725) Surface a "Re-enable refresh" link when
                          the server has the INVALID_PRODUCT short-circuit
                          stamp set on this item. Clicking it clears the
                          stamp + immediately triggers a Sync so the user
                          gets confirmation in one click. The server-side
                          self-heal also clears the stamp on the first
                          successful refresh, so this link is the explicit
                          user-driven escape hatch when the user has just
                          enabled the `transactions_refresh` add-on. */}
                      {item.refreshProductDisabledAt && (
                        <div
                          className="text-xs text-muted-foreground mt-1"
                          data-testid={`text-refresh-disabled-${item.id}`}
                        >
                          Real-time refresh is paused for this bank.{" "}
                          <button
                            type="button"
                            className="underline text-primary hover:no-underline disabled:opacity-50"
                            disabled={
                              clearRefreshDisabled.isPending || isAnySyncing
                            }
                            data-testid={`button-reenable-refresh-${item.id}`}
                            onClick={async () => {
                              try {
                                await clearRefreshDisabled.mutateAsync({
                                  id: item.id,
                                });
                                await queryClient.invalidateQueries({
                                  queryKey: getListPlaidItemsQueryKey(),
                                });
                                await handleSync(item.id);
                              } catch (e) {
                                toast({
                                  title: "Couldn't re-enable refresh",
                                  description:
                                    e instanceof Error
                                      ? e.message
                                      : "Try again in a moment.",
                                  variant: "destructive",
                                });
                              }
                            }}
                          >
                            Re-enable refresh
                          </button>
                        </div>
                      )}
                      {/* (#265) Latest /item/get failure captured during the
                          consent-refresh path (manual button, on-sync
                          PENDING_EXPIRATION refresh, or daily cron). Rendered
                          inline under the "Disconnect date checked …" line so
                          a user who walks away after running the refresh can
                          still see *why* this bank's check failed without
                          having to re-trigger it. Styled like lastSyncError. */}
                      {item.consentExpirationLastRefreshError && (
                        <div
                          className="text-xs text-destructive mt-1"
                          data-testid={`text-consent-refresh-error-${item.id}`}
                        >
                          Couldn't verify disconnect date:{" "}
                          {formatPlaidErrorForDisplay(
                            item.consentExpirationLastRefreshError,
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {needsReconnect && (
                      <PlaidReconnectButton
                        itemId={item.id}
                        institutionName={item.institutionName ?? null}
                        size="sm"
                      />
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleSync(item.id)}
                      disabled={isAnySyncing}
                      data-testid={`button-sync-${item.id}`}
                    >
                      <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${isSyncing ? "animate-spin" : ""}`} />
                      Sync
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() =>
                        handleUnlink(
                          item.id,
                          item.institutionName,
                          needsReconnect,
                        )
                      }
                      disabled={deletePlaidItem.isPending}
                      data-testid={`button-unlink-${item.id}`}
                    >
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                </div>
                <div className="mt-2 ml-8">
                  <PlaidSyncHistory
                    itemId={item.id}
                    institutionName={item.institutionName}
                  />
                </div>
                {item.accounts.length > 0 && (
                  <ul className="mt-3 ml-8 text-sm text-muted-foreground space-y-2">
                    {item.accounts.map((a) => (
                      <li key={a.id} className="space-y-1">
                        <div>
                          {a.name || a.officialName || "Account"}
                          {a.mask ? ` ••${a.mask}` : ""}
                          {a.subtype ? ` · ${a.subtype}` : ""}
                        </div>
                        {/* (#361) First-sync dedupe gate. Once the
                            account has completed its first sync the
                            override is no longer accepted, so we hide
                            the picker entirely (server returns 409 on
                            late writes anyway). Until then the user
                            can shift the auto-detected cutoff earlier
                            (pull more history) or later (skip more
                            potential duplicates). */}
                        {!a.firstSyncCompletedAt && (
                          <PlaidImportCutoffPicker
                            accountId={a.id}
                            initialValue={a.importCutoffDate ?? null}
                          />
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Weekly Sub-Bucket Names</CardTitle>
          <CardDescription>
            Rename the four weekly spending sub-buckets. The underlying tags
            (groceries / dining / entertainment / misc) stay the same so existing
            transactions keep their bucket — only the labels you see change.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {SUB_BUCKETS.map((b) => (
              <div key={b} className="space-y-1.5">
                <Label htmlFor={`bucket-${b}`} className="text-xs uppercase tracking-widest text-muted-foreground">
                  {b}
                </Label>
                <Input
                  id={`bucket-${b}`}
                  value={bucketLabels[b] ?? ""}
                  placeholder={DEFAULT_WEEKLY_BUCKET_LABELS[b]}
                  onChange={(e) =>
                    setBucketLabels((prev) => ({ ...prev, [b]: e.target.value }))
                  }
                />
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 pt-2">
            <Button onClick={saveBucketLabels} disabled={updateSettings.isPending}>
              Save Bucket Names
            </Button>
            <Button type="button" variant="outline" onClick={resetBucketLabels}>
              Reset to defaults
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Behavior Trackers</CardTitle>
          <CardDescription>
            Pick the "days since last…" tiles you want on the Reports → Behavior
            tab. Match by category name or by a keyword in the description
            (separate keywords with <code>|</code> for an "or" match,
            e.g. <code>starbucks|coffee|cafe</code>).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {trackers.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No trackers yet. Add one to start tracking a habit.
            </p>
          )}
          {trackers.map((t) => (
            <div
              key={t.id}
              className="grid grid-cols-1 md:grid-cols-[1fr_140px_1fr_auto] gap-2 items-end rounded-md border border-border bg-muted/20 p-3"
              data-testid={`tracker-row-${t.id}`}
            >
              <div className="space-y-1">
                <Label className="text-xs uppercase tracking-widest text-muted-foreground">
                  Tile label
                </Label>
                <Input
                  value={t.label}
                  placeholder="e.g. Takeout"
                  onChange={(e) => updateTracker(t.id, { label: e.target.value })}
                  data-testid={`input-tracker-label-${t.id}`}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs uppercase tracking-widest text-muted-foreground">
                  Match by
                </Label>
                <Select
                  value={t.matchType}
                  onValueChange={(v) =>
                    updateTracker(t.id, { matchType: v as "category" | "keyword" })
                  }
                >
                  <SelectTrigger data-testid={`select-tracker-type-${t.id}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="keyword">Keyword</SelectItem>
                    <SelectItem value="category">Category</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs uppercase tracking-widest text-muted-foreground">
                  {t.matchType === "category" ? "Category name contains" : "Description contains"}
                </Label>
                <Input
                  value={t.matchValue}
                  placeholder={t.matchType === "category" ? "dining" : "amazon"}
                  list={t.matchType === "category" ? "tracker-category-suggestions" : undefined}
                  onChange={(e) => updateTracker(t.id, { matchValue: e.target.value })}
                  data-testid={`input-tracker-value-${t.id}`}
                  aria-invalid={trackerErrors[t.id] ? true : undefined}
                />
                {trackerErrors[t.id] && (
                  <p
                    className="text-xs text-amber-700 dark:text-amber-400"
                    data-testid={`tracker-value-error-${t.id}`}
                    title={trackerErrors[t.id] ?? undefined}
                  >
                    Couldn't read this rule
                  </p>
                )}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => removeTracker(t.id)}
                data-testid={`button-remove-tracker-${t.id}`}
              >
                <Trash2 className="w-4 h-4 text-destructive" />
              </Button>
            </div>
          ))}
          <datalist id="tracker-category-suggestions">
            {(categories ?? []).map((c) => (
              <option key={c.id} value={c.name} />
            ))}
          </datalist>
          <div className="flex items-center gap-2 pt-2">
            <Button type="button" variant="outline" onClick={addTracker} data-testid="button-add-tracker">
              <Plus className="w-4 h-4 mr-1.5" /> Add tracker
            </Button>
            <Button
              onClick={saveTrackers}
              disabled={updateSettings.isPending || hasInvalidTracker}
              data-testid="button-save-trackers"
            >
              Save Trackers
            </Button>
            {hasInvalidTracker && (
              <p
                className="text-xs text-amber-700 dark:text-amber-400"
                data-testid="tracker-save-blocked"
              >
                Fix the invalid rule before saving.
              </p>
            )}
            <Button type="button" variant="ghost" onClick={resetTrackers}>
              Reset to defaults
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Spreadsheet Import</CardTitle>
          <CardDescription>Migrate your legacy Hubele Family Budget Excel file.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div>
            <a href={`${import.meta.env.BASE_URL}sample/Hubele_Family_Budget_v36.xlsx`} download className="text-primary font-medium hover:underline flex items-center gap-2 mb-4">
              <Download className="w-4 h-4" /> Download Sample Workbook
            </a>
            <p className="text-sm text-muted-foreground mb-2">Upload a populated workbook to bootstrap your ledger. We'll extract transactions, debts, recurring bills, and configuration.</p>
          </div>
          
          <div className="flex items-center gap-4">
            <Button variant="outline" className="relative cursor-pointer" disabled={importWorkbook.isPending}>
              <UploadCloud className="w-4 h-4 mr-2" />
              {importWorkbook.isPending ? "Importing..." : "Upload .xlsx File"}
              <input 
                type="file" 
                accept=".xlsx" 
                className="absolute inset-0 opacity-0 cursor-pointer" 
                onChange={handleFileUpload}
                disabled={importWorkbook.isPending}
              />
            </Button>
          </div>
        </CardContent>
      </Card>

      <AlertDialog
        open={disconnectGuardItem !== null}
        onOpenChange={(v) => {
          if (!v) setDisconnectGuardItem(null);
        }}
      >
        <AlertDialogContent data-testid="dialog-disconnect-guard">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Reconnect{" "}
              {disconnectGuardItem?.institutionName || "this bank"} via Plaid
              instead?
            </AlertDialogTitle>
            <AlertDialogDescription>
              If you remove this, you'll lose Plaid's transaction cursor and
              any future sync starts from scratch. Reconnecting via Plaid
              keeps your history intact and resumes where the broken
              connection left off.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-disconnect-guard-cancel">
              Cancel
            </AlertDialogCancel>
            {disconnectGuardItem && (
              // (#707) Do NOT wrap this in an onClick that closes the
              // dialog — PlaidReconnectButton kicks off an async
              // token fetch and only opens Plaid Link once the token
              // state lands. Unmounting it mid-flow strands the user
              // with no Plaid modal. The useEffect below closes the
              // dialog automatically once /plaid/items reports the
              // item is no longer in a reauth state. The button copy
              // ("Reconnect" from the shared component) is what
              // satisfies the "Reconnect via Plaid" CTA contract.
              <PlaidReconnectButton
                itemId={disconnectGuardItem.id}
                institutionName={disconnectGuardItem.institutionName}
              />
            )}
            <AlertDialogAction
              onClick={() => {
                if (disconnectGuardItem) {
                  performUnlink(disconnectGuardItem.id);
                  setDisconnectGuardItem(null);
                }
              }}
              data-testid="button-disconnect-guard-remove-anyway"
            >
              Remove anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// (#361) Per-account picker for the first-sync `importCutoffDate`
// override. Only mounted while the account's `firstSyncCompletedAt`
// is null (the parent gates the render). On submit it PATCHes the
// account, then invalidates the items list so the new value flows
// back into the parent. Empty input -> null (clears the cutoff and
// lets the first sync ingest everything Plaid returns).
function PlaidImportCutoffPicker({
  accountId,
  initialValue,
}: {
  accountId: string;
  initialValue: string | null;
}) {
  const [value, setValue] = useState<string>(initialValue ?? "");
  useEffect(() => {
    setValue(initialValue ?? "");
  }, [initialValue]);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const mutation = useUpdatePlaidImportCutoffDate();
  const dirty = (initialValue ?? "") !== value;
  const onSave = () => {
    mutation.mutate(
      {
        id: accountId,
        data: { importCutoffDate: value === "" ? null : value },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListPlaidItemsQueryKey(),
          });
          toast({ title: "Import cutoff updated" });
        },
        onError: (e: unknown) => {
          toast({
            title: "Couldn't update cutoff",
            description:
              e instanceof Error ? e.message : "Please try again.",
            variant: "destructive",
          });
        },
      },
    );
  };
  return (
    <div className="flex items-center gap-2 text-xs">
      <Label htmlFor={`cutoff-${accountId}`} className="text-xs">
        Import history after
      </Label>
      <Input
        id={`cutoff-${accountId}`}
        type="date"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="h-7 w-36 text-xs"
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-7 px-2 text-xs"
        disabled={!dirty || mutation.isPending}
        onClick={onSave}
      >
        Save
      </Button>
    </div>
  );
}
