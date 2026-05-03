import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetForecast,
  useUpsertForecastResolution,
  useDeleteForecastResolution,
  useCloseForecastMonth,
  useReopenForecastMonth,
  useUpdateForecastSettings,
  useUpdateTransaction,
  useListCategories,
  getGetForecastQueryKey,
  getListTransactionsQueryKey,
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
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  DragOverlay,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import confetti from "canvas-confetti";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  buildLineRegister,
  buildBucket,
  monthKey,
  type LineRow,
  type PlanLine,
  type BankLine,
  type Resolution,
  type Transaction as MatchTxn,
} from "@/lib/forecastMatch";
import type { CashEvent } from "@/lib/forecast";
import {
  Lock,
  Unlock,
  Settings as SettingsIcon,
  X,
  GripVertical,
  PartyPopper,
  Inbox as InboxIcon,
} from "lucide-react";

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

const RECONCILED_STORAGE_KEY = "h2budget:forecastReconciled";

function readReconciledMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(RECONCILED_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeReconciledMap(map: Record<string, boolean>) {
  try {
    localStorage.setItem(RECONCILED_STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* no-op */
  }
}

function fireConfetti() {
  const defaults = { startVelocity: 32, spread: 360, ticks: 70, zIndex: 9999 };
  confetti({ ...defaults, particleCount: 90, origin: { x: 0.2, y: 0.3 } });
  confetti({ ...defaults, particleCount: 90, origin: { x: 0.8, y: 0.3 } });
  setTimeout(
    () =>
      confetti({
        ...defaults,
        particleCount: 120,
        origin: { x: 0.5, y: 0.4 },
      }),
    150,
  );
}

type InboxCard = {
  id: string;
  bank: BankLine;
};

function InboxCardView({
  card,
  categoryName,
  onUnplanned,
  onMatchPick,
  planRows,
  isOverlay,
}: {
  card: InboxCard;
  categoryName?: string | null;
  onUnplanned: () => void;
  onMatchPick: (planRow: PlanLine) => void;
  planRows: PlanLine[];
  isOverlay?: boolean;
}) {
  const draggable = useDraggable({
    id: card.id,
    data: { txnId: card.bank.txn.id },
    disabled: isOverlay,
  });
  const { attributes, listeners, setNodeRef, transform, isDragging } = draggable;
  const style = transform
    ? { transform: CSS.Translate.toString(transform) }
    : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded-md border bg-card p-3 flex items-center gap-3 shadow-sm transition-opacity ${
        isDragging ? "opacity-30" : ""
      } ${isOverlay ? "shadow-lg ring-2 ring-primary/40 cursor-grabbing" : ""}`}
    >
      <button
        {...listeners}
        {...attributes}
        className="touch-none cursor-grab text-muted-foreground hover:text-foreground"
        aria-label="Drag to match"
        type="button"
      >
        <GripVertical className="w-4 h-4" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="font-medium text-sm truncate">
          {card.bank.txn.description}
        </div>
        <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
          <span>{formatDate(card.bank.date)}</span>
          {categoryName && (
            <Badge
              variant="outline"
              className="text-[10px] border-violet-200 text-violet-700 bg-violet-50"
            >
              {categoryName}
            </Badge>
          )}
          {!categoryName && (
            <Badge variant="outline" className="text-[10px] border-muted text-muted-foreground">
              Uncategorized
            </Badge>
          )}
        </div>
      </div>
      <span
        className={`text-sm font-medium tabular-nums ${
          card.bank.amount < 0 ? "text-destructive" : "text-primary"
        }`}
      >
        {formatCurrency(card.bank.amount)}
      </span>
      {!isOverlay && (
        <div className="flex items-center gap-1">
          <Select
            onValueChange={(v) => {
              const p = planRows.find(
                (r) => `${r.itemId}|${r.date}` === v,
              );
              if (p) onMatchPick(p);
            }}
          >
            <SelectTrigger className="h-8 w-[140px] text-xs">
              <SelectValue placeholder="Match to…" />
            </SelectTrigger>
            <SelectContent>
              {planRows.length === 0 && (
                <div className="px-2 py-1 text-xs text-muted-foreground">
                  No planned items
                </div>
              )}
              {planRows.map((p) => (
                <SelectItem
                  key={`${p.itemId}|${p.date}`}
                  value={`${p.itemId}|${p.date}`}
                >
                  {p.label} · {formatDate(p.date)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={onUnplanned}>
            Unplanned
          </Button>
        </div>
      )}
    </div>
  );
}

function PlanDropRow({
  row,
  onSelect,
  activeDragId,
}: {
  row: PlanLine;
  onSelect: (row: PlanLine) => void;
  activeDragId: string | null;
}) {
  const droppable = useDroppable({
    id: `plan:${row.itemId}|${row.date}`,
    data: { kind: "plan", planRow: row },
    disabled: row.status === "matched" || row.status === "missed",
  });
  const isOver = droppable.isOver && activeDragId !== null;
  return (
    <button
      ref={droppable.setNodeRef}
      onClick={() => onSelect(row)}
      className={`w-full text-left p-4 flex items-center justify-between transition-colors ${
        isOver
          ? "bg-primary/10 ring-2 ring-primary ring-inset"
          : "hover:bg-muted/50"
      }`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <Badge
          variant="outline"
          className="bg-amber-50 text-amber-900 border-amber-200"
        >
          Plan
        </Badge>
        <div className="min-w-0">
          <div className="font-medium text-sm truncate">{row.label}</div>
          <div className="text-xs text-muted-foreground">
            {formatDate(row.date)}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-4">
        {statusBadge(row.status)}
        <span
          className={`font-medium tabular-nums ${
            row.amount < 0 ? "text-destructive" : "text-primary"
          }`}
        >
          {formatCurrency(row.amount)}
        </span>
      </div>
    </button>
  );
}

export default function ForecastPage() {
  const { data, isLoading } = useGetForecast();
  const { data: categories } = useListCategories();
  const qc = useQueryClient();
  const { toast } = useToast();

  const upsertResolution = useUpsertForecastResolution();
  const deleteResolution = useDeleteForecastResolution();
  const closeMonth = useCloseForecastMonth();
  const reopenMonth = useReopenForecastMonth();
  const updateSettings = useUpdateForecastSettings();
  const updateTxn = useUpdateTransaction();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftDays, setDraftDays] = useState("90");
  const [draftBalance, setDraftBalance] = useState("0");
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [reconciledNow, setReconciledNow] = useState(false);

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

  const categoryById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of categories ?? []) m.set(c.id, c.name);
    return m;
  }, [categories]);

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

  // Build inbox: bank rows still pending (not matched, not unplanned)
  const inbox: InboxCard[] = useMemo(() => {
    if (!register) return [];
    return register.allBank
      .filter((b) => b.status === "pending_bank")
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .map((b) => ({ id: `inbox:${b.txn.id}`, bank: b }));
  }, [register]);

  // Plan rows used as drop targets (active register, plan-only)
  const planRows: PlanLine[] = useMemo(() => {
    if (!register) return [];
    return register.rows.filter((r): r is PlanLine => r.kind === "plan");
  }, [register]);

  // Window key for confetti persistence: from→to
  const windowKey = data ? `${data.fromDate}_${data.toDate}` : null;
  const inboxCount = inbox.length;
  const prevInboxCountRef = useRef<number | null>(null);

  // Hydrate "reconciled" state from local storage when window changes
  useEffect(() => {
    if (!windowKey) return;
    const map = readReconciledMap();
    setReconciledNow(!!map[windowKey] && inboxCount === 0);
    prevInboxCountRef.current = inboxCount;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowKey]);

  // Watch transitions
  useEffect(() => {
    if (!windowKey) return;
    const prev = prevInboxCountRef.current;
    if (prev === null) {
      prevInboxCountRef.current = inboxCount;
      return;
    }
    const map = readReconciledMap();
    if (prev > 0 && inboxCount === 0) {
      // transitioned to zero — celebrate (only if not already celebrated)
      if (!map[windowKey]) {
        fireConfetti();
        map[windowKey] = true;
        writeReconciledMap(map);
      }
      setReconciledNow(true);
    } else if (inboxCount > 0 && map[windowKey]) {
      // re-opened: clear the celebrated flag for this window
      delete map[windowKey];
      writeReconciledMap(map);
      setReconciledNow(false);
    } else if (inboxCount > 0) {
      setReconciledNow(false);
    }
    prevInboxCountRef.current = inboxCount;
  }, [inboxCount, windowKey]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getGetForecastQueryKey() });
    qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 150, tolerance: 5 },
    }),
  );

  const matchInboxToPlan = (txnId: string, planRow: PlanLine) => {
    upsertResolution.mutate(
      {
        data: {
          status: "matched",
          recurringItemId: planRow.itemId,
          occurrenceDate: planRow.date,
          matchedTxnId: txnId,
        },
      },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: `Matched to ${planRow.label}` });
        },
      },
    );
  };

  const onDragStart = (e: DragStartEvent) => {
    setActiveDragId(String(e.active.id));
  };
  const onDragEnd = (e: DragEndEvent) => {
    setActiveDragId(null);
    const overData = e.over?.data?.current as
      | { kind?: string; planRow?: PlanLine }
      | undefined;
    const activeData = e.active.data.current as
      | { txnId?: string }
      | undefined;
    if (overData?.kind === "plan" && overData.planRow && activeData?.txnId) {
      matchInboxToPlan(activeData.txnId, overData.planRow);
    }
  };

  const onMarkUnplannedTxn = (txnId: string) => {
    upsertResolution.mutate(
      { data: { status: "ignored_unforecasted", matchedTxnId: txnId } },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Marked unplanned" });
        },
      },
    );
  };

  const onSelectPlan = (row: PlanLine) => {
    if (row.status === "matched" || row.status === "missed") return;
    if (
      confirm(
        `Mark "${row.label}" as missed for ${formatDate(row.date)}? You can drag an Amex card here to match instead.`,
      )
    ) {
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
          },
        },
      );
    }
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

  const onRemoveFromForecast = (txnId: string) => {
    updateTxn.mutate(
      { id: txnId, data: { forecastFlag: false } },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: "Removed from Forecast" });
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
  const activeCard = activeDragId
    ? inbox.find((c) => c.id === activeDragId) ?? null
    : null;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-start gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-serif font-bold text-foreground tracking-tight">
            Cash Forecast
          </h1>
          <p className="text-muted-foreground mt-1">
            Send Amex charges from Transactions, then drop them onto planned items here.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {inboxCount > 0 ? (
            <Badge
              variant="outline"
              className="bg-emerald-50 text-emerald-900 border-emerald-200"
              data-testid="inbox-counter"
            >
              <InboxIcon className="w-3.5 h-3.5 mr-1" />
              Inbox: {inboxCount} pending
            </Badge>
          ) : reconciledNow ? (
            <Badge
              className="bg-primary/15 text-primary border-primary/30"
              data-testid="reconciled-badge"
            >
              <PartyPopper className="w-3.5 h-3.5 mr-1" /> Reconciled!
            </Badge>
          ) : (
            <Badge variant="outline" className="bg-muted text-muted-foreground">
              <InboxIcon className="w-3.5 h-3.5 mr-1" /> Inbox: 0 pending
            </Badge>
          )}
          <Button variant="outline" onClick={openSettings}>
            <SettingsIcon className="w-4 h-4 mr-2" /> Settings
          </Button>
        </div>
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
            <CardTitle className="text-sm text-muted-foreground">Planned open items</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{planRows.length}</div>
            <div className="text-xs text-muted-foreground mt-1">awaiting reconciliation</div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="register" className="w-full">
        <TabsList>
          <TabsTrigger value="register">Active Register</TabsTrigger>
          <TabsTrigger value="bucket">Review Bucket</TabsTrigger>
        </TabsList>

        <TabsContent value="register" className="mt-4 space-y-4">
          <DndContext
            sensors={sensors}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragCancel={() => setActiveDragId(null)}
          >
            <Card>
              <CardHeader className="pb-3 flex-row items-center justify-between">
                <CardTitle className="flex items-center gap-2">
                  <InboxIcon className="w-4 h-4" />
                  Amex activity to reconcile
                </CardTitle>
                <span className="text-xs text-muted-foreground">
                  Drag a card onto a planned item below, or pick "Match to…"
                </span>
              </CardHeader>
              <CardContent className="space-y-2">
                {inbox.length === 0 ? (
                  <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
                    {reconciledNow ? (
                      <span className="inline-flex items-center gap-2 text-primary">
                        <PartyPopper className="w-4 h-4" /> All Amex charges reconciled.
                      </span>
                    ) : (
                      <>Send an Amex charge from the Transactions page to start reconciling.</>
                    )}
                  </div>
                ) : (
                  inbox.map((card) => (
                    <div key={card.id} className="flex items-stretch gap-2">
                      <div className="flex-1">
                        <InboxCardView
                          card={card}
                          categoryName={
                            card.bank.txn.categoryId
                              ? categoryById.get(card.bank.txn.categoryId) ?? null
                              : null
                          }
                          onUnplanned={() => onMarkUnplannedTxn(card.bank.txn.id)}
                          onMatchPick={(p) =>
                            matchInboxToPlan(card.bank.txn.id, p)
                          }
                          planRows={planRows.filter(
                            (r) => r.status === "pending_plan" || r.status === "future",
                          )}
                        />
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => onRemoveFromForecast(card.bank.txn.id)}
                        title="Remove from Forecast"
                      >
                        <X className="w-4 h-4 text-muted-foreground" />
                      </Button>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle>Planned forecast items</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="divide-y divide-border">
                  {planRows.length === 0 && (
                    <div className="p-12 text-center text-muted-foreground">
                      Nothing planned in this window.
                    </div>
                  )}
                  {planRows.map((row, i) => (
                    <PlanDropRow
                      key={`${row.itemId}-${row.date}-${i}`}
                      row={row}
                      onSelect={onSelectPlan}
                      activeDragId={activeDragId}
                    />
                  ))}
                </div>
              </CardContent>
            </Card>

            <DragOverlay>
              {activeCard && (
                <InboxCardView
                  card={activeCard}
                  categoryName={
                    activeCard.bank.txn.categoryId
                      ? categoryById.get(activeCard.bank.txn.categoryId) ?? null
                      : null
                  }
                  onUnplanned={() => undefined}
                  onMatchPick={() => undefined}
                  planRows={[]}
                  isOverlay
                />
              )}
            </DragOverlay>
          </DndContext>
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
