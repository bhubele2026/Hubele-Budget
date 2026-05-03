// Earliest month the dashboard month-cycler is allowed to navigate back to.
export const FLOOR_YEAR = 2026;
export const FLOOR_MONTH_INDEX = 3; // April (0-indexed)

export function computeViewMonth(today: Date, monthOffset: number): Date {
  return new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
}

export function isAtFloor(viewMonth: Date): boolean {
  return (
    viewMonth.getFullYear() === FLOOR_YEAR &&
    viewMonth.getMonth() === FLOOR_MONTH_INDEX
  );
}

export function monthKeyFor(viewMonth: Date): string {
  return `${viewMonth.getFullYear()}-${String(viewMonth.getMonth() + 1).padStart(2, "0")}`;
}

export function monthLabelFor(viewMonth: Date): string {
  return viewMonth
    .toLocaleDateString("en-US", { month: "long", year: "numeric" })
    .toUpperCase();
}
