import { Search } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type SourceOption = { value: string; label: string };

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
  rightSlot,
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
  rightSlot?: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-4 flex flex-wrap items-end gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search description or category…"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-8 h-9"
            data-testid="input-search"
          />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
            From
          </label>
          <Input
            type="date"
            value={from}
            onChange={(e) => onFromChange(e.target.value)}
            className="h-9 w-40"
            data-testid="input-from"
          />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
            To
          </label>
          <Input
            type="date"
            value={to}
            onChange={(e) => onToChange(e.target.value)}
            className="h-9 w-40"
            data-testid="input-to"
          />
        </div>
        <div>
          <label className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
            Source
          </label>
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
        <div>
          <label className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
            Category
          </label>
          <Select value={categoryFilter} onValueChange={onCategoryFilterChange}>
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
          <div>
            <label className="block text-[10px] uppercase tracking-widest text-muted-foreground mb-1">
              Member
            </label>
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
        {rightSlot}
      </CardContent>
    </Card>
  );
}
