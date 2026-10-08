import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import {
  getGetPlaidEnvironmentQueryKey,
  getListPlaidItemsQueryKey,
  useClearPlaidItemRefreshDisabled,
  useDeletePlaidItem,
  useGetPlaidEnvironment,
  useListPlaidItems,
  type PlaidEnvironmentInfo,
  type PlaidItemDetail,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { readOf, type Read } from "@/data/todayData";
import { Button, buttonClass } from "@/kit/Button";
import { Disclosure } from "@/kit/Disclosure";
import { Note } from "@/kit/Note";
import { Section } from "@/kit/Section";
import { Sheet } from "@/kit/Sheet";
import { SkeletonLine } from "@/kit/Skeleton";
import { StatusWord } from "@/kit/StatusWord";
import { useToast } from "@/screens/plan/parts";
import { useBankLink, usePlaidSync } from "./BankLink";
import { HouseholdFrame } from "./parts";
import {
  FORCE_SENTENCE,
  POST_LINK_POLL_DELAYS_MS,
  accountLine,
  apiMessage,
  itemStatus,
  itemsNeedingReconnect,
  lastSyncedWords,
  autoUpdatesWords,
  postLinkWords,
  syncResultWords,
  type PostLinkStatus,
} from "./words";

export interface BanksData {
  items: Read<PlaidItemDetail[]>;
  env: Read<PlaidEnvironmentInfo>;
}

const ITEMS_CACHE = { staleTime: 60_000, gcTime: 30 * 60_000 } as const;

export function useBanksData(): BanksData {
  const items = useListPlaidItems({
    query: {
      queryKey: getListPlaidItemsQueryKey(),
      ...ITEMS_CACHE,
      // While a bank is still staging its history, look again every 90 seconds.
      refetchInterval: (q) => (q.state.data?.some((it) => it.stillPreparing) ? 90_000 : false),
    },
  });
  const env = useGetPlaidEnvironment({ query: { queryKey: getGetPlaidEnvironmentQueryKey(), staleTime: 30 * 60_000, gcTime: 60 * 60_000 } });
  return { items: readOf(items), env: readOf(env) };
}

export default function Household() {
  return <BanksView data={useBanksData()} />;
}

type Pending = { kind: "force" | "remove"; item: PlaidItemDetail } | { kind: "reenable"; item: PlaidItemDetail } | null;

function ProgressPanel({ status, onDismiss }: { status: PostLinkStatus; onDismiss: () => void }) {
  const { title, detail } = postLinkWords(status);
  const done = status.phase === "ready" || status.phase === "still-preparing" || status.phase === "error";
  return (
    <div className="mb-6" data-testid="post-link-progress" data-phase={status.phase}>
      <Note
        kind={status.phase === "error" || status.needsReconnect ? "error" : "empty"}
        action={
          done ? (
            <Button variant="link" size="sm" onClick={onDismiss} data-testid="post-link-dismiss">
              Dismiss
            </Button>
          ) : undefined
        }
      >
        <p className="type-label text-ink" data-testid="post-link-title">
          {title}
        </p>
        <p className="type-caption text-ink-2" data-testid="post-link-detail">
          {detail}
        </p>
      </Note>
    </div>
  );
}

/**
 * ⭐ BANKS — every linked bank, in words. Each row says what the bank is, which
 * accounts it holds, when it last answered, and one status word. Sync is the
 * free pull; the billable "fresh pull" sits behind a disclosure AND a confirm.
 * Nothing on this page is a money figure.
 */
export function BanksView({ data, now, pollDelays = POST_LINK_POLL_DELAYS_MS }: { data: BanksData; now?: Date; pollDelays?: readonly number[] }) {
  const { items, env } = data;
  const qc = useQueryClient();
  const { say, node: toast } = useToast();
  const { runSync } = usePlaidSync();
  const del = useDeletePlaidItem();
  const clearDisabled = useClearPlaidItemRefreshDisabled();
  const link = useBankLink({ items: items.data, itemsFetched: items.data !== undefined, runSync, say, pollDelays });
  const [syncing, setSyncing] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Pending>(null);
  const returnRef = useRef<HTMLElement | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const list = items.data ?? [];
  const reconnecting = itemsNeedingReconnect(list);
  const notConfigured = env.data ? !env.data.configured || !!env.data.configError : false;

  const open = (e: React.MouseEvent<HTMLElement>, p: NonNullable<Pending>) => {
    returnRef.current = e.currentTarget;
    setPending(p);
  };

  const sync = async (item: PlaidItemDetail, force = false) => {
    setSyncing(item.id);
    const s = await runSync(force ? { itemId: item.id, force: true } : { itemId: item.id });
    if (!alive.current) return;
    setSyncing(null);
    setResults((r) => ({ ...r, [item.id]: syncResultWords(s) }));
  };

  const remove = (item: PlaidItemDetail) =>
    del.mutate(
      { id: item.id },
      {
        onSuccess: () => {
          void qc.invalidateQueries({ queryKey: getListPlaidItemsQueryKey() });
          setPending(null);
          say(`${item.institutionName ?? "The bank"} removed. Its history stays.`);
        },
        onError: (e) => say(apiMessage(e, "Couldn't remove that bank. Try again."), "error"),
      },
    );

  const reenable = async (item: PlaidItemDetail) => {
    setPending(null);
    try {
      await clearDisabled.mutateAsync({ id: item.id });
      await qc.invalidateQueries({ queryKey: getListPlaidItemsQueryKey() });
      await sync(item, true);
    } catch (e) {
      say(apiMessage(e, "Couldn't turn fast refresh back on. Try again."), "error");
    }
  };

  return (
    <HouseholdFrame current="banks">
      {link.progress && <ProgressPanel status={link.progress} onDismiss={link.dismissProgress} />}

      {reconnecting.length > 0 && (
        <div className="mb-6" data-testid="reauth-banner">
          <Note
            kind="error"
            action={
              <Button size="sm" variant="primary" onClick={() => link.reconnect(reconnecting[0]!)} data-testid="banner-reconnect">
                Reconnect
              </Button>
            }
          >
            {reconnecting.length === 1
              ? `${reconnecting[0]!.institutionName ?? "Your bank"} needs reconnecting.`
              : `${reconnecting[0]!.institutionName ?? "Your bank"} and ${reconnecting.length - 1} more need reconnecting.`}
          </Note>
        </div>
      )}

      <Section
        label="Linked banks"
        data-testid="section-banks"
        action={
          <Button variant="link" size="sm" onClick={link.start} disabled={link.busy || notConfigured || items.data === undefined} data-testid="connect-bank">
            {link.busy ? "Starting…" : "Connect a bank"}
          </Button>
        }
        foot={notConfigured ? env.data?.configError || "Bank linking is not set up on this server yet." : undefined}
      >
        {items.state === "failed" ? (
          <Note kind="error" onRetry={items.refetch} retrying={items.isFetching} data-testid="banks-error">
            Couldn't load your banks.
          </Note>
        ) : items.data === undefined ? (
          <div className="flex flex-col gap-3" data-testid="banks-skeleton" aria-busy="true">
            <SkeletonLine className="w-48" />
            <SkeletonLine className="w-64" />
          </div>
        ) : list.length === 0 ? (
          <Note kind="empty" data-testid="banks-empty">
            No bank is linked yet. Connect one to pull in your transactions.
          </Note>
        ) : (
          <>
            {items.state === "refresh-failed" && (
              <div className="mb-3">
                <Note kind="error" onRetry={items.refetch} retrying={items.isFetching}>
                  Couldn't refresh. Showing what was here before.
                </Note>
              </div>
            )}
            <ul className="flex flex-col" data-testid="bank-list">
              {list.map((it) => {
                const st = itemStatus(it);
                const isSyncing = syncing === it.id;
                const name = it.institutionName ?? "Your bank";
                return (
                  <li key={it.id} className="flex flex-col gap-3 border-t border-rule py-4 first:border-t-0" data-testid="bank-row" data-status={st.kind}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="type-body font-semibold text-ink" data-testid="bank-name">
                          {name}
                        </span>
                        <span className="type-caption text-ink-3" data-testid="bank-synced">
                          {lastSyncedWords(it, now)}
                        </span>
                        {autoUpdatesWords(it) && (
                          <span className="type-caption text-ink-3 border-t border-rule pt-1" data-testid="bank-auto-updates">
                            {autoUpdatesWords(it)}
                          </span>
                        )}
                      </div>
                      <StatusWord tone={st.tone} data-testid="bank-status">
                        {st.word}
                      </StatusWord>
                    </div>
                    {st.detail && (
                      <p className="type-caption text-ink-2" data-testid="bank-detail">
                        {st.detail}
                      </p>
                    )}
                    {it.accounts.length > 0 && (
                      <ul className="flex flex-col gap-1" data-testid="bank-accounts">
                        {it.accounts.map((a) => (
                          <li key={a.id} className="type-caption text-ink-2">
                            {accountLine(a)}
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="flex flex-wrap items-center gap-3">
                      {st.kind === "reconnect" && (
                        <Button size="sm" variant="primary" onClick={() => link.reconnect(it)} disabled={link.busy} data-testid={`reconnect-${it.id}`}>
                          Reconnect
                        </Button>
                      )}
                      <Button size="sm" onClick={() => void sync(it)} disabled={syncing !== null} aria-label={`Sync ${name}`} data-testid={`sync-${it.id}`}>
                        {isSyncing ? "Syncing…" : "Sync"}
                      </Button>
                      <Button size="sm" variant="danger" onClick={(e) => open(e, { kind: "remove", item: it })} aria-label={`Remove ${name}`} data-testid={`remove-${it.id}`}>
                        Remove
                      </Button>
                      {results[it.id] && (
                        <span className="type-caption text-ink-2" role="status" data-testid={`sync-result-${it.id}`}>
                          {results[it.id]}
                        </span>
                      )}
                    </div>
                    {it.refreshProductDisabledAt && (
                      <p className="type-caption text-ink-2" data-testid={`refresh-paused-${it.id}`}>
                        Fast refresh is paused for this bank.{" "}
                        <button type="button" className={buttonClass({ variant: "link", size: "sm" })} onClick={(e) => open(e, { kind: "reenable", item: it })}>
                          Turn it back on
                        </button>
                      </p>
                    )}
                    <Disclosure summary="A pending charge is missing?">
                      <p>{FORCE_SENTENCE}</p>
                      <div className="mt-3">
                        <Button size="sm" onClick={(e) => open(e, { kind: "force", item: it })} disabled={syncing !== null} data-testid={`force-${it.id}`}>
                          Force refresh
                        </Button>
                      </div>
                    </Disclosure>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Section>

      <Section label="Filing" data-testid="section-filing">
        <Link href="/household/automation" className={buttonClass({ variant: "link", size: "sm" })} data-testid="automation-link">
          Automation — filing, rules, what the model may do →
        </Link>
      </Section>

      <Section label="Other tools" data-testid="section-classic">
        <p className="type-body text-ink-2">
          Workbook import, duplicate cleanup and non-production link cleanup still live in the{" "}
          <a href="/classic/settings" className={buttonClass({ variant: "link", size: "sm" })} data-testid="classic-settings">
            classic app
          </a>
          .
        </p>
      </Section>

      {pending?.kind === "force" && (
        <Sheet open onOpenChange={(o) => !o && setPending(null)} title={`Fresh pull from ${pending.item.institutionName ?? "the bank"}?`} description={FORCE_SENTENCE} returnFocusRef={returnRef}>
          <div className="flex flex-col gap-3">
            <Button
              variant="primary"
              onClick={() => {
                const it = pending.item;
                setPending(null);
                void sync(it, true);
              }}
              data-testid="force-confirm"
            >
              Yes, pull fresh
            </Button>
            <Button onClick={() => setPending(null)}>Not now</Button>
          </div>
        </Sheet>
      )}
      {pending?.kind === "reenable" && (
        <Sheet open onOpenChange={(o) => !o && setPending(null)} title="Turn fast refresh back on?" description={FORCE_SENTENCE} returnFocusRef={returnRef}>
          <div className="flex flex-col gap-3">
            <Button variant="primary" onClick={() => void reenable(pending.item)} data-testid="reenable-confirm">
              Turn it on and pull fresh
            </Button>
            <Button onClick={() => setPending(null)}>Not now</Button>
          </div>
        </Sheet>
      )}
      {pending?.kind === "remove" && (
        <Sheet
          open
          onOpenChange={(o) => !o && setPending(null)}
          title={`Remove ${pending.item.institutionName ?? "this bank"}?`}
          description="Your history stays: every transaction already pulled in is kept. New ones stop arriving."
          returnFocusRef={returnRef}
        >
          <div className="flex flex-col gap-3" data-testid="remove-sheet">
            {itemStatus(pending.item).kind === "reconnect" && (
              <p className="type-body text-ink-2">
                This bank only needs you to sign in again. Reconnecting keeps its place in line; removing it and linking again starts the pull from scratch.
              </p>
            )}
            {itemStatus(pending.item).kind === "reconnect" && (
              <Button
                variant="primary"
                onClick={() => {
                  const it = pending.item;
                  setPending(null);
                  link.reconnect(it);
                }}
              >
                Reconnect instead
              </Button>
            )}
            <Button variant="danger" disabled={del.isPending} onClick={() => remove(pending.item)} data-testid="remove-confirm">
              Remove {pending.item.institutionName ?? "bank"}
            </Button>
            <Button onClick={() => setPending(null)}>Keep it</Button>
          </div>
        </Sheet>
      )}
      {link.overlays}
      {toast}
    </HouseholdFrame>
  );
}
