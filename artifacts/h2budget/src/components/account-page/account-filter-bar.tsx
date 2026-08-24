import { useState } from "react";
import { Filter, Search } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { btnSecondarySm, card, fieldLabel, input } from "@/ui";

export type SourceOption = { value: string; label: string };

/**
 * The ledger filter row: search, a date window, and the source / category /
 * member pickers.
 *
 * ⚠️ NOTE FOR WHOEVER PICKS THIS UP: as of this commit NEITHER ledger page
 * renders this component. Both `pages/transactions.tsx` and `pages/amex.tsx`
 * still IMPORT it, and both still keep the `search`/`from`/`to`/`sourceFilter`
 * /`categoryFilter`/`memberFilter` state that drives their `filtered` memo —
 * but the `<AccountFilterBar>` element itself is absent from both JSX trees,
 * so today the only way to set any of those filters is the `?category=` URL
 * parameter. It is styled here on the kit so that re-mounting it is a one-line
 * change rather than a redesign; re-mounting it is deliberately NOT part of
 * this style pass, because adding a control back to a page is a behaviour
 * change, not a restyle.
 */
export function AccountFilterBar({
  search,
  onSearchChange,
  from,
  onFromChange,
  to,
  onToChange,
  sourceFilter,
  onSourceFilterChange,
  sourceOptions,
  categoryFilter,
  onCategoryFilterChange,
  categories,
  members,
  memberFilter,
  onMemberFilterChange,
  extraFilters,
  rightSlot,
  defaultCollapsed = true,
}: {
  search: string;
  onSearchChange: (v: string) => void;
  from: string;
  onFromChange: (v: string) => void;
  to: string;
  onToChange: (v: string) => void;
  sourceFilter: string;
  onSourceFilterChange: (v: string) => void;
  sourceOptions: SourceOption[];
  categoryFilter: string;
  onCategoryFilterChange: (v: string) => void;
  categories: { id: string; name: string }[];
  members: string[];
  memberFilter: string;
  onMemberFilterChange: (v: string) => void;
  extraFilters?: React.ReactNode;
  rightSlot?: React.ReactNode;
  defaultCollapsed?: boolean;
}) {
  // (#806) The filter fields collapse independently of the page's summary
  // tiles. State is component-local with no persistence, so the filters
  // start collapsed on every page load and never remember across reloads.
  const [collapsed, setCollapsed] = useState<boolean>(defaultCollapsed);
  return (
    <div className={card}>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={`${btnSecondarySm} inline-flex items-center gap-1.5`}
            onClick={() => setCollapsed((v) => !v)}
            aria-expanded={!collapsed}
            aria-controls="account-filter-fields"
            aria-label={collapsed ? "Show filters" : "Hide filters"}
            data-testid="button-toggle-filters"
          >
            <Filter className="h-3.5 w-3.5" />
            {collapsed ? "Filters" : "Hide"}
          </button>
          {rightSlot}
        </div>
        {!collapsed && (
          <div
            id="account-filter-fields"
            className="flex flex-wrap items-end gap-3"
          >
            <div className="relative min-w-[200px] flex-1">
              <Search className="absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-neutral-400" />
              <input
                placeholder="Search description or category…"
                value={search}
                onChange={(e) => onSearchChange(e.target.value)}
                className={`${input} pl-8`}
                data-testid="input-search"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className={fieldLabel}>From</label>
              <input
                type="date"
                value={from}
                onChange={(e) => onFromChange(e.target.value)}
                className={`${input} w-40`}
                data-testid="input-from"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className={fieldLabel}>To</label>
              <input
                type="date"
                value={to}
                onChange={(e) => onToChange(e.target.value)}
                className={`${input} w-40`}
                data-testid="input-to"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className={fieldLabel}>Source</label>
              <Select value={sourceFilter} onValueChange={onSourceFilterChange}>
                <SelectTrigger className="h-9 w-36" data-testid="select-source">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {sourceOptions.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <label className={fieldLabel}>Category</label>
              <Select
                value={categoryFilter}
                onValueChange={onCategoryFilterChange}
              >
                <SelectTrigger className="h-9 w-44" data-testid="select-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All categories</SelectItem>
                  <SelectItem value="uncategorized">Uncategorized</SelectItem>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {members.length > 0 && (
              <div className="flex flex-col gap-1">
                <label className={fieldLabel}>Member</label>
                <Select value={memberFilter} onValueChange={onMemberFilterChange}>
                  <SelectTrigger className="h-9 w-40" data-testid="select-member">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All members</SelectItem>
                    {members.map((m) => (
                      <SelectItem key={m} value={m}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {extraFilters}
          </div>
        )}
      </div>
    </div>
  );
}
