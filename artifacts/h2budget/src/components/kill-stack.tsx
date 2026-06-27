import { Link } from "wouter";
import { ChevronRight, Loader2 } from "lucide-react";
import {
  useGetAmexWeeklyPayoff,
  type GetAmexWeeklyPayoffParams,
  type AmexWeeklyPayoffCard,
} from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { RingStat, MoneyText } from "@/components/viz";
import { StatusPill, WhyExpander } from "@/components/stat";
import { cn } from "@/lib/utils";

const BRAND_LABEL: Record<string, string> = {
  blue: "Blue Cash",
  silver: "Platinum",
  gold: "Gold",
};
function brandColor(brand: string): string {
  // brand ∈ blue|silver|gold ↦ the --card-* identity tokens.
  return `hsl(var(--card-${brand}))`;
}

function fmtWeekRange(start: string, end: string): string {
  const f = (iso: string) => {
    const [, m, d] = iso.split("-");
    return `${Number(m)}/${Number(d)}`;
  };
  return `${f(start)} – ${f(end)}`;
}

function KillRow({ card }: { card: AmexWeeklyPayoffCard }) {
  const color = brandColor(card.brand);
  const hasCharges = card.weekCharges > 0;
  const pctCleared = Math.round((card.pctOfStatementThisWeek || 0) * 100);
  return (
    <div
      className="rounded-lg border border-card-border bg-card"
      style={{ borderLeftColor: color, borderLeftWidth: 3 }}
      data-testid={`killstack-row-${card.brand}`}
    >
      <Link
        href={`/amex?accountId=${encodeURIComponent(card.accountId)}`}
        className="group flex items-center gap-4 px-4 py-3 transition-colors hover:bg-accent/40 rounded-t-lg"
      >
        <RingStat
          value={card.pctOfStatementThisWeek}
          size={52}
          stroke={5}
          color={color}
          centerSub="cleared"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
            <span className="text-sm font-semibold">
              {BRAND_LABEL[card.brand] ?? card.name}
            </span>
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {card.chargeCount > 0
              ? `${card.chargeCount} charge${card.chargeCount === 1 ? "" : "s"}${
                  card.topMerchant ? ` · top: ${card.topMerchant.name}` : ""
                }`
              : "Nothing charged this week"}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="mb-1 flex justify-end">
            <StatusPill status={hasCharges ? "warning" : "good"}>
              {hasCharges ? "To pay" : "Clear"}
            </StatusPill>
          </div>
          <MoneyText amount={card.weekCharges} className="text-xl font-bold" />
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
            this week
          </div>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
      </Link>
      <div className="px-4 pb-3">
        <WhyExpander label="Why">
          <p className="leading-snug">
            {hasCharges ? (
              <>
                You put{" "}
                <span className="font-medium text-foreground">
                  <MoneyText amount={card.weekCharges} />
                </span>{" "}
                on this card across {card.chargeCount} charge
                {card.chargeCount === 1 ? "" : "s"} this week.{" "}
                {card.topMerchant
                  ? `Biggest was ${card.topMerchant.name} (`
                  : ""}
                {card.topMerchant ? <MoneyText amount={card.topMerchant.amount} /> : null}
                {card.topMerchant ? "). " : ""}
                That&apos;s {pctCleared}% of the {<MoneyText amount={card.statementBalance} />}{" "}
                statement.
              </>
            ) : (
              "Nothing charged on this card this week. Tidy."
            )}
          </p>
        </WhyExpander>
      </div>
    </div>
  );
}

/**
 * The signature element — a per-card weekly payoff stack that reads like a
 * bank statement crossed with a leaderboard. Blue / Silver / Gold cards
 * stacked, each showing this-week's charges to pay, a per-card ring for "% of
 * statement cleared", a combined total, and a one-line sassy directive.
 *
 * Consumes GET /amex/weekly-payoff. Reused on Home and as the spine of the
 * Allowance page (pass `weekStart`).
 */
export function KillStack({
  weekStart,
  emphasize = true,
  className,
}: {
  /** Sunday of the target week; omit for the last completed week. */
  weekStart?: string;
  /** Apply the violet focus-glow ring (Home hero treatment). */
  emphasize?: boolean;
  className?: string;
}) {
  const params: GetAmexWeeklyPayoffParams | undefined = weekStart
    ? { weekStart }
    : undefined;
  const { data, isLoading } = useGetAmexWeeklyPayoff(params);

  const cards = data?.cards ?? [];
  const hasCards = cards.length > 0;

  return (
    <Card
      className={cn(emphasize && "focus-glow", className)}
      data-testid="kill-stack"
    >
      <CardContent className="p-5 space-y-4">
        {/* Header: eyebrow + week + combined total */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
              Kill Stack · pay this for last week
            </div>
            {data && (
              <div className="text-xs text-muted-foreground mt-0.5">
                {fmtWeekRange(data.weekStart, data.weekEnd)}
              </div>
            )}
          </div>
          <div className="text-right">
            <MoneyText
              amount={data?.combinedWeekCharges ?? 0}
              className="text-2xl font-bold leading-none"
            />
            <div className="text-[10px] uppercase tracking-widest text-muted-foreground mt-1">
              combined
            </div>
          </div>
        </div>

        {/* Sassy directive */}
        {data?.directive && (
          <p className="text-sm font-medium leading-snug text-foreground">
            {data.directive}
          </p>
        )}

        {/* The stack */}
        {isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Tallying the damage…
          </div>
        ) : hasCards ? (
          <div className="space-y-2">
            {cards.map((c) => (
              <KillRow key={c.accountId} card={c} />
            ))}
          </div>
        ) : (
          <div className="rounded-lg border border-dashed border-card-border px-4 py-6 text-sm text-muted-foreground">
            No Amex cards linked yet — link American Express to see exactly what
            to pay each week.{" "}
            <Link href="/amex" className="text-primary hover:underline">
              Link Amex
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
