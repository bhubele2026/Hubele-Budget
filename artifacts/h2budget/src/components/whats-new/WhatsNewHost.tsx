import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { getGetVersionQueryKey } from "@workspace/api-client-react";
import {
  getGetWhatsNewMeQueryKey,
  getWhatsNewMe,
  useGetWhatsNewMe,
  useGetWhatsNewReads,
  getGetWhatsNewReadsQueryKey,
  useMarkWhatsNewRead,
  type WhatsNewMe,
} from "@workspace/api-client-react/features";
import { WHATS_NEW, unreadUpdates, type WhatsNewReaderLine } from "@workspace/avalanche-core/whatsNew";
import { useOwner } from "@/hooks/useOwner";
import { toast } from "@/hooks/use-toast";
import { OWN_INVALIDATION } from "@/lib/mutationInvalidation";
import { APP_VERSION } from "@/lib/version";
import { onWhatsNewOpen, setWhatsNewUnread } from "@/lib/whatsNewSignal";
import { MAX_WAIT_MS, greetBlocker, scheduleGreet } from "./greet";
import WhatsNewSheet, { type ReadReport } from "./WhatsNewSheet";

/**
 * ⭐ (WN) THE WHAT'S NEW HOST — lazy (loaded by `WhatsNewMount` at idle, or at
 * once when "What's new" is pressed first). It asks the server what this
 * person has read (`/whats-new/me`), tells the signal how many are unread (the
 * "New" chip on the account menu and the dashboard link), greets once the page
 * is quiet (`greet.ts`), and records "I've read this" on the server.
 *
 * ⚠️ The server is the only record. The browser keeps a press for this tab only
 * (so the sheet does not come back while the save is on its way); a save that
 * fails after its retries says so and asks again on the next load.
 * ⚠️ The press is not a money write: `OWN_INVALIDATION` keeps the global write
 * rule from refetching the dashboard's numbers.
 */

const MIN = 60_000;
export const SAVE_FAILED_WORDS = "H2 couldn't save that. It will ask again next time.";

/** What this tab remembers per signed-in person (a shared device never mixes two people's state). */
interface Session {
  clicked: Set<string>;
  /** The unread set already greeted in this tab (greet at most once per set). */
  greeted: string | null;
  saveFailed: boolean;
}
const sessions = new Map<string, Session>();
function sessionFor(userId: string): Session {
  let s = sessions.get(userId);
  if (!s) {
    s = { clicked: new Set(), greeted: null, saveFailed: false };
    sessions.set(userId, s);
  }
  return s;
}
export function _resetWhatsNewSessionsForTests(): void {
  sessions.clear();
}

function unreadOf(me: WhatsNewMe | undefined, session: Session) {
  if (!me) return null;
  return unreadUpdates(WHATS_NEW, new Set([...me.read, ...session.clicked]), me.from);
}

/** Production only: has the version check answered, and is a reload coming? */
function useVersionState() {
  const qc = useQueryClient();
  return useCallback(
    (waitedMs: number): "ok" | "waiting" | "outdated" => {
      if (!import.meta.env.PROD || APP_VERSION === "dev") return "ok";
      const state = qc.getQueryState<{ version?: string }>(getGetVersionQueryKey());
      const served = state?.data?.version;
      if (served && served !== APP_VERSION) return "outdated";
      if (!served && state?.status !== "error" && waitedMs < MAX_WAIT_MS) return "waiting";
      return "ok";
    },
    [qc],
  );
}

export default function WhatsNewHost({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const [location] = useLocation();
  const pathRef = useRef(location);
  pathRef.current = location;
  const owner = useOwner();
  const session = sessionFor(userId);
  const [open, setOpen] = useState<null | { fromLink: boolean }>(null);
  // Bumped when this tab's own state changes (a press), so the unread set is worked again.
  const [tick, setTick] = useState(0);

  const me = useGetWhatsNewMe({
    query: { queryKey: getGetWhatsNewMeQueryKey(), staleTime: 30 * MIN, gcTime: 60 * MIN, retry: 1 },
  });
  const mark = useMarkWhatsNewRead({ mutation: { meta: OWN_INVALIDATION, retry: 2 } });
  const reads = useGetWhatsNewReads({
    query: {
      queryKey: getGetWhatsNewReadsQueryKey(),
      enabled: owner === true && open != null,
      refetchOnMount: "always",
      staleTime: 0,
      gcTime: 5 * MIN,
      retry: false,
    },
  });

  // `tick`: this tab's presses live in `session`, which React cannot see change.
  const unread = useMemo(() => unreadOf(me.data, session), [me.data, session, tick]);
  const unreadKey = unread ? unread.map((u) => u.id).join(",") : null;

  // The signal: a count only when the server has answered; unknown otherwise.
  useEffect(() => {
    setWhatsNewUnread(unread ? unread.length : null);
  }, [unread]);
  useEffect(() => () => setWhatsNewUnread(null), []);

  // "What's new" pressed (menu, drawer, dashboard link).
  useEffect(() => onWhatsNewOpen(() => setOpen({ fromLink: true })), []);

  const versionState = useVersionState();

  // The greeting: once per tab for this set of unread notes, after the page is quiet.
  useEffect(() => {
    if (!unreadKey || open || session.saveFailed || session.greeted === unreadKey) return;
    return scheduleGreet({
      isQuiet: () => qc.isFetching() === 0,
      blocker: (waited) => greetBlocker({ path: pathRef.current, version: versionState(waited) }),
      greet: async () => {
        // Ask the server again: a note read on another device never pops up here.
        const fresh = await qc.fetchQuery({
          queryKey: getGetWhatsNewMeQueryKey(),
          queryFn: () => getWhatsNewMe(),
          staleTime: 0,
          retry: false,
        });
        const now = unreadOf(fresh, session);
        if (!now || now.length === 0) {
          setTick((t) => t + 1);
          return true;
        }
        // Something opened while it asked: hold, and look again.
        if (greetBlocker({ path: pathRef.current, version: versionState(MAX_WAIT_MS) })) return false;
        session.greeted = now.map((u) => u.id).join(",");
        setOpen({ fromLink: false });
        return true;
      },
    });
  }, [unreadKey, open, session, qc, versionState]);

  const acknowledge = () => {
    const ids = (unread ?? []).map((u) => u.id);
    for (const id of ids) session.clicked.add(id);
    session.greeted = unreadKey;
    setOpen(null);
    setTick((t) => t + 1);
    if (ids.length === 0) return;
    mark.mutate(
      { data: { ids } },
      {
        onSuccess: (r) => {
          qc.setQueryData<WhatsNewMe>(getGetWhatsNewMeQueryKey(), (old) =>
            old ? { ...old, read: Array.from(new Set([...old.read, ...r.ids])) } : old,
          );
        },
        onError: () => {
          session.saveFailed = true;
          toast({ title: SAVE_FAILED_WORDS });
        },
      },
    );
  };

  const report: ReadReport = useMemo(() => {
    if (owner !== true) return null;
    if (reads.isError) return null;
    if (!reads.data) return undefined;
    return new Map(
      reads.data.updates.map((u) => [u.id, u.readers.map((r): WhatsNewReaderLine => ({ name: r.name, readAt: r.readAt ?? null }))]),
    );
  }, [owner, reads.data, reads.isError]);

  if (!open) return null;
  return (
    <WhatsNewSheet
      updates={WHATS_NEW}
      unread={unread ?? []}
      fromLink={open.fromLink}
      owner={owner === true}
      report={report}
      onRead={acknowledge}
      onClose={() => setOpen(null)}
    />
  );
}
