import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetForecast,
  useUpsertForecastResolution,
  useDeleteForecastResolution,
  useCloseForecastMonth,
  useReopenForecastMonth,
  useUpdateForecastSettings,
  getGetForecastQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  buildLineRegister,
  buildBucket,
  findCandidates,
  monthKey,
  type LineRow,
  type Resolution,
  type Transaction as MatchTxn,
} from "@/lib/forecastMatch";
import type { CashEvent } from "@/lib/forecast";
import { Lock, Unlock, Settings as SettingsIcon, X, Check, AlertCircle } from "lucide-react";

function statusBadge(s: string) {
  const map: Record<string, { label: string; cls: string }> = {
    pending_plan: { label: "Pending plan", cls: "bg-amber-100 text-amber-900 border-amber-200" },
    pending_bank: { label: "Pending bank", cls: "bg-sky-100 text-sky-900 border-sky-200" },
    future: { label: "Upcoming", cls: "bg-muted text-muted-foreground" },
    matched: { label: "Matched", cls: "bg-primary/15 text-primary border-primary/30" },
    missed: { label: "Missed", cls: "bg-destructive/10 text-destructive border-destructive/30" },
    ignored_unforecasted: { label: "Unplanned", cls: "bg-muted text-muted-foreground" },
    unplanned: { label: "Unplanned", cls: "bg-muted text-muted-foreground" },
  };
  const v = map[s] ?? { label: s, cls: "bg-muted text-muted-foreground" };
  return <Badge variant="outline" className={v.cls}>{v.label}</Badge>;
}

export default function ForecastPage() {
  const { data, isLoading } = useGetForecast();
  const qc = useQueryClient();
  const { toast } = useToast();

  const upsertResolution = useUpsertForecastResolution();
  const deleteResolution = useDeleteForecastResolution();
  const closeMonth = useCloseForecastMonth();
  const reopenMonth = useReopenForecastMonth();
  const updateSettings = useUpdateForecastSettings();

  const [selectedRow, setSelectedRow] = useState<LineRow | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftDays, setDraftDays] = useState("90");
  const [draftBalance, setDraftBalance] = useState("0");

  const today = useMemo(() => new Date(), []);
  const currentMonth = useMemo(
    () => `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`,
    [today],
  );
  const [monthFilter, setMonthFilter] = useState(currentMonth);

  const closedMonths = useMemo(
    () => new Set(data?.closedMonths ?? []),
    [data?.closedMonths],
  );

  const register = useMemo(() => {
    if (!data) return null;
    const events = (data.events ?? []) as CashEvent[];
    const txns = ((data.transactions ?? []) as unknown as MatchTxn[]).filter(
      (t) => t.forecastFlag,
    );
    const resolutions = (data.resolutions ?? []) as Resolution[];
    return buildLineRegister({
      events,
      txns,
      resolutions,
      closedMonths,
      startBalance: Number(data.settings.startingBalance) || 0,
      fromISO: data.fromDate,
      toISO: data.toDate,
      today,
    });
  }, [data, closedMonths, today]);

  const bucket = useMemo(() => {
    if (!register || !data) return [];
    return buildBucket({
      allPlan: register.allPlan,
      allBank: register.allBank,
      resolutions: (data.resolutions ?? []) as Resolution[],
      closedMonths,
      monthFilter,
    });
  }, [register, data, closedMonths, monthFilter]);

  const monthsAvailable = useMemo(() => {
    if (!register) return [currentMonth];
    const set = new Set<string>([currentMonth]);
    for (const p of register.allPlan) set.add(monthKey(p.date));
    for (const b of register.allBank) set.add(monthKey(b.date));
    return Array.from(set).sort();
  }, [register, currentMonth]);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getGetForecastQueryKey() });

  const handleOpenRow = (row: LineRow) => setSelectedRow(row);
  const closeDialog = () => setSelectedRow(null);

  const onMatch = (row: LineRow, candidate: LineRow) => {
    const planRow = row.kind === "plan" ? row : (candidate as any);
    const bankRow = row.kind === "bank" ? row : (candidate as any);
    upsertResolution.mutate(
      {
        data: {
          status: "matched",
          recurringItemId: planRow.itemId,
          occurrenceDate: planRow.date,
          matchedTxnId: bankRow.txn.id,
        },
      },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Matched" });
          closeDialog();
        },
      },
    );
  };

  const onMarkMissed = (row: LineRow) => {
    if (row.kind !== "plan") return;
    upsertResolution.mutate(
      {
        data: {
          status: "missed",
          recurringItemId: row.itemId,
          occurrenceDate: row.date,
        },
      },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Marked missed" });
          closeDialog();
        },
      },
    );
  };

  const onMarkUnplanned = (row: LineRow) => {
    if (row.kind !== "bank") return;
    upsertResolution.mutate(
      {
        data: {
          status: "ignored_unforecasted",
          matchedTxnId: row.txn.id,
        },
      },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Marked unplanned" });
          closeDialog();
        },
      },
    );
  };

  const onUndo = (resolutionId: string) => {
    deleteResolution.mutate(
      { id: resolutionId },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Undone" });
        },
      },
    );
  };

  const onCloseMonth = () => {
    closeMonth.mutate(
      { data: { monthKey: monthFilter } },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: `Closed ${monthFilter}` });
        },
      },
    );
  };
  const onReopenMonth = () => {
    reopenMonth.mutate(
      { monthKey: monthFilter },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: `Reopened ${monthFilter}` });
        },
      },
    );
  };

  const openSettings = () => {
    setDraftDays(String(data?.settings.daysAhead ?? 90));
    setDraftBalance(String(data?.settings.startingBalance ?? "0"));
    setSettingsOpen(true);
  };
  const saveSettings = () => {
    updateSettings.mutate(
      {
        data: {
          daysAhead: Number(draftDays) || 90,
          startingBalance: draftBalance,
        },
      },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Settings saved" });
          setSettingsOpen(false);
        },
      },
    );
  };

  if (isLoading || !data || !register) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  const isClosed = closedMonths.has(monthFilter);

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground tracking-tight">
            Cash Forecast
          </h1>
          <p className="text-muted-foreground mt-1">
            Match planned bills against bank activity, then close the month.
          </p>
        </div>
        <Button variant="outline" onClick={openSettings}>
          <SettingsIcon className="w-4 h-4 mr-2" /> Settings
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Starting balance</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(data.settings.startingBalance)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Forecast horizon</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data.settings.daysAhead} days</div>
            <div className="text-xs text-muted-foreground mt-1">
              {formatDate(data.fromDate)} → {formatDate(data.toDate)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Open items</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{register.rows.length}</div>
            <div className="text-xs text-muted-foreground mt-1">awaiting triage</div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="register" className="w-full">
        <TabsList>
          <TabsTrigger value="register">Active Register</TabsTrigger>
          <TabsTrigger value="bucket">Review Bucket</TabsTrigger>
        </TabsList>

        <TabsContent value="register" className="mt-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle>Pending plan ↔ bank items</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="divide-y divide-border">
                {register.rows.length === 0 && (
                  <div className="p-12 text-center text-muted-foreground">
                    Nothing pending. All caught up.
                  </div>
                )}
                {register.rows.map((row, i) => (
                  <button
                    key={`${row.kind}-${row.date}-${i}`}
                    onClick={() => handleOpenRow(row)}
                    className="w-full text-left p-4 flex items-center justify-between hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Badge variant="outline" className={row.kind === "bank" ? "bg-sky-50 text-sky-900 border-sky-200" : "bg-amber-50 text-amber-900 border-amber-200"}>
                        {row.kind === "bank" ? "Bank" : "Plan"}
                      </Badge>
                      <div className="min-w-0">
                        <div className="font-medium text-sm truncate">
                          {row.kind === "bank" ? row.txn.description : row.label}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formatDate(row.date)}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      {statusBadge(row.status)}
                      <span className={`font-medium tabular-nums ${row.amount < 0 ? "text-destructive" : "text-primary"}`}>
                        {formatCurrency(row.amount)}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="bucket" className="mt-4 space-y-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <Label className="text-sm">Month</Label>
              <Select value={monthFilter} onValueChange={setMonthFilter}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {monthsAvailable.map((m) => (
                    <SelectItem key={m} value={m}>{m}{closedMonths.has(m) ? " (closed)" : ""}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {isClosed && (
                <Badge className="bg-muted text-muted-foreground border">
                  <Lock className="w-3 h-3 mr-1" /> Closed
                </Badge>
              )}
            </div>
            {isClosed ? (
              <Button variant="outline" onClick={onReopenMonth}>
                <Unlock className="w-4 h-4 mr-2" /> Reopen month
              </Button>
            ) : (
              <Button onClick={onCloseMonth} variant="outline">
                <Lock className="w-4 h-4 mr-2" /> Close month
              </Button>
            )}
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="divide-y divide-border">
                {bucket.length === 0 && (
                  <div className="p-12 text-center text-muted-foreground">
                    {isClosed ? "Month is closed — bucket hidden." : "Nothing triaged for this month yet."}
                  </div>
                )}
                {bucket.map((b) => (
                  <div key={b.id} className="p-4 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      {statusBadge(b.status)}
                      <div className="min-w-0">
                        <div className="font-medium text-sm truncate">{b.label || "—"}</div>
                        <div className="text-xs text-muted-foreground">{formatDate(b.date)}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className={`font-medium tabular-nums ${b.amount < 0 ? "text-destructive" : "text-primary"}`}>
                        {formatCurrency(b.amount)}
                      </span>
                      <Button variant="ghost" size="sm" onClick={() => onUndo(b.id)}>
                        Undo
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Triage dialog */}
      <Dialog open={!!selectedRow} onOpenChange={(o) => !o && closeDialog()}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {selectedRow?.kind === "bank" ? "Bank transaction" : "Planned event"}
            </DialogTitle>
          </DialogHeader>
          {selectedRow && (
            <div className="space-y-4">
              <div className="rounded-md border p-3">
                <div className="font-medium">
                  {selectedRow.kind === "bank" ? selectedRow.txn.description : selectedRow.label}
                </div>
                <div className="text-sm text-muted-foreground mt-1">
                  {formatDate(selectedRow.date)} · {formatCurrency(selectedRow.amount)}
                </div>
              </div>

              <div>
                <div className="text-sm font-medium mb-2">Suggested matches</div>
                <div className="space-y-2">
                  {findCandidates(selectedRow, register.rows, 7).slice(0, 5).map((c, i) => (
                    <button
                      key={i}
                      onClick={() => onMatch(selectedRow, c)}
                      className="w-full text-left p-3 rounded-md border hover:bg-muted transition-colors flex items-center justify-between"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">
                          {c.kind === "bank" ? c.txn.description : c.label}
                        </div>
                        <div className="text-xs text-muted-foreground">{formatDate(c.date)}</div>
                      </div>
                      <span className={`text-sm tabular-nums ${c.amount < 0 ? "text-destructive" : "text-primary"}`}>
                        {formatCurrency(c.amount)}
                      </span>
                    </button>
                  ))}
                  {findCandidates(selectedRow, register.rows, 7).length === 0 && (
                    <div className="text-sm text-muted-foreground p-2">
                      <AlertCircle className="w-4 h-4 inline mr-1" /> No close candidates within ±7 days.
                    </div>
                  )}
                </div>
              </div>

              <div className="flex gap-2 pt-2 border-t">
                {selectedRow.kind === "plan" ? (
                  <Button variant="outline" onClick={() => onMarkMissed(selectedRow)}>
                    <X className="w-4 h-4 mr-2" /> Mark missed
                  </Button>
                ) : (
                  <Button variant="outline" onClick={() => onMarkUnplanned(selectedRow)}>
                    <Check className="w-4 h-4 mr-2" /> Mark unplanned
                  </Button>
                )}
                <Button variant="ghost" onClick={closeDialog} className="ml-auto">
                  Close
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Settings dialog */}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Forecast Settings</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="days">Horizon (days)</Label>
              <Input
                id="days"
                type="number"
                value={draftDays}
                onChange={(e) => setDraftDays(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="bal">Starting balance</Label>
              <Input
                id="bal"
                type="number"
                step="0.01"
                value={draftBalance}
                onChange={(e) => setDraftBalance(e.target.value)}
              />
            </div>
            <div className="flex justify-end pt-2">
              <Button onClick={saveSettings} disabled={updateSettings.isPending}>
                Save
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
