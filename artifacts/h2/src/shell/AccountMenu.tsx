import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Link, useLocation } from "wouter";
import { useClerk, useUser } from "@clerk/react";
import { cx } from "@/lib/cx";
import { prefetchRoute } from "@/lib/routePrefetch";

const ITEM =
  "block w-full px-3 py-2 text-left type-label text-ink hover:bg-paper-1 focus-visible:bg-paper-1";

/**
 * ⭐ THE ACCOUNT MENU — the avatar at the end of the masthead. Household, Recap,
 * the Clerk account panel, and Sign out. A plain disclosure with menu roles:
 * Escape closes it and returns focus to the avatar, arrows move between items,
 * and a click outside or a route change closes it. No motion.
 */
export function AccountMenu() {
  const [open, setOpen] = useState(false);
  const [location] = useLocation();
  const { user } = useUser();
  const clerk = useClerk();
  const menuId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);

  const initial = (user?.firstName || user?.primaryEmailAddress?.emailAddress || "?").trim().charAt(0).toUpperCase() || "?";

  // A route change closes it.
  useEffect(() => setOpen(false), [location]);

  useEffect(() => {
    if (!open) return;
    box.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(box.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? []);
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      button.current?.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End") {
      e.preventDefault();
      const n = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[n]?.focus();
    } else if (e.key === "Tab") {
      setOpen(false);
    }
  };

  return (
    <div className="relative" data-testid="account-menu">
      <button
        ref={button}
        type="button"
        aria-label="Account menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        data-testid="account-button"
        className={cx(
          "inline-flex size-8 items-center justify-center rounded-full border border-rule-strong type-label text-ink",
          open ? "bg-paper-2" : "bg-paper-1 hover:bg-paper-2",
        )}
      >
        <span aria-hidden>{initial}</span>
      </button>
      {open && (
        <div
          ref={box}
          id={menuId}
          role="menu"
          aria-label="Account"
          onKeyDown={onKey}
          data-testid="account-popup"
          className="absolute right-0 z-40 mt-2 w-48 overflow-hidden rounded-1 border border-rule-strong bg-paper-0 py-1"
        >
          <Link href="/household" role="menuitem" className={ITEM} onMouseEnter={() => prefetchRoute("/household")} data-testid="menu-household">
            Household
          </Link>
          <Link href="/recap" role="menuitem" className={ITEM} onMouseEnter={() => prefetchRoute("/recap")} data-testid="menu-recap">
            Recap
          </Link>
          <Link href="/household/ai" role="menuitem" className={ITEM} onMouseEnter={() => prefetchRoute("/household/ai")} data-testid="menu-ai">
            AI cost
          </Link>
          <button
            type="button"
            role="menuitem"
            className={ITEM}
            onClick={() => {
              setOpen(false);
              clerk.openUserProfile();
            }}
            data-testid="menu-account"
          >
            Account
          </button>
          <button
            type="button"
            role="menuitem"
            className={cx(ITEM, "border-t border-rule")}
            onClick={() => {
              setOpen(false);
              void clerk.signOut();
            }}
            data-testid="menu-signout"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
