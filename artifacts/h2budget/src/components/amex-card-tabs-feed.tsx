import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  getGetAmexWeeklyPayoffQueryKey,
  getGetSettingsQueryKey,
  getListPlaidItemsQueryKey,
  type AmexWeeklyPayoff,
  type PlaidItemDetail,
  type Settings,
} from "@workspace/api-client-react";
import { amexCardTabs } from "@/lib/amexCardTabs";
import type { SectionTab } from "@/lib/navModel";

/**
 * Amex's tab per card, for the shell. Renders nothing: it reads data the Amex
 * page already loaded and reports the tabs up. CACHE-ONLY (`enabled: false`) —
 * the shell never starts a request of its own; until the cards are in the
 * cache the row is just "All cards". Its own small chunk, loaded after first
 * paint (the landing's entry graph has no room for the naming rules).
 */
export default function AmexCardTabsFeed({ onTabs }: { onTabs: (tabs: SectionTab[]) => void }) {
  const payoff = useQuery<AmexWeeklyPayoff>({ queryKey: getGetAmexWeeklyPayoffQueryKey(), enabled: false });
  const settings = useQuery<Settings>({ queryKey: getGetSettingsQueryKey(), enabled: false });
  const items = useQuery<PlaidItemDetail[]>({ queryKey: getListPlaidItemsQueryKey(), enabled: false });
  const tabs = useMemo(
    () => amexCardTabs([...(payoff.data?.cards ?? []), ...(payoff.data?.debtLinkedCards ?? [])], settings.data, items.data),
    [payoff.data?.cards, payoff.data?.debtLinkedCards, settings.data, items.data],
  );
  useEffect(() => onTabs(tabs), [tabs, onTabs]);
  return null;
}
