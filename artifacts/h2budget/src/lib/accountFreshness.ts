import { shortDate, shortDateOfInstant } from "./dates";

/**
 * ⭐ ACCOUNT FRESHNESS — three stamps, three different moments, never one word
 * standing in for another.
 *
 *   - "synced <t>"        the bank feed's last successful sync (`lastSyncedAt`)
 *   - "balance read <t>"  when the balance on screen was read (a depository
 *                          snapshot's `at`, a card's creditor as-of)
 *   - "data through <d>"  the newest bank transaction H2 holds (`lastBankTxOn`)
 *
 * (WP3) The dashboard used to print "data through <the sync day>": a sync
 * that brings nothing new still moved it, so the label claimed data the app
 * did not have. Each stamp is drawn only when its moment is known.
 */

/** "2 h ago", "3 d ago": short enough for a one-line freshness strip. */
export function agoShort(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const min = Math.floor(Math.max(0, now - t) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/** "Oct 7" for a YYYY-MM-DD day, or for an instant read on the household calendar. */
export function dayOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? shortDate(iso) : shortDateOfInstant(iso)) || null;
}

export interface FreshnessInput {
  syncedAt?: string | null;
  balanceAt?: string | null;
  dataThrough?: string | null;
}

/** The stamps that are known, in the order above. Pure. */
export function freshnessStamps(f: FreshnessInput, now: number): string[] {
  const out: string[] = [];
  const s = agoShort(f.syncedAt, now);
  if (s) out.push(`synced ${s}`);
  const b = agoShort(f.balanceAt, now);
  if (b) out.push(`balance read ${b}`);
  const d = dayOf(f.dataThrough);
  if (d) out.push(`data through ${d}`);
  return out;
}
