import { useState, useEffect } from "react";
import {
  useGetSettings,
  useUpdateSettings,
  useImportWorkbook,
  getGetSettingsQueryKey,
  useListPlaidItems,
  useDeletePlaidItem,
  useSyncPlaidTransactions,
  getListPlaidItemsQueryKey,
  getListTransactionsQueryKey,
} from "@workspace/api-client-react";
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
import { UploadCloud, Download, RefreshCw, Trash2, Building2 } from "lucide-react";
import { SUB_BUCKETS, DEFAULT_WEEKLY_BUCKET_LABELS, resolveWeeklyBucketLabels } from "@/lib/weeklyBuckets";
import { PlaidLinkButton } from "@/components/plaid-link-button";

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
  const syncPlaid = useSyncPlaidTransactions();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleSync = (itemId?: string) => {
    syncPlaid.mutate(
      { data: itemId ? { itemId } : {} },
      {
        onSuccess: (res) => {
          queryClient.invalidateQueries({ queryKey: getListPlaidItemsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
          const totals = (res.items ?? []).reduce(
            (acc, r) => {
              acc.added += r.added ?? 0;
              acc.modified += r.modified ?? 0;
              acc.removed += r.removed ?? 0;
              return acc;
            },
            { added: 0, modified: 0, removed: 0 },
          );
          toast({
            title: "Sync complete",
            description: `Added ${totals.added}, updated ${totals.modified}, removed ${totals.removed}.`,
          });
        },
        onError: (err) => {
          toast({ title: "Sync failed", description: String(err), variant: "destructive" });
        },
      },
    );
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

  useEffect(() => {
    if (settings) {
      form.reset({
        weeklyAllowanceAmount: settings.weeklyAllowanceAmount,
        monthlyAllowanceAmount: settings.monthlyAllowanceAmount,
        unplannedAllowanceAmount: settings.unplannedAllowanceAmount,
        primaryAccount: settings.primaryAccount || "",
      });
      setBucketLabels(resolveWeeklyBucketLabels(settings));
    }
  }, [settings, form]);

  const onSubmit = (values: SettingsFormValues) => {
    updateSettings.mutate({ data: values }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetSettingsQueryKey() });
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

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    toast({ title: "Importing workbook..." });
    importWorkbook.mutate({ data: { file } }, {
      onSuccess: (res) => {
        toast({ title: "Import complete", description: `Processed ${res.counts.transactions || 0} transactions.` });
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
            <CardTitle>Linked Accounts</CardTitle>
            <CardDescription>Connect your bank and credit card accounts via Plaid to auto-import transactions.</CardDescription>
          </div>
          <PlaidLinkButton />
        </CardHeader>
        <CardContent className="space-y-3">
          {(plaidItems ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">
              No accounts linked yet. Click "Link a Bank or Card" to get started.
            </p>
          )}
          {(plaidItems ?? []).map((item) => {
            const isSyncing = syncPlaid.isPending;
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
                      <div className="font-medium">{item.institutionName || "Linked institution"}</div>
                      <div className="text-xs text-muted-foreground">
                        {item.lastSyncedAt
                          ? `Last synced ${new Date(item.lastSyncedAt).toLocaleString()}`
                          : "Not yet synced"}
                      </div>
                      {item.lastSyncError && (
                        <div className="text-xs text-destructive mt-1">{item.lastSyncError}</div>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleSync(item.id)}
                      disabled={isSyncing}
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
