import { UserButton } from "@clerk/react";
import { Info } from "lucide-react";
import { APP_VERSION } from "@/lib/version";
import { toast } from "@/hooks/use-toast";
import { requestWhatsNewOpen, useWhatsNewUnread } from "@/lib/whatsNewSignal";

/** The build the browser is running, as the account menu and the drawer say it. */
export const VERSION_LABEL = `Version ${APP_VERSION}`;

/** Copy the build id, so "which version are you on?" has a one-tap answer. */
export function copyVersion(): void {
  const done = typeof navigator !== "undefined" ? navigator.clipboard?.writeText(APP_VERSION) : undefined;
  if (!done) {
    toast({ title: VERSION_LABEL });
    return;
  }
  done.then(
    () => toast({ title: `${VERSION_LABEL} copied.` }),
    () => toast({ title: VERSION_LABEL }),
  );
}

/** The account menu's What's new item: "What's new · New" while a note is unread. */
export function whatsNewMenuLabel(unread: number | null): string {
  return unread ? "What's new · New" : "What's new";
}

/**
 * ⭐ (C12) THE ACCOUNT MENU — Clerk's `UserButton` with two items of ours:
 * (WN) "What's new" (the history of what changed; "· New" while something is
 * unread), and the build version (LND-09), which lost its home when the
 * landing door went — tapping it copies the build id, and it stays LAST. Both
 * sit after Clerk's own "Manage account" and "Sign out". The same menu opens
 * from the header and from the phone drawer (SH-08).
 */
export function AccountMenu() {
  const unread = useWhatsNewUnread();
  return (
    <UserButton>
      <UserButton.MenuItems>
        <UserButton.Action
          label={whatsNewMenuLabel(unread)}
          labelIcon={<Info className="size-4" aria-hidden />}
          // The next frame, so Clerk's popover has closed before the sheet opens.
          onClick={() => requestAnimationFrame(() => requestWhatsNewOpen())}
        />
        <UserButton.Action
          label={VERSION_LABEL}
          labelIcon={<Info className="size-4" aria-hidden />}
          onClick={copyVersion}
        />
      </UserButton.MenuItems>
    </UserButton>
  );
}
