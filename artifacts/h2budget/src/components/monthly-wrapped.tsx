import { useMemo, useState, type ReactNode } from "react";
import {
  Store,
  TrendingDown,
  Sparkles,
  Receipt,
  ChevronRight,
  ChevronLeft,
  Check,
} from "lucide-react";
import type { DashboardSummary } from "@workspace/api-client-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Confetti } from "@/components/confetti";
import { useCountUp } from "@/hooks/useCountUp";
import { cn, formatCurrency } from "@/lib/utils";

function monthLabel(): string {
  return new Date().toLocaleDateString("en-US", { month: "long" });
}

// Soft full-slide color wash per tone — drama without leaving matte.
function toneWash(t: "good" | "bad" | "neutral"): string {
  if (t === "good")
    return "radial-gradient(120% 95% at 0% 0%, hsl(150 60% 45% / 0.18), transparent 62%)";
  if (t === "bad")
    return "radial-gradient(120% 95% at 0% 0%, hsl(0 80% 60% / 0.18), transparent 62%)";
  return "radial-gradient(120% 95% at 0% 0%, hsl(214 82% 62% / 0.18), transparent 62%)";
}

function verdict(net: number, income: number): string {
  if (income <= 0) return "Sync your accounts and let's see the real damage.";
  if (net >= income * 0.2)
    return "Genuinely crushing it. Who are you two and what did you do with the DoorDash gremlins?";
  if (net > 0) return "In the black — barely — but we'll take it. Date night's funded. 😏";
  if (net > -income * 0.1)
    return "Basically broke even. Living on the edge — let's build a little cushion next month.";
  return "Spent more than you made this month. Let's flip it — every dollar back is a dollar off the debt. 🙈";
}

// A single huge count-up number for a slide.
function HugeMoney({
  value,
  tone = "neutral",
}: {
  value: number;
  tone?: "neutral" | "good" | "bad";
}) {
  const shown = useCountUp(value, 1100);
  return (
    <div
      className={cn(
        "text-5xl md:text-6xl font-extrabold tabular-nums tracking-[-0.03em]",
        tone === "good" && "text-emerald-500",
        tone === "bad" && "text-[hsl(var(--negative))]",
        tone === "neutral" && "text-foreground",
      )}
    >
      {formatCurrency(shown)}
    </div>
  );
}

export function MonthlyWrapped({
  open,
  onOpenChange,
  dashboard,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  dashboard: DashboardSummary | null;
}) {
  const d = dashboard;
  const [step, setStep] = useState(0);
  const [copied, setCopied] = useState(false);

  const income = d ? Number(d.monthlyIncome) : 0;
  const spend = d ? Number(d.monthlySpend) : 0;
  const net = d ? Number(d.netCashflow) : 0;
  const paid = d ? Number(d.paidThisMonth) : 0;

  const biggest = useMemo(() => {
    const txns = d?.recentTransactions ?? [];
    let worst: { desc: string; amt: number } | null = null;
    for (const t of txns) {
      const a = Number(t.amount) || 0;
      if (a < 0 && (worst == null || a < worst.amt))
        worst = { desc: t.description ?? "Something", amt: a };
    }
    return worst;
  }, [d]);
  const topCat = d?.topCategories?.[0] ?? null;

  // Build the slide list from whatever data we actually have.
  type Slide = {
    kicker: string;
    body: ReactNode;
    tone: "good" | "bad" | "neutral";
  };
  const slides = useMemo<Slide[]>(() => {
    const s: Slide[] = [];
    s.push({
      tone: "neutral",
      kicker: `${monthLabel()}, Wrapped`,
      body: (
        <div className="space-y-2">
          <div className="text-3xl md:text-4xl font-extrabold tracking-tight">
            The Hubeles, by the numbers.
          </div>
          <div className="text-sm text-muted-foreground">
            Tap through your month. Brace yourselves.
          </div>
        </div>
      ),
    });
    s.push({
      tone: "good",
      kicker: "You brought in",
      body: <HugeMoney value={income} tone="good" />,
    });
    s.push({
      tone: "bad",
      kicker: "You spent",
      body: <HugeMoney value={spend} tone="bad" />,
    });
    if (biggest)
      s.push({
        tone: "bad",
        kicker: "Your biggest single hit",
        body: (
          <div className="space-y-2">
            <div className="text-2xl font-bold truncate">{biggest.desc}</div>
            <div className="text-4xl md:text-5xl font-extrabold tabular-nums text-[hsl(var(--negative))]">
              {formatCurrency(biggest.amt)}
            </div>
            <div className="text-sm text-muted-foreground">…bold move.</div>
          </div>
        ),
      });
    if (topCat)
      s.push({
        tone: "neutral",
        kicker: "Where it went most",
        body: (
          <div className="space-y-2">
            <div className="text-3xl font-extrabold">{topCat.categoryName}</div>
            <div className="text-3xl font-bold tabular-nums text-muted-foreground">
              {formatCurrency(Number(topCat.total) || 0)}
            </div>
          </div>
        ),
      });
    s.push({
      tone: net >= 0 ? "good" : "bad",
      kicker: net >= 0 ? "You came out ahead" : "You came up short",
      body: <HugeMoney value={net} tone={net >= 0 ? "good" : "bad"} />,
    });
    s.push({
      tone: net >= 0 ? "good" : "bad",
      kicker: "The verdict",
      body: (
        <p className="text-xl md:text-2xl font-semibold leading-snug">
          {verdict(net, income)}
        </p>
      ),
    });
    return s;
  }, [income, spend, net, biggest, topCat]);

  const last = slides.length - 1;
  const atEnd = step >= last;
  const cur = slides[Math.min(step, last)];
  // Confetti on the net slide (if positive) and the final verdict slide.
  const netSlideIdx = slides.findIndex((x) =>
    x.kicker.startsWith("You came"),
  );
  const fireConfetti =
    open && net > 0 && (step === netSlideIdx || atEnd);

  const close = () => {
    onOpenChange(false);
    setStep(0);
    setCopied(false);
  };

  const share = () => {
    const text =
      `Our ${monthLabel()}, Wrapped 💸\n` +
      `In: ${formatCurrency(income)} · Out: ${formatCurrency(spend)} · Net: ${formatCurrency(net)}\n` +
      (biggest ? `Biggest hit: ${biggest.desc} ${formatCurrency(biggest.amt)}\n` : "") +
      `Verdict: ${verdict(net, income)}`;
    try {
      void navigator.clipboard?.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* ignore */
    }
  };

  return (
    <>
      <Confetti fire={fireConfetti} />
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o) close();
          else onOpenChange(true);
        }}
      >
        <DialogContent className="sm:max-w-[460px] overflow-hidden">
          {!d ? (
            <p className="text-sm text-muted-foreground text-center py-10">
              Loading your month…
            </p>
          ) : (
            <div className="select-none">
              {/* progress dots */}
              <div className="flex items-center gap-1.5 mb-5">
                {slides.map((_, i) => (
                  <div
                    key={i}
                    className={cn(
                      "h-1 flex-1 rounded-full transition-colors",
                      i <= step ? "bg-primary" : "bg-muted",
                    )}
                  />
                ))}
              </div>

              {/* slide (tap to advance) */}
              <button
                type="button"
                onClick={() => setStep((s) => Math.min(last, s + 1))}
                className="w-full text-left min-h-[244px] flex flex-col justify-center rounded-xl px-5 py-6 transition-[background] duration-500"
                style={{ background: toneWash(cur.tone) }}
                data-testid={`wrapped-slide-${step}`}
              >
                <div
                  key={step}
                  className="animate-in fade-in slide-in-from-bottom-3 duration-500 space-y-3"
                >
                  <div className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-[0.2em] text-primary font-semibold">
                    <Sparkles className="w-3.5 h-3.5" /> {cur.kicker}
                  </div>
                  {cur.body}
                </div>
              </button>

              {/* footer controls */}
              <div className="mt-6 flex items-center justify-between">
                <button
                  type="button"
                  onClick={() => setStep((s) => Math.max(0, s - 1))}
                  disabled={step === 0}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground disabled:opacity-0 hover:text-foreground"
                >
                  <ChevronLeft className="w-4 h-4" /> Back
                </button>

                {atEnd ? (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={share}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted"
                    >
                      {copied ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-500" /> Copied
                        </>
                      ) : (
                        "Share"
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={close}
                      className="rounded-full bg-primary text-primary-foreground px-4 py-1.5 text-xs font-bold hover:opacity-90"
                    >
                      Done
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setStep((s) => Math.min(last, s + 1))}
                    className="inline-flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground px-4 py-1.5 text-xs font-bold hover:opacity-90"
                  >
                    Next <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
