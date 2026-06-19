import { useMemo, useState } from "react";
import { type MappingRule } from "@workspace/api-client-react";
import { MatchedRuleChip } from "@/components/matched-rule-chip";
import { Button } from "@/components/ui/button";
import { Wand2 } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command";

/**
 * Category combobox surfaced inside the Add-Transaction dialog (Task #230).
 * Shows the live auto-pick under the trigger as a `MatchedRuleChip` so the
 * user can see *why* a category was suggested (and click straight to the
 * Mapping Rules page to inspect the rule). Picking from the list flips the
 * parent's "manually picked" flag so subsequent description edits stop
 * overwriting the explicit choice. A "Clear" affordance lets the user
 * deliberately submit the row uncategorized — POST /transactions treats an
 * explicit `categoryId: null` as authoritative and skips the auto-pick.
 */
export function NewTransactionCategoryPicker({
  value,
  onChange,
  categories,
  autoMatchedRule,
  mappingRules,
}: {
  value: string | null;
  onChange: (next: string | null) => void;
  categories: { id: string; name: string }[];
  autoMatchedRule: MappingRule | null;
  mappingRules: readonly MappingRule[] | undefined;
}) {
  const [open, setOpen] = useState(false);
  const selected = useMemo(
    () => categories.find((c) => c.id === value) ?? null,
    [categories, value],
  );
  // Surface the chip whenever the live auto-pick attributes the current
  // value to a rule — same semantics as the Transactions / Amex row chip.
  const matchedRuleId =
    autoMatchedRule && autoMatchedRule.categoryId === value
      ? autoMatchedRule.id
      : null;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              role="combobox"
              aria-expanded={open}
              aria-label="Select category"
              className="flex-1 justify-between font-normal"
              data-testid="combobox-new-tx-category"
            >
              {selected ? (
                <span className="truncate">{selected.name}</span>
              ) : (
                <span className="text-muted-foreground">Uncategorized</span>
              )}
              <Wand2 className="w-3.5 h-3.5 ml-2 shrink-0 text-muted-foreground" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
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
                        onChange(c.id);
                        setOpen(false);
                      }}
                      data-testid={`option-new-tx-category-${c.id}`}
                    >
                      {c.name}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        {value && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-9 px-2 text-xs text-muted-foreground"
            onClick={() => onChange(null)}
            data-testid="button-new-tx-category-clear"
            title="Leave uncategorized"
          >
            Clear
          </Button>
        )}
      </div>
      <div className="min-h-[18px]">
        <MatchedRuleChip
          categoryId={value}
          matchedRuleId={matchedRuleId}
          rules={mappingRules}
          testIdSuffix="new-tx-dialog"
          variant="compact"
        />
      </div>
    </div>
  );
}
