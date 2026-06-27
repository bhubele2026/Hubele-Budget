import { Card, CardContent } from "@/components/ui/card";
import { StatTile, StatTileRow } from "@/components/stat-tile";
import {
  RingMeter,
  StatusPill,
  TrendSparkline,
  FillMeter,
  WhyExpander,
  SectionHeader,
  Callout,
} from "@/components/stat";
import { Sparkline, MiniBars, StackBar, HeatStrip, DeltaPill, MoneyText } from "@/components/viz";
import { Wallet, CreditCard, TrendingUp } from "lucide-react";

/**
 * Dev-only primitive gallery (/dev/components). A single place to eyeball every
 * shared design-system primitive in isolation with usage notes. Not linked in
 * the nav; route is gated to import.meta.env.DEV in App.tsx.
 */
function Block({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="p-5 space-y-3">
        <SectionHeader eyebrow="Primitive" title={title} sub={note} />
        <div className="flex flex-wrap items-center gap-4">{children}</div>
      </CardContent>
    </Card>
  );
}

const SAMPLE_TREND = [-40, -15, 20, -30, 60, -10, -25, 35].map((v, i) => ({
  value: v,
  label: `wk ${i + 1}`,
}));

export default function DevComponentsPage() {
  return (
    <div className="space-y-6">
      <SectionHeader
        eyebrow="Internal"
        title="Design system — primitives"
        sub="Every shared primitive in isolation. Dev-only."
      />

      <Block title="StatTileRow" note="<StatTile active> for the hero, the rest calm.">
        <div className="w-full">
          <StatTileRow>
            <StatTile active label="Total debt" value={<MoneyText amount={-14835} abs />} sub="debt-free ~Apr 2027" icon={<Wallet className="h-4 w-4" />} />
            <StatTile label="Cash" value={<MoneyText amount={4272} />} sub="Chase ··1234" icon={<CreditCard className="h-4 w-4" />} />
            <StatTile label="Net month" value={<MoneyText amount={800} signed colored />} icon={<TrendingUp className="h-4 w-4" />} />
            <StatTile label="Paid to debt" value={<MoneyText amount={420} />} sub="this month" />
          </StatTileRow>
        </div>
      </Block>

      <Block title="RingMeter" note="ratio 0..1 + status color; X/Y center.">
        <RingMeter ratio={0.57} status="good" centerTop="57%" centerBottom="cleared" />
        <RingMeter ratio={0.9} status="warning" centerTop="90%" centerBottom="used" />
        <RingMeter ratio={1.2} status="danger" centerTop="120%" centerBottom="used" />
      </Block>

      <Block title="StatusPill" note="UNDER / ON TRACK / OVER, keyed by Status.">
        <StatusPill status="good">Under</StatusPill>
        <StatusPill status="warning">On track</StatusPill>
        <StatusPill status="danger">Over</StatusPill>
        <StatusPill status="neutral">Projected</StatusPill>
      </Block>

      <Block title="TrendSparkline" note="8-wk over/under; green under, red over.">
        <TrendSparkline data={SAMPLE_TREND} className="w-48" />
      </Block>

      <Block title="FillMeter" note="floor → ceiling fill with end labels.">
        <div className="w-72">
          <FillMeter value={312} ceiling={450} status="good" floorLabel="$0" ceilingLabel="$450" format={(n) => `$${Math.round(n)}`} />
        </div>
      </Block>

      <Block title="Callout" note="the insight banner shell.">
        <div className="w-full">
          <Callout tone="warning">Dining's at 80% on day 12 — ease off and that's days off the payoff date.</Callout>
        </div>
      </Block>

      <Block title="WhyExpander" note="slim disclosure for explanations + charts.">
        <WhyExpander>You spent $312 of $450 — $138 still in the tank.</WhyExpander>
      </Block>

      <Block title="viz: Sparkline / MiniBars / StackBar / HeatStrip / DeltaPill / MoneyText" note="lower-level chart primitives.">
        <Sparkline data={[3, 5, 4, 8, 6, 9, 7]} className="w-32" />
        <MiniBars data={[3, 5, 4, 8, 6, 9, 7]} className="w-32" />
        <div className="w-40"><StackBar segments={[{ label: "Dining", value: 120, color: "hsl(var(--chart-1))" }, { label: "Groceries", value: 80, color: "hsl(var(--chart-3))" }]} showLegend={false} /></div>
        <HeatStrip data={[10, 0, 40, 20, 5, 60, 15]} className="w-40" />
        <DeltaPill value={12.4} invert />
        <MoneyText amount={-223.05} colored />
      </Block>
    </div>
  );
}
