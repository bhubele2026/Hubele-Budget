import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

export function defaultRememberPattern(description: string): string {
  const cleaned = description.replace(/[#*].*$/, "").trim();
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const head = tokens.slice(0, 2).join(" ");
  return (head || cleaned).slice(0, 40);
}

export function CategoryPicker({
  value,
  categories,
  description,
  onChange,
  testId,
}: {
  value: string | null;
  categories: { id: string; name: string }[];
  description?: string;
  onChange: (id: string | null, rememberPattern?: string | null) => void;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [remember, setRemember] = useState(true);
  // (#474) When the system-managed "Uncategorized" category exists in the
  // list, the hard-coded "Uncategorized" command item picks its real id so
  // the row gets a stored category (and the orange "Categorize" pill goes
  // away). On legacy users without it seeded yet, the option falls back to
  // setting categoryId=null — same as before this task. We also drop the
  // duplicate iteration of the real Uncategorized row from the main list
  // so it isn't shown twice.
  const uncategorizedCat = categories.find(
    (c) => c.name === "Uncategorized",
  );
  // (#607) Same lazy-seed handling for the system-managed "Transfer" row.
  // Picking it sets categoryId=transferCat.id, which the server uses to
  // flip isTransfer=true and clear allowance toggles. We exclude it from
  // the main list so it isn't shown twice. Disabled (and a no-op fallback)
  // when the category hasn't been seeded for this user yet.
  const transferCat = categories.find((c) => c.name === "Transfer");
  const pickableCategories = categories.filter(
    (c) =>
      (!uncategorizedCat || c.id !== uncategorizedCat.id) &&
      (!transferCat || c.id !== transferCat.id),
  );
  const current = value
    ? categories.find((c) => c.id === value)?.name ?? "Unknown"
    : "Uncategorized";
  const pattern = description ? defaultRememberPattern(description) : "";
  const rememberId = `remember-${testId ?? "picker"}`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          className="h-8 text-xs w-52 justify-between font-normal"
          data-testid={testId ?? "button-category-picker"}
        >
          <span className="truncate">{current}</span>
          <ChevronsUpDown className="ml-1 h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search…" />
          <CommandList>
            <CommandEmpty>No category</CommandEmpty>
            <CommandGroup>
              <CommandItem
                onSelect={() => {
                  if (uncategorizedCat) {
                    onChange(
                      uncategorizedCat.id,
                      remember && pattern ? pattern : null,
                    );
                  } else {
                    onChange(null);
                  }
                  setOpen(false);
                }}
              >
                <Check
                  className={cn(
                    "mr-2 h-3 w-3",
                    value === null ||
                      (uncategorizedCat && value === uncategorizedCat.id)
                      ? "opacity-100"
                      : "opacity-0",
                  )}
                />
                Uncategorized
              </CommandItem>
              <CommandItem
                disabled={!transferCat}
                onSelect={() => {
                  if (!transferCat) return;
                  // (#607) Picking Transfer never learns a mapping rule
                  // — server-side `isExcludedCategory` would reject it
                  // anyway, but we also avoid surfacing the Remember
                  // toggle's value here to make the intent obvious:
                  // Transfer is a one-row classification, not a pattern.
                  onChange(transferCat.id, null);
                  setOpen(false);
                }}
                data-testid="option-transfer"
              >
                <Check
                  className={cn(
                    "mr-2 h-3 w-3",
                    transferCat && value === transferCat.id
                      ? "opacity-100"
                      : "opacity-0",
                  )}
                />
                Transfer
              </CommandItem>
              {pickableCategories.map((c) => (
                <CommandItem
                  key={c.id}
                  onSelect={() => {
                    onChange(c.id, remember && pattern ? pattern : null);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-3 w-3",
                      value === c.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                  {c.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          {pattern && (
            <div className="border-t px-2 py-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
              <Checkbox
                checked={remember}
                onCheckedChange={(v) => setRemember(!!v)}
                id={rememberId}
                data-testid={`checkbox-${rememberId}`}
              />
              <label htmlFor={rememberId} className="cursor-pointer">
                Remember <span className="font-mono">"{pattern}"</span>
              </label>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  );
}
