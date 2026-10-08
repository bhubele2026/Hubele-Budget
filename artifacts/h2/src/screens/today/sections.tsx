import { useState } from "react";
import { ActionCard } from "@/kit/ActionCard";
import { Note } from "@/kit/Note";
import { Section } from "@/kit/Section";
import { SkeletonLine } from "@/kit/Skeleton";
import { type Attention } from "./attention";

/** ONE THING — steps through the matches with "Next"; nothing is saved. */
export function OneThing({ items, loading }: { items: Attention[]; loading: boolean }) {
  const [at, setAt] = useState(0);
  const item = items[at % items.length];
  return (
    <Section label="One thing" data-testid="section-one-thing">
      {loading ? (
        <SkeletonLine className="w-56" />
      ) : !item ? (
        // Nothing was read, so nothing can be said: never "Nothing needs you".
        <Note kind="empty">Can't check until the numbers load.</Note>
      ) : (
        <ActionCard
          data-testid="action-card"
          title={item.title}
          detail={item.detail}
          action={item.action}
          done={item.kind === "nothing"}
          onNext={items.length > 1 ? () => setAt((n) => (n + 1) % items.length) : undefined}
        />
      )}
    </Section>
  );
}
