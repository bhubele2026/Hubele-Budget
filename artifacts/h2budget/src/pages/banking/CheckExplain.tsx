import { lazy, Suspense, useState } from "react";
import { getGetBankingCheckExplainQueryKey, useGetBankingCheckExplain } from "@workspace/api-client-react/features";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

// The body (its words and markup) is its own lazy chunk: it draws only once the dialog opens.
const Body = lazy(() => import("./CheckExplainBody"));

/**
 * ⭐ (T2) REVIEW DIFFERENCE — the last balance check, explained
 * (`GET /banking/check-explain`, read-only, no Plaid call). Replaces the old
 * "Investigate" (which opened "Why this number?" — today's balance, not the
 * check). The query runs only while the dialog is open and is asked afresh each
 * time (`staleTime: 0`); the record is never changed from here.
 */
export function CheckExplain({
  defaultOpen = false,
  label = "Review difference",
  open: openProp,
  onOpenChange,
}: {
  defaultOpen?: boolean;
  label?: string;
  /** Controlled: the page opens it from elsewhere too ("Why this number?" → Review difference). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;
  const setOpen = (o: boolean) => {
    setOpenState(o);
    onOpenChange?.(o);
  };
  const query = useGetBankingCheckExplain({
    query: { queryKey: getGetBankingCheckExplainQueryKey(), enabled: open, staleTime: 0, gcTime: 60_000 },
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button type="button" className="press font-semibold text-brand-navy underline" data-testid="br-review-difference">
          {label}
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[85dvh] max-w-lg overflow-y-auto" data-testid="check-explain">
        <DialogTitle className="text-title font-semibold text-brand-navy">Review difference</DialogTitle>
        <DialogDescription className="sr-only">What the last balance check compared, and what explains the difference.</DialogDescription>
        <Suspense fallback={<p className="text-label text-neutral-600">Loading…</p>}>
          <Body query={query} />
        </Suspense>
      </DialogContent>
    </Dialog>
  );
}
