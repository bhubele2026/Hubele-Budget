// ⭐ (Q2) A PROPOSED FIX, READ AS IF IT WERE WRITTEN — the dry run's overlay.
//
// `POST /review/proposals/:key/apply?dryRun=1` shows the owner what a fix does
// to his figures before he confirms it. Nothing is written and nothing is
// rolled back: the loaders that read the rows and the confirmed matches take
// this overlay (the `planOverride` pattern of the plan dialog) and read each
// patched row with the fields the fix would write, the confirmed matches with
// the resolutions it would add and without the ones it would delete. The fix
// builds the overlay from the SAME plan it writes (`reviewCorrections.ts`), so
// the dry run's "after" and the figures once applied come from one plan.
//
// Readers that honour it: `loadMovementRows`, `loadConfirmedMatchRows`,
// `loadMoneyContext`, `loadAllowanceWindow` (moneyContext.ts), the money
// position's week, the period breakdown, and the Budget month — and (Q1, the
// Q2 follow-up) the forecast ledger (`buildForecastLedger`'s
// `correctionOverlay`: the stored answers less `removedResolutionIds` plus
// `addMatched`; the actual, candidate and card rows patched; the hooks'
// allowance window), built on its own by `computeCashSignalWithOverlay`, and
// the Banking review (`buildBankingReview`'s `overlay`: rows, answers, money
// context, position — on that overlay ledger).
//
// ⚠️ Pure and read-only. It must never import a writer: the money position
// reads it, and the agent's import closure reaches the money position.

import type { SupersededPending } from "./supersededPending";

/** The columns a fix writes on a transaction row (a hand category pick's write). */
export interface CorrectionRowPatch {
  categoryId?: string | null;
  categoryLockedByUser?: boolean;
  categoryProvisional?: boolean;
  isTransfer?: boolean;
  isTransferUserOverridden?: boolean;
  weeklyAllowance?: boolean;
  monthlyAllowance?: boolean;
  unplannedAllowance?: boolean;
}

export interface CorrectionOverlay {
  /** Transaction id → the columns the fix writes on it. */
  rows: ReadonlyMap<string, CorrectionRowPatch>;
  /**
   * The `matched` resolutions the fix inserts: the bank row and its own date,
   * and the occurrence it answers (what a ledger built with the overlay would
   * add to the household's answers).
   */
  addMatched: ReadonlyArray<{ txnId: string; occurredOn: string; recurringItemId: string; occurrenceDate: string }>;
  /** The resolutions the fix deletes (its neighbours), by id. */
  removedResolutionIds: ReadonlySet<string>;
  /**
   * The plan occurrences (`<itemId>|<occurrenceDate>`) the fix answers. The
   * forecast never pairs another row with an answered occurrence, so the dry run
   * drops the ledger's pairs and suggestions that name one (`tier2PairedAfter`,
   * `suggestionsAfter`).
   */
  resolvedPlanKeys: ReadonlySet<string>;
}

const PATCH_KEYS: ReadonlyArray<keyof CorrectionRowPatch> = [
  "categoryId",
  "categoryLockedByUser",
  "categoryProvisional",
  "isTransfer",
  "isTransferUserOverridden",
  "weeklyAllowance",
  "monthlyAllowance",
  "unplannedAllowance",
];

/**
 * The row as the fix would leave it. Only the columns the reader selected are
 * patched (a reader that never reads `categoryProvisional` gets none added), so
 * the patched row has exactly the reader's own shape.
 */
export function patchRow<T extends { id: string }>(row: T, overlay: CorrectionOverlay | null | undefined): T {
  const patch = overlay?.rows.get(row.id);
  if (!patch) return row;
  const out = { ...row } as Record<string, unknown>;
  for (const k of PATCH_KEYS) {
    if (patch[k] !== undefined && k in out) out[k] = patch[k];
  }
  return out as T;
}

export function patchRows<T extends { id: string }>(rows: T[], overlay: CorrectionOverlay | null | undefined): T[] {
  if (!overlay || overlay.rows.size === 0) return rows;
  return rows.map((r) => patchRow(r, overlay));
}

/**
 * The pending pairs with each replaced pending row's FILING as the fix would
 * leave it (a posted row takes its filing from there where it has none of its
 * own). Which row replaced which never changes: a fix moves no amount or date.
 */
export function patchSupersede<S extends Pick<SupersededPending, "replacedBy">>(
  supersede: S,
  overlay: CorrectionOverlay | null | undefined,
): S {
  if (!overlay || overlay.rows.size === 0) return supersede;
  let touched = false;
  const replacedBy = new Map(supersede.replacedBy);
  for (const [postedId, pending] of supersede.replacedBy) {
    if (!overlay.rows.has(pending.id)) continue;
    touched = true;
    const { id: _id, ...filing } = patchRow({ id: pending.id, ...pending.filing }, overlay);
    void _id;
    replacedBy.set(postedId, { ...pending, filing });
  }
  if (!touched) return supersede;
  return { ...supersede, replacedBy };
}

/**
 * (Q2) The forecast's tier-2 off-curve pairs as the dry run reads them: the
 * ledger's (`tier2PairedTxnIdsOf`'s rule) less any pair with an occurrence the
 * fix answers, or on a row it confirms. The ledger itself is not rebuilt: a row
 * the fix frees may be paired elsewhere once it is written (a stated limitation).
 */
export function tier2PairedAfter(
  matches: ReadonlyArray<{ tier: number; offCurve: boolean; txnId: string; planKey: string }>,
  overlay: CorrectionOverlay,
): Set<string> {
  const confirmed = new Set(overlay.addMatched.map((m) => m.txnId));
  return new Set(
    matches
      .filter((m) => m.tier === 2 && m.offCurve && !overlay.resolvedPlanKeys.has(m.planKey) && !confirmed.has(m.txnId))
      .map((m) => m.txnId),
  );
}

/** (Q2) The ledger's bill suggestions as the dry run reads them: none for an occurrence the fix answers, or a row it confirms. */
export function suggestionsAfter<V extends { planKey: string }>(
  suggestions: ReadonlyMap<string, V>,
  overlay: CorrectionOverlay | null | undefined,
): ReadonlyMap<string, V> {
  if (!overlay) return suggestions;
  const confirmed = new Set(overlay.addMatched.map((m) => m.txnId));
  const out = new Map<string, V>();
  for (const [txnId, s] of suggestions) {
    if (!overlay.resolvedPlanKeys.has(s.planKey) && !confirmed.has(txnId)) out.set(txnId, s);
  }
  return out;
}
