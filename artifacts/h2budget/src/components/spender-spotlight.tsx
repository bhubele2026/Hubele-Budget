import { useMemo } from "react";
import { Flame } from "lucide-react";

const fmt$ = (n: number) =>
  `$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;

/**
 * Spender Spotlight — the app's snarky coach picks whoever torched the most
 * cash this month (by member attribution) and roasts them, playfully. The
 * numbers are computed in our code (memberSpend / biggestSplurge); the voice is
 * just language wrapped around them. Affectionate-savage: it ribs the SPENDING,
 * names the leader, and roasts whoever's actually on top — fair game either way.
 */

type Member = { name: string; spend: number };
type Splurge = { desc: string; amt: number; member: string | null; date: string };

/** Roast templates. Each gets the leader's name + amount (+ optional runner-up
 *  and biggest single splurge). Cheeky, never cruel — it's about the receipts. */
const ROASTS: Array<
  (name: string, amt: number, runner: Member | null, big: Splurge | null) => string
> = [
  (n, a) =>
    `👑 ${n} is this month's undisputed Champion of Checkout — ${fmt$(a)} torched. The debit card is requesting hazard pay.`,
  (n, a) =>
    `🔥 ${n} dropped ${fmt$(a)} this month. Somewhere, a savings account just flinched and a budget started crying.`,
  (n, a) =>
    `💸 ${n} treated the budget like a polite suggestion — ${fmt$(a)} gone. Bold. Reckless. Honestly kind of iconic.`,
  (n, a, runner) =>
    runner
      ? `🛍️ Spender of the Month: ${n} at ${fmt$(a)}, lapping ${runner.name} (${fmt$(runner.spend)}) like it's a sport. The avalanche says… thanks for nothing.`
      : `🛍️ Spender of the Month: ${n}, ${fmt$(a)}. The avalanche says thanks for nothing.`,
  (n, a, _r, big) =>
    big
      ? `💅 ${n} racked up ${fmt$(a)}. Exhibit A: "${big.desc}" for ${fmt$(big.amt)}. Babe… what WAS that? 👀`
      : `💅 ${n} said "treat yourself" to the tune of ${fmt$(a)}. We're framing the receipt.`,
  (n, a) =>
    `🚨 Code red: ${n} just out-spent the entire household plan by ${fmt$(a)}. Confiscate the wallet. This is not a drill.`,
];

export function SpenderSpotlight({
  memberSpend,
  biggest,
  className,
}: {
  memberSpend: Member[];
  biggest: Splurge | null;
  className?: string;
}) {
  const data = useMemo(() => {
    const named = memberSpend.filter(
      (m) => m.name && m.name.toLowerCase() !== "unassigned" && m.spend > 0,
    );
    if (named.length === 0) return null;
    const leader = named[0];
    const runner = named[1] ?? null;
    const idx = (Math.floor(leader.spend) + leader.name.length) % ROASTS.length;
    return { leader, runner, line: ROASTS[idx](leader.name, leader.spend, runner, biggest) };
  }, [memberSpend, biggest]);

  if (!data) return null;
  const { leader, runner, line } = data;

  return (
    <div
      className={
        "roast-card relative overflow-hidden rounded-[1.25rem] p-5 text-white shadow-[0_14px_34px_-12px_rgba(180,30,60,0.55)] " +
        (className ?? "")
      }
    >
      <div className="relative z-10 flex items-start gap-4">
        <span className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] bg-white/20 backdrop-blur-sm">
          <Flame className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/85">
            🔥 Spender Spotlight
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0">
            <span className="text-3xl md:text-4xl font-bold leading-none drop-shadow-sm">
              {leader.name}
            </span>
            <span className="text-2xl md:text-3xl font-bold tabular-nums leading-none text-white/95">
              {fmt$(leader.spend)}
            </span>
          </div>
          <p className="mt-2 text-sm md:text-[0.95rem] font-medium leading-snug text-white/95">
            {line}
          </p>
          {runner && (
            <p className="mt-1.5 text-xs text-white/75">
              Runner-up: {runner.name} ({fmt$(runner.spend)}) — try harder. 🥈
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
