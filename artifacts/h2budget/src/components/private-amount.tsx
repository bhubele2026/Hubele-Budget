import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Shoulder-surf guard. Blurs a sensitive figure until you look at it: blurred +
 * unselectable by default, reveals on hover (desktop) and toggles on click/tap
 * (mobile/keyboard). Use for numbers we don't want readable by anyone glancing
 * at the screen — e.g. total debt owed on the home page. The full, unmasked
 * figure still lives on the pages you deliberately open (the Avalanche plan).
 */
export function PrivateAmount({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        setRevealed((v) => !v);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setRevealed((v) => !v);
        }
      }}
      aria-label={revealed ? "Hide amount" : "Reveal amount"}
      title={revealed ? "Tap to hide" : "Tap to reveal"}
      data-testid="private-amount"
      className={cn(
        "inline-block cursor-pointer rounded align-baseline transition-[filter,opacity] duration-200",
        !revealed &&
          "select-none opacity-80 blur-[9px] hover:blur-none hover:opacity-100",
        className,
      )}
    >
      {children}
    </span>
  );
}
