import { useMemo, useState } from "react";
import type { Category } from "@workspace/api-client-react";
import { Note } from "@/kit/Note";
import { Sheet } from "@/kit/Sheet";

/**
 * Pick a household category. A search box over the list, grouped as the budget
 * groups them. One sheet serves the ledger, the review queue and the split
 * sheet, so a category is chosen the same way everywhere.
 */
export function CategoryPickerSheet({
  open,
  onOpenChange,
  title = "File under",
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
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const kept = categories
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.groupName.toLowerCase().includes(q))
      .slice()
      .sort((a, b) => a.groupName.localeCompare(b.groupName) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    const by = new Map<string, Category[]>();
    for (const c of kept) by.set(c.groupName, [...(by.get(c.groupName) ?? []), c]);
    return [...by.entries()];
  }, [categories, query]);

  return (
    <Sheet
      open={open}
      onOpenChange={(o) => {
        if (!o) setQuery("");
        onOpenChange(o);
      }}
      title={title}
      description={description}
    >
      <label className="sr-only" htmlFor="category-search">
        Search categories
      </label>
      <input
        id="category-search"
        type="search"
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search categories"
        className="mb-4 h-10 w-full rounded-1 border border-rule-strong bg-paper-0 px-3 type-body text-ink"
        data-testid="category-search"
      />
      {groups.length === 0 ? (
        <Note kind="empty">No category matches.</Note>
      ) : (
        <div className="flex flex-col gap-4" data-testid="category-list">
          {groups.map(([group, items]) => (
            <div key={group}>
              <h3 className="mb-1 type-section text-ink-2">{group}</h3>
              <ul>
                {items.map((c) => (
                  <li key={c.id} className="border-t border-rule first:border-t-0">
                    <button
                      type="button"
                      onClick={() => {
                        setQuery("");
                        onPick(c);
                      }}
                      className="flex min-h-10 w-full items-center justify-between gap-3 py-2 text-left type-body text-ink hover:bg-paper-1"
                      data-testid="category-option"
                    >
                      <span>{c.name}</span>
                      {c.id === currentId && <span className="type-caption text-ink-3">current</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Sheet>
  );
}
