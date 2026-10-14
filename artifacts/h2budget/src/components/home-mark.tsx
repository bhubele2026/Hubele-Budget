import { Link } from "wouter";
import { H2Wordmark } from "@/components/h2-wordmark";

/**
 * ⭐ THE WORDMARK IS A WAY TO THE DASHBOARD — and so is the Dashboard item. One
 * place, two doors.
 */
export function HomeMark({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link
      href="/home"
      aria-label="H2 Budget — Dashboard"
      data-testid="brand-home"
      onClick={onNavigate}
      className="press flex flex-none items-center rounded-control px-2 py-1.5 hover:bg-chrome-press"
    >
      <H2Wordmark tone="white" size={24} data-testid="h2-wordmark" />
    </Link>
  );
}
