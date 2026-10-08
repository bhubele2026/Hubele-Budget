import { List, MessageCircle, Sun, Target, type LucideIcon } from "lucide-react";

/**
 * The four destinations, in order. All four are live (Ask landed with S5); the
 * `live` flag and the "soon" rendering stay so a future destination can be
 * shown before it ships.
 */
export interface Destination {
  key: "today" | "activity" | "plan" | "ask";
  label: string;
  href: string;
  icon: LucideIcon;
  live: boolean;
}

export const DESTINATIONS: readonly Destination[] = [
  { key: "today", label: "Today", href: "/", icon: Sun, live: true },
  { key: "activity", label: "Activity", href: "/activity", icon: List, live: true },
  { key: "plan", label: "Plan", href: "/plan", icon: Target, live: true },
  { key: "ask", label: "Ask", href: "/ask", icon: MessageCircle, live: true },
];

/** Boundary-aware: "/" is active only at "/", "/plan" at "/plan" and below. */
export function isActive(location: string, href: string): boolean {
  if (href === "/") return location === "/";
  return location === href || location.startsWith(`${href}/`);
}
