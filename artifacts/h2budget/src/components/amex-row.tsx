import { useEffect, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { ChevronDown } from "lucide-react";
import type { Transaction } from "@workspace/api-client-react";
import { AccountTransactionRow } from "@/components/account-page/transaction-row";
import { amexLedgerGrid, type AmexRowMode } from "@/components/account-page/ledger-grid";
import { CategoryPicker } from "@/components/category-picker";
import { BucketBubbles, type BucketKey } from "@/components/bucket-bubbles";
import { MerchantRenamePopover } from "@/components/merchant-rename-popover";
import { ExpiredHoldLabel } from "@/components/expired-hold-label";
import { shiftISODate } from "@/components/row-date-controls";
import { provenanceWords, rowStatuses, type CategoryProvenance } from "@/lib/amexRowWords";
import type { AccountAccentName } from "@/lib/accountIdentity";
import { cn } from "@/lib/utils";

/**
 * ⭐ (P1) ONE CALM AMEX ROW, phone and desktop alike. The shared ledger row
 * (`AccountTransactionRow`, Chase's too) with the Amex slots filled:
 *
 *   Review (the default): merchant · statuses only when they apply · card (All
 *   cards) · category (still one click) · spending in words · signed amount.
 *   Categorize: the same row with the four bucket marks in place of the words.
 *
 * Everything else a row can do lives in its Details, opened in place under the
 * row (a disclosure, not a dialog): rename and split, where the category came
 * from, the buckets in words, the transfer and card-payment flags, the date,
 * and Mark reviewed. Every control calls a handler the page already had; no
 * write here is new.
 */

export function amexDetailsId(id: string): string {
  return `amex-row-details-${id}`;
}

/** The statuses beside the merchant: an expired hold first, then the chips, then a quiet "Reviewed". */
function RowStatusLine({ t, ignored }: { t: Transaction; ignored: boolean }) {
  const chips = rowStatuses(t, ignored);
  return (
    <>
      {t.expiredHold ? <ExpiredHoldLabel id={t.id} /> : null}
      {chips.map((c) => (
        <span key={c.key} className="chip gray shrink-0" data-testid={c.testId} title={c.title}>
          {c.label}
        </span>
      ))}
      {t.reviewed ? (
        <span className="shrink-0 text-micro text-neutral-600" data-testid={`chip-state-${t.id}`}>
          Reviewed
        </span>
      ) : null}
    </>
  );
}

export function AmexLedgerRow({
  t,
  mode,
  showCard,
  cardLabel,
  cardAccent,
  selected,
  onToggleSelect,
  categories,
  onCategoryChange,
  onBucketToggle,
  ignored,
  spending,
  amountNode,
  detailsOpen,
  onToggleDetails,
  toggleRef,
  details,
  disabled,
}: {
  t: Transaction;
  mode: AmexRowMode;
  showCard: boolean;
  cardLabel: string | null;
  cardAccent: AccountAccentName | null;
  selected: boolean;
  onToggleSelect: () => void;
  categories: { id: string; name: string }[] | undefined;
  onCategoryChange: (id: string | null, rememberPattern?: string | null) => void;
  onBucketToggle: (bucket: BucketKey, next: boolean) => void;
  ignored: boolean;
  /** `spendingWords` for this row ("" when the row's label already says it). */
  spending: string;
  amountNode: ReactNode;
  detailsOpen: boolean;
  onToggleDetails: () => void;
  /** The page keeps each open row's toggle, to give focus back when its details close. */
  toggleRef?: (el: HTMLButtonElement | null) => void;
  /** The row's details, drawn under it while open. */
  details: ReactNode;
  disabled?: boolean;
}) {
  const merchant = t.displayName || t.description;
  const review = mode === "review";
  return (
    <AccountTransactionRow
      tx={t}
      selected={selected}
      onToggleSelect={onToggleSelect}
      categories={categories}
      onCategoryChange={onCategoryChange}
      onBucketToggle={onBucketToggle}
      onQuickDate={() => undefined}
      // The date moves live in the row's details: no row menu.
      hideDate
      hideRename
      disabled={disabled}
      testId={`row-amex-${t.id}`}
      rowData={{
        "data-reviewed": t.reviewed ? "true" : "false",
        "data-ignored": ignored ? "true" : "false",
        "data-details": detailsOpen ? "open" : "closed",
      }}
      showCard={showCard}
      cardWrap
      cardLabel={cardLabel}
      cardAccent={cardAccent}
      wrapIndent
      gridClass={amexLedgerGrid(mode, showCard)}
      statusNode={<RowStatusLine t={t} ignored={ignored} />}
      metaNode={
        t.notes ? (
          <div className="min-w-0 basis-full truncate text-micro text-neutral-600" title={t.notes}>
            {t.notes}
          </div>
        ) : null
      }
      categoryNode={
        <CategoryPicker
          value={t.categoryId ?? null}
          categories={categories}
          description={t.description}
          onChange={onCategoryChange}
          // Review: a quiet trigger (the name, a hairline on hover) — still one click.
          triggerClassName={cn(
            "@6xl:w-full",
            review && "w-auto max-w-52 border-transparent bg-transparent px-2 shadow-none hover:border-brand-line",
          )}
        />
      }
      bucketsNode={
        review ? (
          spending ? (
            <span className="text-label text-neutral-700" data-testid={`spending-${t.id}`}>
              <span className="sr-only">Spending: </span>
              {spending}
            </span>
          ) : null
        ) : !t.isTransfer ? (
          <BucketBubbles
            flags={{
              weekly: t.weeklyAllowance,
              monthly: t.monthlyAllowance,
              unplanned: t.unplannedAllowance,
              reimbursable: t.reimbursable,
            }}
            onToggle={onBucketToggle}
          />
        ) : null
      }
      amountNode={amountNode}
      actionsNode={
        <button
          type="button"
          ref={toggleRef}
          aria-expanded={detailsOpen}
          aria-controls={amexDetailsId(t.id)}
          aria-label={`Details for ${merchant}`}
          title="Details"
          onClick={onToggleDetails}
          data-testid={`button-row-details-${t.id}`}
          className={cn(
            "press inline-flex size-10 items-center justify-center rounded-control text-neutral-600 hover:bg-platinum-2 hover:text-brand-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40 @6xl:size-8",
            detailsOpen && "bg-platinum-2 text-brand-navy",
          )}
        >
          <ChevronDown className={cn("size-4 transition-transform", detailsOpen && "rotate-180")} aria-hidden />
        </button>
      }
      belowNode={detailsOpen ? details : null}
    />
  );
}

const SECTION = "min-w-0 space-y-1";
const LABEL = "text-micro font-semibold text-neutral-600";
const ACTION =
  "press inline-flex min-h-8 items-center rounded-control px-2 text-label font-semibold text-brand-navy ring-1 ring-brand-line hover:bg-platinum-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40 disabled:pointer-events-none disabled:opacity-50";

/**
 * A row's details, in place under it. Escape inside closes it and gives focus
 * back to the row's Details button — but only when the key was pressed INSIDE
 * this region: an Escape that closes a popover opened from here (portaled,
 * outside the region) must not close the details too.
 */
export function AmexRowDetails({
  t,
  mode,
  cardLabel,
  categoryName,
  provenance,
  ignored,
  onBucketToggle,
  onClearTransfer,
  onSetExternal,
  onQuickDate,
  onSetReviewed,
  onSplit,
  onClose,
  disabled,
}: {
  t: Transaction;
  mode: AmexRowMode;
  /** The card's household name ••last4 (shown on one card's page too). */
  cardLabel: string | null;
  /** The category's name, or null with none. */
  categoryName: string | null;
  provenance: CategoryProvenance;
  ignored: boolean;
  onBucketToggle: (bucket: BucketKey, next: boolean) => void;
  onClearTransfer: () => void;
  onSetExternal: (next: boolean) => void;
  onQuickDate: (raw: string) => Promise<boolean>;
  onSetReviewed: (next: boolean) => void;
  onSplit: () => void;
  /** Close the details; the page gives focus back to the row's Details button. */
  onClose: () => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(t.occurredOn.slice(0, 10));
  useEffect(() => setDraft(t.occurredOn.slice(0, 10)), [t.occurredOn]);
  const merchant = t.displayName || t.description;
  const review = mode === "review";
  const id = amexDetailsId(t.id);
  return (
    <div
      id={id}
      role="region"
      aria-label={`Details for ${merchant}`}
      data-testid={id}
      className="my-1 grid gap-x-6 gap-y-3 rounded-card bg-platinum-1 p-3 ring-1 ring-brand-line sm:grid-cols-2 @6xl:ml-7"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        if (!(e.currentTarget as HTMLElement).contains(e.target as Node)) return;
        e.stopPropagation();
        onClose();
      }}
    >
      <section className={SECTION} aria-label="Merchant">
        <div className={LABEL}>Merchant</div>
        <p className="text-body text-brand-ink [overflow-wrap:anywhere]">{merchant}</p>
        {t.displayName && t.displayName !== t.description ? (
          <p className="text-micro text-neutral-600 [overflow-wrap:anywhere]">Bank: {t.description}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <MerchantRenamePopover tx={t} triggerLabel="Rename merchant…" />
          <button type="button" className={ACTION} onClick={onSplit} data-testid={`split-category-${t.id}`}>
            Split by category…
          </button>
        </div>
      </section>

      <section className={SECTION} aria-label="Category">
        <div className={LABEL}>Category</div>
        <p className="text-body text-brand-ink">{categoryName ?? "None"}</p>
        <p className="text-label text-neutral-600">
          {provenance.kind === "rule" ? (
            <>
              {provenanceWords(provenance)}{" "}
              <Link
                href={`/mapping-rules?focus=${encodeURIComponent(provenance.ruleId)}`}
                className="font-semibold text-brand-navy underline"
                data-testid={`link-matched-rule-amex-${t.id}`}
              >
                Open rule
              </Link>
            </>
          ) : (
            <span data-testid={provenance.kind === "no_rule" ? `text-no-rule-amex-${t.id}` : undefined}>
              {provenanceWords(provenance)}
            </span>
          )}
        </p>
      </section>

      <section className={SECTION} aria-label="Spending">
        <div className={LABEL}>Spending</div>
        {t.expiredHold ? (
          <p className="text-label text-neutral-600">
            Still pending more than 7 days after its date. Not counted anywhere. If it posts, the posted charge counts.
          </p>
        ) : t.isTransfer ? (
          <div className="space-y-1">
            <p className="text-label text-brand-ink">Transfer: not counted as spending.</p>
            {t.isTransferUserOverridden ? <p className="text-micro text-neutral-600">Set by hand. The next sync keeps it.</p> : null}
            <button type="button" className={ACTION} onClick={onClearTransfer} disabled={disabled} data-testid={`button-clear-transfer-${t.id}`}>
              Count as spending
            </button>
          </div>
        ) : (
          <div className="space-y-1">
            {review ? (
              <>
                <BucketBubbles
                  wordy
                  flags={{
                    weekly: t.weeklyAllowance,
                    monthly: t.monthlyAllowance,
                    unplanned: t.unplannedAllowance,
                    reimbursable: t.reimbursable,
                  }}
                  onToggle={onBucketToggle}
                />
                <p className="text-micro text-neutral-600">Choosing one marks the row reviewed.</p>
              </>
            ) : (
              <p className="text-label text-neutral-600">Set in the row.</p>
            )}
            {ignored ? <p className="text-micro text-neutral-600">In Ignore: left out of budgets and reports.</p> : null}
            {t.isTransferUserOverridden ? (
              <p className="text-micro text-neutral-600" data-testid={`badge-transfer-overridden-cleared-${t.id}`}>
                Counted as spending by hand. The next sync keeps it.
              </p>
            ) : null}
          </div>
        )}
      </section>

      {t.isExternalCardPayment || t.isTransfer ? (
        <section className={SECTION} aria-label="Card payment">
          <div className={LABEL}>Card payment</div>
          {t.isExternalCardPayment ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-label text-brand-ink">Paid to a card outside the debt plan.</span>
              <button type="button" className={ACTION} onClick={() => onSetExternal(false)} disabled={disabled} data-testid={`button-clear-external-card-${t.id}`}>
                Clear
              </button>
            </div>
          ) : (
            <button type="button" className={ACTION} onClick={() => onSetExternal(true)} disabled={disabled} data-testid={`button-mark-external-card-${t.id}`}>
              Paid to a card outside the debt plan
            </button>
          )}
        </section>
      ) : null}

      <section className={SECTION} aria-label="Date">
        <div className={LABEL}>Date</div>
        {t.pending ? (
          <p className="text-label text-neutral-600" data-testid={`text-pending-date-${t.id}`}>
            The bank sets the date when it posts.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={ACTION}
              disabled={disabled}
              onClick={() => void onQuickDate(shiftISODate(t.occurredOn, -1))}
              data-testid={`button-bump-date-back-${t.id}`}
            >
              Move back 1 day
            </button>
            <input
              type="date"
              aria-label={`Date for ${merchant}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void onQuickDate(draft);
                }
              }}
              className="min-h-8 rounded-control bg-white px-2 text-label ring-1 ring-brand-line focus:outline-none focus:ring-2 focus:ring-brand-navy"
              data-testid={`input-inline-date-${t.id}`}
            />
            <button
              type="button"
              className={ACTION}
              disabled={disabled || draft === t.occurredOn.slice(0, 10)}
              onClick={() => void onQuickDate(draft)}
              data-testid={`button-save-inline-date-${t.id}`}
            >
              Save
            </button>
          </div>
        )}
      </section>

      <section className={SECTION} aria-label="Review">
        <div className={LABEL}>Review</div>
        <button
          type="button"
          className={ACTION}
          onClick={() => onSetReviewed(!t.reviewed)}
          disabled={disabled}
          data-testid={`button-row-reviewed-${t.id}`}
        >
          {t.reviewed ? "Mark not reviewed" : "Mark reviewed"}
        </button>
      </section>

      {cardLabel || t.notes || t.owedBy ? (
        <section className={cn(SECTION, "sm:col-span-2")} aria-label="Also">
          <dl className="grid gap-x-4 gap-y-1 text-label sm:grid-cols-[auto_minmax(0,1fr)]">
            {cardLabel ? (
              <>
                <dt className="text-neutral-600">Card</dt>
                <dd className="text-brand-ink [overflow-wrap:anywhere]" data-testid={`details-card-${t.id}`}>{cardLabel}</dd>
              </>
            ) : null}
            {t.notes ? (
              <>
                <dt className="text-neutral-600">Notes</dt>
                <dd className="whitespace-pre-wrap text-brand-ink [overflow-wrap:anywhere]">{t.notes}</dd>
              </>
            ) : null}
            {t.owedBy ? (
              <>
                <dt className="text-neutral-600">Owed by</dt>
                <dd className="text-brand-ink">{t.owedBy}</dd>
              </>
            ) : null}
          </dl>
        </section>
      ) : null}

      <div className="sm:col-span-2">
        <button
          type="button"
          className="press inline-flex min-h-8 items-center rounded-control bg-brand-navy px-3 text-label font-semibold text-white hover:bg-brand-navy/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-navy/40"
          onClick={onClose}
          data-testid={`button-row-details-done-${t.id}`}
        >
          Done
        </button>
      </div>
    </div>
  );
}
