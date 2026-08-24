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
      // ⚠️ Ring only — no border/size change between states. A drop target that
      // grows on hover shifts every chip after it in the wrapped strip, and the
      // row you were aiming at moves out from under the cursor mid-drag.
      className={`press select-none whitespace-nowrap rounded-full px-2.5 py-1 text-micro font-medium ${
        showHover
          ? "bg-brand-navy text-white ring-2 ring-brand-navy/40"
          : isCurrent
            ? "bg-platinum-3 text-brand-navy ring-1 ring-brand-navy/30"
            : "bg-white text-neutral-600 ring-1 ring-brand-line hover:bg-neutral-50 hover:text-brand-navy"
      }`}
    >
      {category.name}
    </button>
  );
}
