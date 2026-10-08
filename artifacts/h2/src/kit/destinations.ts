import { List, MessageCircle, Sun, Target, type LucideIcon } from "lucide-react";

/**
 * The four destinations, in order. Today and Activity are live; the others
 * are shown (so the shape of the app is visible from day one) but disabled and
 * marked "soon" until their stage lands.
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
  { key: "plan", label: "Plan", href: "/plan", icon: Target, live: false },
  { key: "ask", label: "Ask", href: "/ask", icon: MessageCircle, live: false },
];

/** Boundary-aware: "/" is active only at "/", "/plan" at "/plan" and below. */
export function isActive(location: string, href: string): boolean {
  if (href === "/") return location === "/";
  return location === href || location.startsWith(`${href}/`);
}
