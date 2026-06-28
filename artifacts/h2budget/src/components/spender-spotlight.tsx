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

/** Roast templates — SAVAGE MODE (by explicit owner request: profane, furious,
 *  no-mercy). The target is always the SPENDING — the receipts, the debt, the
 *  damage — never the person's worth, looks, or anything below the belt. Keep
 *  it comedy-brutal about money. Do NOT sand this down without the owner's say. */
const ROASTS: Array<
  (name: string, amt: number, runner: Member | null, big: Splurge | null) => string
> = [
  (n, a) =>
    `🔥 ${n} torched ${fmt$(a)} this month. The fuck is wrong with you? The debit card has filed for a restraining order.`,
  (n, a) =>
    `💸 ${n} set ${fmt$(a)} on fire like rent is a myth and debt is somebody else's problem. Absolute financial arson, you reckless bastard. Put the card DOWN.`,
  (n, a) =>
    `🚨 ${fmt$(a)}?! ${n}, that's not a budget — that's a goddamn crime scene. Somebody check their pulse, this is a fucking emergency.`,
  (n, a, runner) =>
    runner
      ? `🤡 ${n} blew ${fmt$(a)}, lapping ${runner.name} (${fmt$(runner.spend)}) like overspending is a competitive sport. Congrats, you absolute menace — the avalanche is laughing in your stupid face.`
      : `🤡 ${n} blew ${fmt$(a)} like the money was personally insulting them. The avalanche is laughing in your stupid face.`,
  (n, a, _r, big) =>
    big
      ? `👀 ${n} racked up ${fmt$(a)}. Exhibit fucking A: "${big.desc}" for ${fmt$(big.amt)}. Explain yourself, you walking overdraft.`
      : `👀 ${n} dropped ${fmt$(a)} and has the audacity to act surprised the account is bleeding out. Sit DOWN.`,
  (n, a) =>
    `💀 ${n} out-spent the entire household plan by ${fmt$(a)}. Cut up the card, salt the earth, and never let this person near a checkout again. Disgraceful.`,
  (n, a) =>
    `🗑️ ${n} treated ${fmt$(a)} like Monopoly money. Newsflash, genius: it's REAL, it's GONE, and the debt is still sitting right there laughing at both of us.`,
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
            🔥 Spender Spotlight · No Mercy
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
            <p className="mt-1.5 text-xs text-white/80">
              Runner-up: {runner.name} at {fmt$(runner.spend)} — congrats on being
              the household's SECOND biggest disaster. 🥈
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
