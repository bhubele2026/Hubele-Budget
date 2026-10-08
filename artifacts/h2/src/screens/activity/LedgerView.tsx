import { useEffect, useMemo, useState } from "react";
import { useSearch } from "wouter";
import { MoreHorizontal } from "lucide-react";
import { useGetTransactionSplits, getGetTransactionSplitsQueryKey, type Category } from "@workspace/api-client-react";
import type { LedgerRow as LedgerRowData } from "@workspace/api-client-react/ledger";
import { householdToday } from "@workspace/avalanche-core/householdTime";
import {
  DEFAULT_FILTERS,
  ledgerParams,
  useCategoryList,
  useLedger,
  usePlaidAccounts,
  type LedgerFilters,
  type RangeKey,
} from "@/data/activityData";
import { Button } from "@/kit/Button";
import { CategoryChip } from "@/kit/CategoryChip";
import { LedgerRow } from "@/kit/LedgerRow";
import { Note, RefreshNote } from "@/kit/Note";
import { Segmented } from "@/kit/Segmented";
import { SkeletonLine } from "@/kit/Skeleton";
import { toAmount } from "@/lib/money";
import { CategoryPickerSheet } from "./CategoryPickerSheet";
import { RowSheet } from "./RowSheet";
import { SplitSheet } from "./SplitSheet";
import { AgentTrail } from "./AgentTrail";
import { isProvisional, useFiling, type RowExtras } from "./useFiling";
import { dayHeader } from "./words";

const RANGES = [
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
  { key: "last-month", label: "Last month" },
  { key: "custom", label: "Custom" },
] as const satisfies readonly { key: RangeKey; label: string }[];

const FILING = [
  { key: "all", label: "All charges" },
  { key: "unfiled", label: "Needs filing" },
] as const;

/** A value that follows `value` after it has stood still for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [out, setOut] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setOut(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return out;
}

function SplitParts({ id, names }: { id: string; names: Map<string, string> }) {
  const q = useGetTransactionSplits(id, {
    query: { queryKey: getGetTransactionSplitsQueryKey(id), staleTime: 60_000, gcTime: 5 * 60_000 },
  });
  if (!q.data) return <p className="mt-2 type-caption text-ink-3">Loading the parts…</p>;
  return (
    <ul className="mt-2 border-l border-rule pl-3" data-testid="split-parts">
      {q.data.splits.map((s) => (
        <li key={s.id} className="flex items-baseline justify-between gap-4 py-1 type-caption text-ink-2">
          <span>{names.get(s.categoryId) ?? "Unknown category"}</span>
          <span className="tnum">{s.amount}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * ⭐ THE LEDGER — every charge, newest day first. Search, a range, an account
 * and "needs filing" all go to the server as filters (never a 1,000-row pull);
 * rows come 50 a page with Load more. The category chip files a charge in two
 * taps and H2 remembers it.
 */
export function LedgerView({ now }: { now?: Date }) {
  const today = householdToday(now);
  const asked = useSearch();
  const [filters, setFilters] = useState<LedgerFilters>(() => ({
    ...DEFAULT_FILTERS,
    unfiled: new URLSearchParams(asked).get("unfiled") === "1",
  }));
  const [typed, setTyped] = useState("");
  const search = useDebounced(typed, 250);
  const ledger = useLedger(ledgerParams({ ...filters, search }, today));
  const categories = useCategoryList();
  const { accounts, byId } = usePlaidAccounts();
  const file = useFiling();

  const [picking, setPicking] = useState<LedgerRowData | null>(null);
  const [menu, setMenu] = useState<LedgerRowData | null>(null);
  const [splitting, setSplitting] = useState<LedgerRowData | null>(null);
  const [splitCounts, setSplitCounts] = useState<Map<string, number>>(() => new Map());
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const cats: readonly Category[] = categories.data ?? [];
  const names = useMemo(() => new Map(cats.map((c) => [c.id, c.name] as const)), [cats]);
  const rows = useMemo(() => ledger.rows.filter((r) => r.countsInBalance !== false), [ledger.rows]);
  const groups = useMemo(() => {
    const out: { day: string; rows: LedgerRowData[] }[] = [];
    for (const r of rows) {
      const last = out[out.length - 1];
      if (last && last.day === r.occurredOn) last.rows.push(r);
      else out.push({ day: r.occurredOn, rows: [r] });
    }
    return out;
  }, [rows]);

  const set = (patch: Partial<LedgerFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const accountLabel = (r: LedgerRowData): string | null => {
    const a = r.plaidAccountId ? byId.get(r.plaidAccountId) : undefined;
    return a ? `${a.name ?? "Account"}${a.mask ? ` ••${a.mask}` : ""}` : null;
  };
  const splitN = (r: LedgerRowData) => splitCounts.get(r.id) ?? (r as LedgerRowData & RowExtras).splitCount ?? 0;

  const cold = ledger.state === "cold";
  const count = ledger.first?.matchingCount;

  return (
    <div className="flex flex-col" data-testid="ledger">
      <div className="flex flex-col gap-3 pb-4">
        <label className="sr-only" htmlFor="ledger-search">
          Search charges
        </label>
        <input
          id="ledger-search"
          type="search"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="Search charges"
          className="h-10 w-full rounded-1 border border-rule-strong bg-paper-0 px-3 type-body text-ink"
          data-testid="ledger-search"
        />
        <div className="flex flex-wrap items-center gap-3">
          <Segmented label="Range" options={RANGES} value={filters.range} onChange={(range) => set({ range })} data-testid="range" />
          <Segmented
            label="Show"
            options={FILING}
            value={filters.unfiled ? "unfiled" : "all"}
            onChange={(k) => set({ unfiled: k === "unfiled" })}
            data-testid="filing-filter"
          />
        </div>
        {filters.range === "custom" && (
          <div className="flex flex-wrap items-center gap-3" data-testid="custom-range">
            <label className="flex items-center gap-2 type-label text-ink-2">
              From
              <input
                type="date"
                value={filters.from}
                max={today}
                onChange={(e) => set({ from: e.target.value })}
                className="h-9 rounded-1 border border-rule-strong bg-paper-0 px-2 type-body text-ink"
              />
            </label>
            <label className="flex items-center gap-2 type-label text-ink-2">
              To
              <input
                type="date"
                value={filters.to}
                max={today}
                onChange={(e) => set({ to: e.target.value })}
                className="h-9 rounded-1 border border-rule-strong bg-paper-0 px-2 type-body text-ink"
              />
            </label>
          </div>
        )}
        {accounts.length > 1 && (
          <label className="flex items-center gap-2 type-label text-ink-2">
            Account
            <select
              value={filters.account ?? ""}
              onChange={(e) => set({ account: e.target.value || null })}
              className="h-9 rounded-1 border border-rule-strong bg-paper-0 px-2 type-body text-ink"
              data-testid="account-filter"
            >
              <option value="">Main account</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name ?? "Account"}
                  {a.mask ? ` ••${a.mask}` : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        {count != null && !cold && (
          <p className="type-caption text-ink-3" data-testid="ledger-count">
            <span className="tnum">{count}</span> {count === 1 ? "charge" : "charges"}
          </p>
        )}
      </div>

      <RefreshNote state={ledger.state} updatedAt={ledger.updatedAt} onRetry={ledger.refetch} retrying={ledger.isFetching} now={now} />

      {cold ? (
        <div className="flex flex-col gap-4 py-2" data-testid="ledger-skeleton" aria-busy="true">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <SkeletonLine key={i} className={i % 2 ? "w-64" : "w-80"} />
          ))}
        </div>
      ) : ledger.state === "failed" ? null : groups.length === 0 ? (
        <Note kind="empty" data-testid="ledger-empty">
          {filters.unfiled
            ? "Nothing needs filing in this range."
            : search.trim()
              ? "No charges match that search."
              : "No charges in this range."}
        </Note>
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((g) => (
            <section key={g.day} aria-label={dayHeader(g.day, today)} data-testid="day-group">
              <h2 className="mb-1 border-b border-rule pb-1 type-section text-ink-2">{dayHeader(g.day, today)}</h2>
              <ul data-testid="ledger-rows">
                {g.rows.map((r) => {
                  const name = r.displayName || r.description;
                  const n = splitN(r);
                  const open = expanded.has(r.id);
                  const a = r.plaidAccountId ? byId.get(r.plaidAccountId) : undefined;
                  return (
                    <LedgerRow
                      key={r.id}
                      data-testid="ledger-row"
                      name={name}
                      amount={toAmount(r.amount)}
                      pending={r.pending}
                      mask={a?.mask ?? null}
                      chip={
                        <CategoryChip
                          name={r.categoryId ? (names.get(r.categoryId) ?? null) : null}
                          provisional={isProvisional(r)}
                          label={`Change category for ${name}`}
                          onPress={() => setPicking(r)}
                        />
                      }
                      trailing={
                        <button
                          type="button"
                          aria-label={`More for ${name}`}
                          onClick={() => setMenu(r)}
                          className="-mr-2 flex size-8 items-center justify-center rounded-1 text-ink-2 hover:bg-paper-1"
                          data-testid="row-menu"
                        >
                          <MoreHorizontal size={16} strokeWidth={1.75} aria-hidden />
                        </button>
                      }
                      below={
                        n > 0 ? (
                          <div className="mt-1">
                            <button
                              type="button"
                              aria-expanded={open}
                              onClick={() =>
                                setExpanded((s) => {
                                  const next = new Set(s);
                                  if (next.has(r.id)) next.delete(r.id);
                                  else next.add(r.id);
                                  return next;
                                })
                              }
                              className="type-caption text-moss underline decoration-1 underline-offset-4"
                              data-testid="split-badge"
                            >
                              split ×{n}
                            </button>
                            {open && <SplitParts id={r.id} names={names} />}
                          </div>
                        ) : undefined
                      }
                    />
                  );
                })}
              </ul>
            </section>
          ))}
          {ledger.hasNextPage && (
            <div className="flex items-center gap-4">
              <Button variant="quiet" onClick={ledger.fetchNextPage} disabled={ledger.isFetchingNextPage} data-testid="load-more">
                {ledger.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
              {count != null && (
                <span className="type-caption text-ink-3">
                  Showing <span className="tnum">{rows.length}</span> of <span className="tnum">{count}</span>
                </span>
              )}
            </div>
          )}
        </div>
      )}

      <CategoryPickerSheet
        open={picking != null}
        onOpenChange={(o) => !o && setPicking(null)}
        categories={cats}
        currentId={picking?.categoryId}
        title="File under"
        description={picking ? (picking.displayName || picking.description) : undefined}
        onPick={(c) => {
          const row = picking;
          setPicking(null);
          if (row) void file(row, c);
        }}
      />
      {menu && (
        <RowSheet
          row={menu}
          categories={cats}
          accountLabel={accountLabel(menu)}
          open
          onOpenChange={(o) => !o && setMenu(null)}
          onSplit={() => {
            setSplitting(menu);
            setMenu(null);
          }}
        />
      )}
      {splitting && (
        <SplitSheet
          key={splitting.id}
          row={splitting}
          categories={cats}
          open
          onOpenChange={(o) => !o && setSplitting(null)}
          onSaved={(id, parts) => setSplitCounts((m) => new Map(m).set(id, parts))}
        />
      )}
    </div>
  );
}

/** The trail sits above the ledger, on the same screen. */
export function LedgerPage({ now }: { now?: Date }) {
  return (
    <>
      <AgentTrail now={now} />
      <LedgerView now={now} />
    </>
  );
}
