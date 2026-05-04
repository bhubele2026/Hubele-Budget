import { useState, useEffect, useMemo } from "react";
import {
  useGetSettings,
  useUpdateSettings,
  useImportWorkbook,
  getGetSettingsQueryKey,
  getListDashboardBudgetsQueryKey,
  useListPlaidItems,
  useDeletePlaidItem,
  useGetPlaidEnvironment,
  useCleanupNonProdPlaidItems,
  getGetPlaidEnvironmentQueryKey,
  useListCategories,
  getListPlaidItemsQueryKey,
} from "@workspace/api-client-react";
import { usePlaidSync, formatPlaidErrorForDisplay } from "@/hooks/use-plaid-sync";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useToast } from "@/hooks/use-toast";
import { UploadCloud, Download, RefreshCw, Trash2, Building2, Plus } from "lucide-react";
import { SUB_BUCKETS, DEFAULT_WEEKLY_BUCKET_LABELS, resolveWeeklyBucketLabels } from "@/lib/weeklyBuckets";
import { PlaidLinkButton } from "@/components/plaid-link-button";
import { formatPreparingElapsed, isPreparingStalled } from "@/lib/plaidPreparing";
import { OwnerInvitationsSection } from "@/components/owner-invitations";
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
  const { data: plaidItems } = useListPlaidItems();
  const deletePlaidItem = useDeletePlaidItem();
  const { runSync, isPending: isSyncPending } = usePlaidSync();
  // Track which row's per-item Sync button was just clicked so only THAT
  // row's spinner spins (the underlying mutation is global, so without this
  // every row would animate at once).
  const [syncingItemId, setSyncingItemId] = useState<string | null>(null);
  const { data: plaidEnv } = useGetPlaidEnvironment();
  const cleanupNonProd = useCleanupNonProdPlaidItems();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleSync = (itemId?: string) => {
    if (itemId) setSyncingItemId(itemId);
    void runSync(itemId ? { itemId } : {}).finally(() => {
      if (itemId) setSyncingItemId((curr) => (curr === itemId ? null : curr));
    });
  };

  const handleUnlink = (id: string, name: string | null | undefined) => {
    if (!confirm(`Unlink ${name || "this institution"}? Already-synced transactions stay; new ones will stop.`)) return;
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
          toast({ title: "Import complete", description: parts.join(" ") });
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
    return <div className="space-y-4"><Skeleton className="h-10 w-48" /><Skeleton className="h-64 w-full" /></div>;
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">Settings</h1>
        <p className="text-muted-foreground mt-1">Configure allowances and import historical data.</p>
      </div>

      <OwnerInvitationsSection />

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
          {(plaidItems ?? []).map((item) => {
            const isSyncing = isSyncPending && syncingItemId === item.id;
            const isAnySyncing = isSyncPending;
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
                        {item.stillPreparing && (
                          <span
                            className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-700 dark:text-amber-400"
                            data-testid={`badge-still-preparing-${item.id}`}
                            title="Plaid is still staging the historical batch for this freshly linked bank — try Sync again in a minute."
                          >
                            {(() => {
                              const elapsed = formatPreparingElapsed(item.stillPreparingSince);
                              return elapsed
                                ? `Still preparing · ${elapsed}`
                                : "Still preparing";
                            })()}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {item.lastSyncedAt
                          ? `Last synced ${new Date(item.lastSyncedAt).toLocaleString()}`
                          : "Not yet synced"}
                      </div>
                      {item.stillPreparing && isPreparingStalled(item.stillPreparingSince) && (
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
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
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
                      onClick={() => handleUnlink(item.id, item.institutionName)}
                      disabled={deletePlaidItem.isPending}
                      data-testid={`button-unlink-${item.id}`}
                    >
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                </div>
                {item.accounts.length > 0 && (
                  <ul className="mt-3 ml-8 text-sm text-muted-foreground space-y-1">
                    {item.accounts.map((a) => (
                      <li key={a.id}>
                        {a.name || a.officialName || "Account"}
                        {a.mask ? ` ••${a.mask}` : ""}
                        {a.subtype ? ` · ${a.subtype}` : ""}
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
    </div>
  );
}
