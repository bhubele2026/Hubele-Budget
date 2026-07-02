import { useEffect, useState } from "react";
import { Target, Plus, X, PartyPopper } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Confetti } from "@/components/confetti";
import { cn, formatCurrency } from "@/lib/utils";

const KEY = "h2:savings-goal:v1";
type Goal = { name: string; target: number; saved: number };

/**
 * A shared savings goal the household can chase — name + target, log
 * contributions, watch the bar fill, celebrate at 100%. Persisted in
 * localStorage (no schema change). Fun + gamified.
 */
export function SavingsGoal() {
  const [goal, setGoal] = useState<Goal | null>(null);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [add, setAdd] = useState("");
  const [justWon, setJustWon] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) setGoal(JSON.parse(raw) as Goal);
    } catch {
      /* ignore */
    }
  }, []);

  const persist = (g: Goal | null) => {
    setGoal(g);
    try {
      if (g) localStorage.setItem(KEY, JSON.stringify(g));
      else localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  };

  if (!goal) {
    const t = Number(target);
    return (
      <Card>
        <CardContent className="p-5">
          <div className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium">
            Set a savings goal
          </div>
          <div className="mt-2 flex flex-col sm:flex-row gap-2">
            <Input
              placeholder="e.g. Vacation"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Input
              type="number"
              inputMode="decimal"
              placeholder="Target $"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className="sm:w-36"
            />
            <Button
              onClick={() => {
                if (name.trim() && t > 0) {
                  persist({
                    name: name.trim(),
                    target: Math.round(t * 100) / 100,
                    saved: 0,
                  });
                  setName("");
                  setTarget("");
                }
              }}
              disabled={!name.trim() || !(t > 0)}
            >
              <Target className="w-4 h-4 mr-1.5" />
              Set goal
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Give yourselves something to chase. 🎯
          </p>
        </CardContent>
      </Card>
    );
  }

  const pct = goal.target > 0 ? Math.min(1, goal.saved / goal.target) : 0;
  const done = goal.saved >= goal.target;
  const addAmt = Number(add);

  return (
    <>
      <Confetti fire={justWon} />
      <Card>
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] uppercase tracking-widest text-muted-foreground font-medium truncate">
            Savings goal · {goal.name}
          </span>
          <button
            type="button"
            onClick={() => persist(null)}
            className="text-muted-foreground hover:text-foreground shrink-0"
            title="Clear goal"
            aria-label="Clear goal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex items-baseline justify-between mb-1.5">
          <span className="text-xl font-bold tabular-nums">
            {formatCurrency(goal.saved)}
          </span>
          <span className="text-sm text-muted-foreground tabular-nums">
            of {formatCurrency(goal.target)} · {Math.round(pct * 100)}%
          </span>
        </div>
        <div className="h-3 w-full rounded-full bg-muted overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-700 ease-out",
              done ? "bg-positive" : "bg-primary",
            )}
            style={{ width: `${Math.round(pct * 100)}%` }}
          />
        </div>
        {done ? (
          <p className="mt-2 text-sm font-medium text-positive flex items-center gap-1.5">
            <PartyPopper className="w-4 h-4" /> Goal reached — excellent work.
          </p>
        ) : (
          <div className="mt-3 flex gap-2">
            <Input
              type="number"
              inputMode="decimal"
              placeholder="Add $"
              value={add}
              onChange={(e) => setAdd(e.target.value)}
              className="w-28"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                if (addAmt > 0) {
                  const next = Math.round((goal.saved + addAmt) * 100) / 100;
                  // Crossed the finish line on this contribution → celebrate.
                  if (goal.saved < goal.target && next >= goal.target) {
                    setJustWon(true);
                    window.setTimeout(() => setJustWon(false), 4200);
                  }
                  persist({ ...goal, saved: next });
                  setAdd("");
                }
              }}
              disabled={!(addAmt > 0)}
            >
              <Plus className="w-4 h-4 mr-1" />
              Add
            </Button>
            <span className="self-center text-xs text-muted-foreground">
              {formatCurrency(Math.max(0, goal.target - goal.saved))} to go
            </span>
          </div>
        )}
      </CardContent>
      </Card>
    </>
  );
}
