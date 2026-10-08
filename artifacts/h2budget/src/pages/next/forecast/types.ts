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
  openSnapshot: () => void;
  openSettings: () => void;
  cashProjectionLoading: boolean;
  bankBalance: string | number;
  bankAccountName: string;
  bankAccountMask: string | null;
  debtLinks: ReadonlyMap<string, string>;
  inboxCount: number;
  fromDate: string;
  lookbackOpen: boolean;
  highlightedPlanKey: string | null;
};
