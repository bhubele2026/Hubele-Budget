import { useDroppable } from "@dnd-kit/core";
import type { Category } from "@workspace/api-client-react";

export const CATEGORY_DROP_PREFIX = "category:";

export function CategoryDropTarget({
  category,
  isCurrent,
  isDragActive,
}: {
  category: Category;
  isCurrent: boolean;
  isDragActive: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `${CATEGORY_DROP_PREFIX}${category.id}`,
    data: { kind: "category", categoryId: category.id },
  });
  const showHover = isOver && isDragActive;
  return (
    <button
      ref={setNodeRef}
      type="button"
      tabIndex={-1}
      aria-label={`Drop rule onto ${category.name}`}
      data-testid={`category-drop-${category.id}`}
      data-drop-over={showHover ? "true" : undefined}
      className={`px-2.5 py-1 rounded-full border text-xs whitespace-nowrap transition-colors select-none ${
        showHover
          ? "bg-primary text-primary-foreground border-primary ring-2 ring-primary/40"
          : isCurrent
            ? "bg-positive/10 border-positive/30 text-positive"
            : "bg-muted/40 border-border text-foreground hover:bg-muted"
      }`}
    >
      {category.name}
    </button>
  );
}
