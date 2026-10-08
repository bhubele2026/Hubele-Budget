import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetUiPreferencesQueryKey,
  useGetUiPreferences,
  useUpdateUiPreferences,
  type UiPreferences,
} from "@workspace/api-client-react/ledger";
import { OWN_INVALIDATION } from "@/data/mutationInvalidation";
import { Button, buttonClass } from "@/kit/Button";
import { Sheet } from "@/kit/Sheet";
import { centsValue, fmtMoney } from "@/lib/money";

/** Bump this id for the next sheet; a user who saw "h2-1" sees the new one once. */
export const WHATS_NEW_ID = "h2-1";

function Amount({ n }: { n: number | null }) {
  return n == null ? (
    <span>—</span>
  ) : (
    <data value={centsValue(n)} className="tnum">
      {fmtMoney(n)}
    </data>
  );
}

/**
 * ⭐ WHAT'S NEW — three short steps, once, for a household that already has
 * history. The choice is saved on the signed-in USER (`PUT /me/ui-preferences`,
 * merged into what is already there), not on the household.
 *
 * Step 2 only EXPLAINS filing and links to Automation, where the owner's
 * switches live. This sheet writes nothing but "seen".
 */
export default function WhatsNew({ bank, spentWeek }: { bank: number | null; spentWeek: number | null }) {
  const qc = useQueryClient();
  const prefs = useGetUiPreferences({
    query: { queryKey: getGetUiPreferencesQueryKey(), staleTime: 30 * 60_000, gcTime: 60 * 60_000 },
  });
  const save = useUpdateUiPreferences({ mutation: { meta: OWN_INVALIDATION } });
  const [step, setStep] = useState(0);
  const [closed, setClosed] = useState(false);

  const current: UiPreferences | undefined = prefs.data;
  if (!current || closed || current.whatsNewSeen === WHATS_NEW_ID) return null;

  const finish = () => {
    setClosed(true);
    const merged: UiPreferences = { ...current, whatsNewSeen: WHATS_NEW_ID };
    qc.setQueryData(getGetUiPreferencesQueryKey(), merged);
    save.mutate({ data: merged });
  };

  const last = step === 2;
  return (
    <Sheet
      open
      onOpenChange={(o) => {
        if (!o) finish();
      }}
      title="What's new in H2"
      description={`Step ${step + 1} of 3`}
    >
      <div className="flex flex-col gap-4" data-testid="whats-new" data-step={step + 1}>
        {step === 0 && (
          <>
            <p className="type-headline text-ink">Your numbers haven't changed — they're just read from a new page.</p>
            <p className="type-body text-ink-2">
              Bank balance <Amount n={bank} /> and spent this week <Amount n={spentWeek} /> are the same as before.
            </p>
          </>
        )}
        {step === 1 && (
          <>
            <p className="type-headline text-ink">H2 files new charges for you.</p>
            <p className="type-body text-ink-2">
              It uses your rules and what you taught it first. Anything it is unsure about waits for you in Review. The owner chooses how far it may go in
              Automation.
            </p>
            <Link href="/household/automation" onClick={finish} className={buttonClass({ variant: "link", size: "md" })} data-testid="open-automation">
              Open Automation
            </Link>
          </>
        )}
        {step === 2 && (
          <>
            <p className="type-headline text-ink">A morning text at 7:00 can be turned on in Recap.</p>
            <Link href="/recap" onClick={finish} className={buttonClass({ variant: "link", size: "md" })}>
              Open Recap
            </Link>
          </>
        )}
        <div className="flex items-center gap-3 pt-2">
          {step > 0 && (
            <Button variant="quiet" onClick={() => setStep(step - 1)}>
              Back
            </Button>
          )}
          <Button variant="primary" onClick={last ? finish : () => setStep(step + 1)}>
            {last ? "Done" : "Next"}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
