import { useMemo, useState } from "react";
import type { Category } from "@workspace/api-client-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { emptyNote, input } from "@/ui";

/**
 * Pick a household category: a search box over the list, grouped as the budget
 * groups them (group name, then sort order, then name). Ported from the frozen
 * h2 app's `CategoryPickerSheet` (F1), rebuilt on this app's dialog.
 */
export function groupCategories(categories: readonly Category[], query: string): Array<[string, Category[]]> {
  const q = query.trim().toLowerCase();
  const kept = categories
    .filter((c) => !q || c.name.toLowerCase().includes(q) || c.groupName.toLowerCase().includes(q))
    .slice()
    .sort((a, b) => a.groupName.localeCompare(b.groupName) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const by = new Map<string, Category[]>();
  for (const c of kept) by.set(c.groupName, [...(by.get(c.groupName) ?? []), c]);
  return [...by.entries()];
}

export function CategoryPickerDialog({
  open,
  onOpenChange,
  title = "Change category",
  description,
  categories,
  currentId,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  description?: string;
  categories: readonly Category[];
  currentId?: string | null;
  onPick: (category: Category) => void;
}) {
  const [query, setQuery] = useState("");
  const groups = useMemo(() => groupCategories(categories, query), [categories, query]);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setQuery("");
        onOpenChange(o);
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto" data-testid="category-picker">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description ?? "Choose where this charge belongs."}</DialogDescription>
        </DialogHeader>
        <label className="sr-only" htmlFor="category-picker-search">
          Search categories
        </label>
        <input
          id="category-picker-search"
          type="search"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search categories"
          className={input}
          data-testid="category-search"
        />
        {groups.length === 0 ? (
          <p className={emptyNote}>No category matches.</p>
        ) : (
          <div className="flex flex-col gap-4" data-testid="category-list">
            {groups.map(([group, items]) => (
              <div key={group}>
                <h3 className="mb-1 text-micro font-semibold uppercase tracking-wide text-neutral-500">{group}</h3>
                <ul>
                  {items.map((c) => (
                    <li key={c.id} className="border-t border-brand-line first:border-t-0">
                      <button
                        type="button"
                        onClick={() => {
                          setQuery("");
                          onPick(c);
                        }}
                        className="press flex min-h-10 w-full items-center justify-between gap-3 rounded-control px-1 py-2 text-left text-body text-brand-navy hover:bg-platinum-3"
                        data-testid="category-option"
                      >
                        <span>{c.name}</span>
                        {c.id === currentId && <span className="text-micro text-neutral-500">current</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
