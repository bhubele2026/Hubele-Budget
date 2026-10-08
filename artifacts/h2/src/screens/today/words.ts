const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Friday" for a YYYY-MM-DD date. */
export function weekdayName(iso: string): string {
  return DAYS[new Date(`${iso}T12:00:00Z`).getUTCDay()] ?? "";
}
