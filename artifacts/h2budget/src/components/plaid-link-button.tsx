import { useCallback, useEffect, useState } from "react";
import { usePlaidLink } from "react-plaid-link";
import {
  useCreatePlaidLinkToken,
  useExchangePlaidPublicToken,
  getListPlaidItemsQueryKey,
  getListTransactionsQueryKey,
  getListPlaidLiabilityAccountsQueryKey,
  listPlaidLiabilityAccounts,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Plus, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export function PlaidLinkButton({
  onLinked,
  label,
}: {
  onLinked?: () => void;
  label?: string;
} = {}) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const createLinkToken = useCreatePlaidLinkToken();
  const exchange = useExchangePlaidPublicToken();
  const qc = useQueryClient();
  const { toast } = useToast();

  const fetchToken = useCallback(() => {
    createLinkToken.mutate(undefined, {
      onSuccess: (data) => setLinkToken(data.linkToken),
      onError: (err) => {
        toast({
          title: "Could not start Plaid Link",
          description: String(err),
          variant: "destructive",
        });
      },
    });
  }, [createLinkToken, toast]);

  const onSuccess = useCallback(
    (publicToken: string, metadata: { institution?: { institution_id?: string; name?: string } | null }) => {
      exchange.mutate(
        {
          data: {
            publicToken,
            institutionId: metadata.institution?.institution_id ?? null,
            institutionName: metadata.institution?.name ?? null,
          },
        },
        {
          onSuccess: async () => {
            qc.invalidateQueries({ queryKey: getListPlaidItemsQueryKey() });
            qc.invalidateQueries({ queryKey: getListTransactionsQueryKey() });
            // Trigger a server-side liabilities fetch so debt-like accounts
            // appear immediately in pickers, then refresh the cached query.
            try {
              await listPlaidLiabilityAccounts({ refresh: true });
            } catch {
              // ignore — query invalidation below will retry without refresh
            }
            qc.invalidateQueries({ queryKey: getListPlaidLiabilityAccountsQueryKey() });
            toast({ title: "Account linked", description: "Transactions are syncing." });
            setLinkToken(null);
            onLinked?.();
          },
          onError: (err) => {
            toast({
              title: "Link failed",
              description: String(err),
              variant: "destructive",
            });
          },
        },
      );
    },
    [exchange, qc, toast],
  );

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess,
    onExit: () => setLinkToken(null),
  });

  useEffect(() => {
    if (linkToken && ready) {
      open();
    }
  }, [linkToken, ready, open]);

  const busy = createLinkToken.isPending || exchange.isPending;

  return (
    <Button onClick={fetchToken} disabled={busy} data-testid="button-link-bank">
      {busy ? (
        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
      ) : (
        <Plus className="w-4 h-4 mr-2" />
      )}
      {label ?? "Link a Bank or Card"}
    </Button>
  );
}
