import { useMemo, useState, type ReactNode } from "react";
import { Wand2, X } from "lucide-react";
import type { Transaction } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  BucketBubbles,
  type BucketKey,
} from "@/components/bucket-bubbles";

export type TxRowCategory = { id: string; name: string };

// (#742) Keyword → list of category-name substrings to surface as suggestions
// when a transaction is uncategorized. The first existing category whose name
// matches any of the substrings (case-insensitive) wins. Designed to cover the
// debt-bearing April Chase rows (Synchrony, Chase autopay, Upstart, Dept of
// Education) plus a handful of common merchants. Lives alongside
// `CategorizeChip` because that's the only consumer.
const SUGGESTION_RULES: { match: string[]; targets: string[] }[] = [
  { match: ["synchrony"], targets: ["Synchrony", "Ashley", "Mattress", "PayPal Credit", "Misc / Buffer"] },
  { match: ["upstart"], targets: ["Upstart", "Misc / Buffer"] },
  { match: ["chase credit", "chase autopay"], targets: ["Chase Sapphire", "Chase Freedom", "Chase", "Misc / Buffer"] },
  { match: ["dept education", "dept of ed", "nelnet"], targets: ["Student Loan", "Nelnet", "Dept of Ed", "Misc / Buffer"] },
  { match: ["intuit"], targets: ["Intuit", "Misc / Buffer"] },
  { match: ["affirm"], targets: ["Affirm", "Misc / Buffer"] },
  { match: ["american express", "amex"], targets: ["American Express", "Amex", "Misc / Buffer"] },
  { match: ["discover"], targets: ["Discover", "Misc / Buffer"] },
  { match: ["capital one"], targets: ["Capital One", "Misc / Buffer"] },
  { match: ["paymthly", "pypl paymthly", "paypal credit"], targets: ["PayPal Credit", "Synchrony", "Misc / Buffer"] },
  { match: ["applecard", "apple card"], targets: ["Apple Card", "Misc / Buffer"] },
  { match: ["credit one"], targets: ["Credit One", "Misc / Buffer"] },
  { match: ["figure"], targets: ["Figure", "HELOC", "Misc / Buffer"] },
  { match: ["uw credit union"], targets: ["Hannah", "Car Payments", "Misc / Buffer"] },
  { match: ["toyota"], targets: ["Toyota", "Car Payments"] },
  { match: ["lakeview"], targets: ["Mortgage", "Lakeview"] },
  { match: ["madison gas", "city of madison"], targets: ["Utilities", "MGE"] },
  { match: ["verizon"], targets: ["Phone", "Utilities", "Verizon"] },
  { match: ["state farm"], targets: ["Insurance", "State Farm"] },
  { match: ["trustage"], targets: ["Insurance", "TruStage"] },
  { match: ["metro market", "costco", "walmart"], targets: ["Groceries", "Shopping"] },
  { match: ["kwik trip"], targets: ["Gas", "Transportation"] },
  { match: ["starbucks", "dunkin", "doordash", "mooyah"], targets: ["Dining", "Coffee", "Restaurants"] },
  { match: ["paypal purchase", "stitchfix", "aldo", "shen zhen", "brghtwhl"], targets: ["Shopping"] },
  { match: ["paramount", "adobe", "ancestry", "playstation", "nintendo"], targets: ["Subscriptions"] },
];

function suggestCategories(
  description: string,
  categories: TxRowCategory[],
): TxRowCategory[] {
  const hay = (description ?? "").toLowerCase();
  const out: TxRowCategory[] = [];
  const seen = new Set<string>();
  for (const rule of SUGGESTION_RULES) {
    if (!rule.match.some((m) => hay.includes(m))) continue;
    for (const target of rule.targets) {
      const needle = target.toLowerCase();
      const hit = categories.find(
        (c) => c.name.toLowerCase().includes(needle) && !seen.has(c.id),
      );
      if (hit) {
        out.push(hit);
        seen.add(hit.id);
        if (out.length >= 3) return out;
      }
    }
  }
  return out;
}

/**
 * Task #451 — Inline category override surfaced on rows that already
 * have a category (whether assigned by a mapping rule or set manually).
 * The category badge itself acts as the picker trigger so changing the
 * category is one click instead of opening the pencil/edit dialog.
 * Picking a new category routes through the same `onPick` handler the
 * uncategorized-row `CategorizeChip` uses (`handleQuickCategorize`),
 * so the same PATCH flow, "Categorized" toast, ruleAction-aware undo,
 * and bulk-recategorize prompts all fire identically.
 */
function InlineCategoryPicker({
  tx,
  currentName,
  categories,
  onPick,
}: {
  tx: Transaction;
  currentName: string;
  categories: TxRowCategory[];
  onPick: (categoryId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Badge
          variant="outline"
          role="button"
          tabIndex={0}
          className="cursor-pointer text-xs font-medium border-violet-200 text-violet-700 bg-violet-50 hover:bg-violet-100 transition-colors"
          data-testid={`badge-category-${tx.id}`}
          title="Change category"
        >
          {currentName}
        </Badge>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search category…" />
          <CommandList>
            <CommandEmpty>No category</CommandEmpty>
            <CommandGroup>
              {categories.map((c) => (
                <CommandItem
                  key={c.id}
                  value={c.name}
                  onSelect={() => {
                    setOpen(false);
                    // Skip the no-op PATCH when the user picks the
                    // category the row already has — avoids surfacing
                    // a misleading "Categorized" toast and prevents
                    // the server's mapping-rule auto-learn / repoint
                    // side effects from firing on a same-category
                    // selection.
                    if (c.id === tx.categoryId) return;
                    onPick(c.id);
                  }}
                  data-testid={`option-inline-category-${tx.id}-${c.id}`}
                >
                  {c.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          <div className="border-t px-2 py-1.5 text-[11px] text-muted-foreground">
            Picking a category will remember this merchant.
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function CategorizeChip({
  tx,
  categories,
  onPick,
}: {
  tx: Transaction;
  categories: TxRowCategory[];
  onPick: (categoryId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const suggestions = useMemo(
    () => suggestCategories(tx.description, categories),
    [tx.description, categories],
  );
  const top = suggestions[0];
  if (top) {
    return (
      <span className="inline-flex items-center gap-1">
        <Badge
          variant="outline"
          className="cursor-pointer text-xs border-violet-300 text-violet-700 bg-violet-50 hover:bg-violet-100"
          onClick={() => onPick(top.id)}
          title="Categorize and remember this merchant"
          data-testid={`badge-suggest-${tx.id}`}
        >
          <Wand2 className="w-3 h-3 mr-1" /> Categorize as {top.name}
        </Badge>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Badge
              variant="outline"
              className="cursor-pointer text-xs border-amber-300 text-amber-700 bg-amber-50 hover:bg-amber-100"
              data-testid={`badge-uncategorized-${tx.id}`}
            >
              Other…
            </Badge>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-0" align="start">
            <Command>
              <CommandInput placeholder="Search category…" />
              <CommandList>
                <CommandEmpty>No category</CommandEmpty>
                {suggestions.length > 1 && (
                  <CommandGroup heading="Suggested">
                    {suggestions.slice(1).map((c) => (
                      <CommandItem
                        key={`s-${c.id}`}
                        onSelect={() => {
                          onPick(c.id);
                          setOpen(false);
                        }}
                      >
                        {c.name}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                )}
                <CommandGroup heading="All categories">
                  {categories.map((c) => (
                    <CommandItem
                      key={c.id}
                      onSelect={() => {
                        onPick(c.id);
                        setOpen(false);
                      }}
                    >
                      {c.name}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
              <div className="border-t px-2 py-1.5 text-[11px] text-muted-foreground">
                Picking a category will remember this merchant.
              </div>
            </Command>
          </PopoverContent>
        </Popover>
      </span>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Badge
          variant="outline"
          className="cursor-pointer text-xs border-amber-300 text-amber-700 bg-amber-50 hover:bg-amber-100"
          data-testid={`badge-uncategorized-${tx.id}`}
        >
          <Wand2 className="w-3 h-3 mr-1" /> Categorize
        </Badge>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search category…" />
          <CommandList>
            <CommandEmpty>No category</CommandEmpty>
            <CommandGroup>
              {categories.map((c) => (
                <CommandItem
                  key={c.id}
                  onSelect={() => {
                    onPick(c.id);
                    setOpen(false);
                  }}
                >
                  {c.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          <div className="border-t px-2 py-1.5 text-[11px] text-muted-foreground">
            Picking a category will remember this merchant.
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export interface TransactionRowChipsProps {
  tx: Transaction;
  categories: TxRowCategory[];
  /** Map of categoryId → category name, used to render the inline picker label. */
  categoryById: Map<string, string>;
  /** Disables the bucket-bubble toggles while a mutation is in flight. */
  isPending: boolean;
  onQuickCategorize: (tx: Transaction, categoryId: string) => void;
  onClearTransfer: (tx: Transaction) => void;
  onToggleBucket: (tx: Transaction, bucket: BucketKey, next: boolean) => void;
  /** Optional slot for the per-call-site matched-rule chip placement. */
  matchedRuleChip?: ReactNode;
  /** Optional slot for the per-call-site forecast-state badge. */
  forecastStateBadge?: ReactNode;
}

/**
 * Task #741/#742 — Shared row-chip cluster used by both the pending and
 * posted day-group blocks on the Transactions page (and any other surface
 * that wants to render the same category picker / transfer pill / bucket
 * bubbles / reimbursed badge cluster). The two earlier inline copies had
 * already drifted once (#740), so this component is now the single source
 * of truth — the only per-block differences (matched-rule chip placement,
 * forecast-state badge styling) are passed in as slots.
 */
export function TransactionRowChips({
  tx,
  categories,
  categoryById,
  isPending,
  onQuickCategorize,
  onClearTransfer,
  onToggleBucket,
  matchedRuleChip,
  forecastStateBadge,
}: TransactionRowChipsProps) {
  return (
    <>
      {tx.categoryId && categoryById.get(tx.categoryId) && (
        <InlineCategoryPicker
          tx={tx}
          currentName={categoryById.get(tx.categoryId)!}
          categories={categories}
          onPick={(catId) => onQuickCategorize(tx, catId)}
        />
      )}
      {matchedRuleChip}
      {!tx.categoryId && (
        <CategorizeChip
          tx={tx}
          categories={categories}
          onPick={(catId) => onQuickCategorize(tx, catId)}
        />
      )}
      {!tx.isTransfer && tx.isTransferUserOverridden && (
        <Badge
          variant="outline"
          className="inline-flex items-center text-[11px] font-normal border-slate-200 text-slate-500 bg-slate-50/60"
          data-testid={`badge-transfer-overridden-cleared-${tx.id}`}
          title="You cleared the auto-Transfer flag on this row. Future syncs won't re-add it."
        >
          Manually set
        </Badge>
      )}
      {tx.isTransfer && (
        <Badge
          variant="outline"
          className="inline-flex items-center gap-1 text-xs border-slate-300 text-slate-700 bg-slate-50"
          data-testid={`badge-transfer-${tx.id}`}
          title={
            tx.isTransferUserOverridden
              ? "Manually set — won't be re-flagged on the next sync"
              : undefined
          }
        >
          Transfer
          {tx.isTransferUserOverridden && (
            <span
              aria-hidden="true"
              data-testid={`badge-transfer-overridden-${tx.id}`}
              className="text-slate-500 -ml-0.5"
            >
              *
            </span>
          )}
          <button
            type="button"
            aria-label="Clear Transfer flag"
            data-testid={`button-clear-transfer-${tx.id}`}
            className="ml-0.5 inline-flex items-center justify-center rounded hover:bg-slate-200/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-slate-400"
            onClick={(e) => {
              e.stopPropagation();
              onClearTransfer(tx);
            }}
          >
            <X className="w-3 h-3" />
          </button>
        </Badge>
      )}
      {forecastStateBadge}
      <BucketBubbles
        flags={{
          weekly: !!tx.weeklyAllowance,
          monthly: !!tx.monthlyAllowance,
          unplanned: !!tx.unplannedAllowance,
          reimbursable: !!tx.reimbursable,
        }}
        onToggle={(bucket: BucketKey, next: boolean) =>
          onToggleBucket(tx, bucket, next)
        }
        disabled={isPending}
      />
      {tx.reimbursed && (
        <Badge
          variant="outline"
          className="text-xs border-green-200 text-green-700 bg-green-50"
        >
          Reimbursed
        </Badge>
      )}
    </>
  );
}
