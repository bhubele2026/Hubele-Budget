import { useQuery } from "@tanstack/react-query";
import { previewRecap } from "@workspace/api-client-react/features";
import { OWN_INVALIDATION } from "@/lib/mutationInvalidation";
import { dayLabel } from "./shared";
import { cleanRecap, recapSourceWords } from "./recapWords";

export { cleanRecap, recapSourceWords };

const MIN = 60_000;

/**
 * (D14) The recap preview is a POST that reads the household and may spend one
 * of the six daily model calls, so it is a query, not a mutation: one request
 * per open at most, none while the answer is under ten minutes old, no retry
 * (a retry is a second model call), and `meta: OWN_INVALIDATION` so it can never
 * be mistaken for a write that marks the spine, reports and ledger stale. A
 * mutation here ran the after-write rule on every open.
 *
 * (Dashboard refinement) It now runs only when the household opens "Preview
 * tomorrow's morning text": the landing no longer asks for it on every open,
 * and the generated `features` operation stays off the open path.
 */
export const RECAP_PREVIEW_KEY = ["/api/recap/preview"] as const;
export function useRecapPreviewQ() {
  const q = useQuery({
    queryKey: RECAP_PREVIEW_KEY,
    queryFn: ({ signal }) => previewRecap({}, { signal }),
    staleTime: 10 * MIN,
    gcTime: 30 * MIN,
    retry: false,
    refetchOnWindowFocus: false,
    meta: OWN_INVALIDATION,
  });
  return {
    data: q.data,
    isLoading: q.isPending,
    isError: q.isError,
    retry: () => void q.refetch(),
  };
}

export default function RecapPreview() {
  const recap = useRecapPreviewQ();
  const r = recap.data;
  const cleaned = r ? cleanRecap(r.model?.text ?? r.template.text, r.facts as Record<string, unknown>) : null;
  const forDay = dayLabel(cleaned?.forDate);
  return (
    <div className="max-w-2xl rounded-control bg-platinum-3 px-4 py-3" data-testid="dash-recap">
      <div className="flex flex-wrap items-center gap-2">
        {r ? <span className="chip gray" data-testid="dash-recap-badge">{recapSourceWords(r.model)}</span> : null}
        {forDay ? <span className="text-micro text-neutral-500" data-testid="dash-recap-for">for {forDay}</span> : null}
      </div>
      <p className="mt-2 whitespace-pre-line text-body text-brand-ink" data-testid="dash-recap-text">
        {cleaned?.body ?? (recap.isError ? "The morning text is not available right now." : "Writing the morning text…")}
      </p>
    </div>
  );
}
