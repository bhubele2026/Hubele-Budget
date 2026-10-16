import type { ReactNode } from "react";
import type { CashSignal } from "@workspace/api-client-react";
import type { DailyPoint, BigBillMarker, DayEvent } from "../../forecast/ProjectedBalanceChart";
import type { PlanLine } from "@/lib/forecastMatch";
import type { DraggingPlanRow } from "@/lib/forecastPastDue";

/** Everything `ForecastPage` hands to the `/next/forecast` layout: its own
 *  ready-made sections (so the register, drag-and-drop, month close and
 *  dialogs are the SAME elements the old page renders) and the SAME derived
 *  figures (so the chart, summary and register can never disagree). */
export type ForecastNextCtx = {
  mode: "review" | "overall";
  horizonDays: number;
  horizonControls: ReactNode;
  draggingCard: ReactNode;
  bankGrid: ReactNode;
  registerBlock: ReactNode;
  monthBlock: ReactNode;
  proj: CashSignal | undefined;
  projReady: boolean;
  dailySeries: DailyPoint[];
  cashBufferNum: number;
  lowestPoint: { x: string; y: number; rawDate: string } | null;
  bigBillMarkers: BigBillMarker[];
  eventsByDate: Map<string, DayEvent[]>;
  partialPlanKeys: ReadonlySet<string>;
  jumpToPlan: (itemId: string, date: string) => void;
  onMarkMissed: (row: PlanLine) => void;
  onSkipDraggingPlan: (row: DraggingPlanRow) => void;
  openSettings: () => void;
  cashProjectionLoading: boolean;
  /** ⭐ (T1) Checking today (`cashSignal.bankToday`); null with no bank reading — a dash, never $0. */
  bankBalance: string | null;
  /** (T1) The bank reading it rolls forward from (`cashSignal.snapshotAt`). */
  bankReadAt: string | null;
  /** (C1) The reading `bankBalance` rolls forward from, and the rows counted since — from the same bundle. */
  bankReading?: { balance: string; at: string; source: string } | null;
  bankSince?: { net?: string; count: number } | null;
  /** (T1) "Earlier reading (Oct 14) — updating…" while the bundle is older than the newest reading seen. */
  bankOlder?: string | null;
  /** (T1) A checking account is linked (the empty chart offers Sync, else "Link a bank"). */
  hasCheckingLink?: boolean;
  bankAccountName: string;
  bankAccountMask: string | null;
  debtLinks: ReadonlyMap<string, string>;
  /** (T3) A counted checking row's own description (the forecast bundle's rows), for the day panel. */
  bankLabel?: (txnId: string) => string | null;
  /** (T3) How many rows each Month & bank list holds (the "How this adds up" links); 0 hides a line. */
  listCounts?: { unpaid: number; incomeNotArrived: number; olderUnpaid: number };
  inboxCount: number;
  fromDate: string;
  lookbackOpen: boolean;
  highlightedPlanKey: string | null;
  /** (C13) The inbox was just reconciled to the bank — the hero's badge. */
  reconciledNow: boolean;
  /** (C13) The page's own "balance on a chosen date" card (FC-23). */
  dateBalance: ReactNode;
};
