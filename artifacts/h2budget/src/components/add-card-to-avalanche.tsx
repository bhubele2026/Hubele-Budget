import { useState } from "react";
import {
  useBulkCreateDebtsFromPlaidAccounts,
  useUpdateDebt,
} from "@workspace/api-client-react";
import { MoneyText } from "@/components/viz";

/**
 * "Add to Avalanche": turns an Amex card into a real, Plaid-linked debt so the
 * payoff engine ranks and pays it. Balance auto-syncs from Plaid; the user
 * supplies APR + minimum payment (the model never invents financial numbers).
 * APR is entered as a percent and stored as a decimal, matching the debt editor
 * (apr = pct / 100, 4dp). Reuses the existing bulk-from-Plaid + update endpoints.
 *
 * Shared by the Avalanche card config and the Amex per-card band. Once a card is
 * linked (debtId set) it drops off the Amex band automatically (amexAnchor filters
 * debt-linked cards) — this is how the Sky Card moves into Avalanche.
 */
export function AddToAvalanche({
  card,
  onCreated,
}: {
  card: {
    plaidAccountId?: string | null;
    debtId?: string | null;
    displayName?: string | null;
    statementBalance: number;
  };
  onCreated: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [aprPct, setAprPct] = useState("");
  const [minPayment, setMinPayment] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const bulk = useBulkCreateDebtsFromPlaidAccounts();
  const update = useUpdateDebt();

  if (card.debtId) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-positive">
        ✓ In avalanche
      </span>
    );
  }
  if (!card.plaidAccountId) {
    return (
      <span className="text-[10px] text-muted-foreground">
        Link this card via Plaid to add it to the avalanche
      </span>
    );
  }
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="amex-add-to-avalanche"
        className="rounded-md border border-primary/40 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-primary transition-colors hover:bg-primary/10"
      >
        + Add to Avalanche
      </button>
    );
  }

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await bulk.mutateAsync({
        data: {
          accounts: [
            {
              plaidAccountId: card.plaidAccountId as string,
              name: card.displayName ?? null,
            },
          ],
        },
      });
      const r = res.results?.[0];
      if (!r?.debtId) {
        setErr(r?.error || `Could not add card (${r?.status ?? "unknown"})`);
        setBusy(false);
        return;
      }
      // Same percent→decimal conversion as the debt editor.
      const patch: { apr?: string; minPayment?: string } = {};
      if (aprPct.trim() !== "") patch.apr = (Number(aprPct) / 100).toFixed(4);
      if (minPayment.trim() !== "")
        patch.minPayment = Number(minPayment).toFixed(2);
      if (patch.apr || patch.minPayment) {
        await update.mutateAsync({ id: r.debtId, data: patch });
      }
      await onCreated();
      setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-card-border p-2">
      <div className="text-[10px] text-muted-foreground">
        Balance <MoneyText amount={card.statementBalance} /> · auto-syncs from Plaid
      </div>
      <div className="flex gap-1.5">
        <label className="flex-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          APR %
          <input
            value={aprPct}
            onChange={(e) => setAprPct(e.target.value)}
            inputMode="decimal"
            placeholder="24.99"
            aria-label="APR percent"
            className="mt-0.5 w-full rounded border border-card-border bg-background px-1.5 py-1 text-xs text-foreground"
          />
        </label>
        <label className="flex-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          Min payment $
          <input
            value={minPayment}
            onChange={(e) => setMinPayment(e.target.value)}
            inputMode="decimal"
            placeholder="40.00"
            aria-label="Minimum payment"
            className="mt-0.5 w-full rounded border border-card-border bg-background px-1.5 py-1 text-xs text-foreground"
          />
        </label>
      </div>
      {err && <div className="text-[10px] text-destructive">{err}</div>}
      <div className="flex gap-1.5">
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit()}
          data-testid="amex-add-to-avalanche-confirm"
          className="rounded-md bg-primary px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-primary-foreground disabled:opacity-50"
        >
          {busy ? "Adding…" : "Add"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setOpen(false)}
          className="rounded-md border border-card-border px-2 py-1 text-[10px] text-muted-foreground"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
