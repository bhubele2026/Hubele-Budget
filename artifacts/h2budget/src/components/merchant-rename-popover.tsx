import { useState } from "react";
import { Pencil, Sparkles, Loader2 } from "lucide-react";
import {
  usePutMerchantAlias,
  useDeleteMerchantAlias,
  useSuggestMerchantName,
  getListTransactionsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

// (#888 — Merchant rename & learn, Phase 2) Shared rename affordance used
// identically on the Chase (transactions.tsx) and Amex (amex.tsx) pages.
//
// A small pencil button next to the merchant title opens a popover where the
// user can rename the merchant. The rename is keyed on the row's stable
// `merchantSignature`, so it applies to every current AND future transaction
// that shares the signature. "✨ Suggest" asks the server (Anthropic, with a
// deterministic fallback) for a clean name; "Reset to bank default" clears the
// alias. All three mutations invalidate the transactions list so every
// same-signature row re-renders without a manual reload.
export interface MerchantRenamePopoverTx {
  id: string;
  description: string;
  displayName?: string | null;
  merchantSignature?: string | null;
}

export function MerchantRenamePopover({ tx }: { tx: MerchantRenamePopoverTx }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const currentName = (tx.displayName || tx.description || "").trim();
  const [value, setValue] = useState(currentName);
  const [suggestFailed, setSuggestFailed] = useState(false);

  const putAlias = usePutMerchantAlias();
  const deleteAlias = useDeleteMerchantAlias();
  const suggestName = useSuggestMerchantName();

  const busy =
    putAlias.isPending || deleteAlias.isPending || suggestName.isPending;
  const trimmed = value.trim();
  const canSave = trimmed.length > 0 && trimmed !== currentName && !busy;

  const invalidateList = () =>
    queryClient.invalidateQueries({ queryKey: getListTransactionsQueryKey() });

  // Reset the input to the row's current resolved name whenever the popover
  // opens, so reopening after an external change shows fresh state.
  const handleOpenChange = (next: boolean) => {
    if (next) {
      setValue((tx.displayName || tx.description || "").trim());
      setSuggestFailed(false);
    }
    setOpen(next);
  };

  const handleSuggest = () => {
    setSuggestFailed(false);
    suggestName.mutate(
      { data: { description: tx.description } },
      {
        onSuccess: (res) => {
          if (res?.suggestion) setValue(res.suggestion);
          // A deterministic fallback still returns a usable name; only flag
          // "couldn't suggest" when the server gave us nothing at all.
          if (!res?.suggestion) setSuggestFailed(true);
        },
        onError: () => setSuggestFailed(true),
      },
    );
  };

  const handleSave = () => {
    const alias = value.trim();
    if (!alias) return;
    putAlias.mutate(
      { data: { description: tx.description, alias } },
      {
        onSuccess: (res) => {
          invalidateList();
          setOpen(false);
          const n = res?.affectedCount ?? 1;
          toast({
            title: `Renamed to "${res?.alias ?? alias}"`,
            description: `Applies to ${n} ${n === 1 ? "transaction" : "transactions"} now, plus any future ones with the same merchant.`,
          });
        },
        onError: (err) => {
          toast({
            title: "Couldn't rename merchant",
            description: err instanceof Error ? err.message : "Please try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleReset = () => {
    const signature = tx.merchantSignature ?? "";
    if (!signature) {
      toast({
        title: "Nothing to reset",
        description: "This row has no saved custom name.",
      });
      return;
    }
    deleteAlias.mutate(
      { params: { signature } },
      {
        onSuccess: () => {
          invalidateList();
          setOpen(false);
          toast({ title: "Reset to default" });
        },
        onError: (err) => {
          toast({
            title: "Couldn't reset merchant",
            description: err instanceof Error ? err.message : "Please try again.",
            variant: "destructive",
          });
        },
      },
    );
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 text-muted-foreground shrink-0"
          aria-label="Rename merchant"
          data-testid={`rename-merchant-${tx.id}`}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80"
        data-testid={`rename-popover-${tx.id}`}
      >
        <div className="space-y-3">
          <div>
            <h4 className="font-medium text-sm">Rename merchant</h4>
            <p
              className="text-[11px] text-muted-foreground truncate mt-0.5"
              title={tx.description}
            >
              {tx.description}
            </p>
          </div>

          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Friendly merchant name"
            disabled={busy}
            data-testid={`rename-input-${tx.id}`}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSave) {
                e.preventDefault();
                handleSave();
              }
            }}
          />

          {suggestFailed && (
            <p className="text-[11px] text-muted-foreground">
              Couldn't suggest a name — keep editing.
            </p>
          )}

          <div className="flex items-center justify-between gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={handleSuggest}
              disabled={busy}
              data-testid={`rename-suggest-${tx.id}`}
            >
              {suggestName.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Sparkles className="h-3.5 w-3.5" />
              )}
              Suggest
            </Button>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={!canSave}
              data-testid={`rename-save-${tx.id}`}
            >
              {putAlias.isPending && (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
              )}
              Save
            </Button>
          </div>

          <button
            type="button"
            className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline disabled:opacity-50"
            onClick={handleReset}
            disabled={busy || !tx.merchantSignature}
            data-testid={`rename-reset-${tx.id}`}
          >
            Reset to bank default
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
