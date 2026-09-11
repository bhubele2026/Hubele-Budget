import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetUiPreferencesQueryKey,
  useGetUiPreferences,
  useUpdateUiPreferences,
} from "@workspace/api-client-react/ledger";
import { OWN_INVALIDATION } from "@/lib/mutationInvalidation";

/** The first-paint seed. The saved preference lives on the server (per user). */
export const CHASE_HIDE_REVIEWED_STORAGE_KEY = "h2-chase-hide-reviewed";

function readSeed(): boolean {
  try {
    return window.localStorage.getItem(CHASE_HIDE_REVIEWED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function writeSeed(value: boolean): void {
  try {
    window.localStorage.setItem(CHASE_HIDE_REVIEWED_STORAGE_KEY, String(value));
  } catch {
    // Private browsing or blocked storage: the server copy still holds it.
  }
}

/**
 * "Clear reviewed from list", remembered per user across devices.
 *
 * Stored as `user_ui_preferences.chaseHideReviewed` (jsonb, no DDL) through
 * GET/PUT /me/ui-preferences. localStorage seeds the first paint so the list
 * does not open one way and flip the other once the preference arrives. A view
 * setting only: the list asks the ledger for `reviewed=false`, and no total or
 * balance depends on it.
 */
export function useChaseHideReviewed(): [boolean, (next: boolean) => void] {
  const [hide, setHide] = useState(readSeed);
  // Once the user has clicked, a late server answer must not undo the click.
  const touched = useRef(false);
  const queryClient = useQueryClient();
  const prefs = useGetUiPreferences({
    query: {
      queryKey: getGetUiPreferencesQueryKey(),
      staleTime: 30 * 60_000,
      gcTime: 30 * 60_000,
    },
  });
  // A view setting moves no data: no refetch of balances, spine or reports.
  const save = useUpdateUiPreferences({ mutation: { meta: OWN_INVALIDATION } });
  const saved = prefs.data?.chaseHideReviewed;

  useEffect(() => {
    if (touched.current || typeof saved !== "boolean") return;
    setHide(saved);
    writeSeed(saved);
  }, [saved]);

  const { mutate } = save;
  const set = useCallback(
    (next: boolean) => {
      touched.current = true;
      setHide(next);
      writeSeed(next);
      mutate(
        { data: { chaseHideReviewed: next } },
        {
          onSuccess: (stored) => {
            queryClient.setQueryData(getGetUiPreferencesQueryKey(), stored);
          },
        },
      );
    },
    [mutate, queryClient],
  );

  return [hide, set];
}
