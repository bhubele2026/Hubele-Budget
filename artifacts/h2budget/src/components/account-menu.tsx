import { UserButton } from "@clerk/react";
import { Info } from "lucide-react";
import { APP_VERSION } from "@/lib/version";
import { toast } from "@/hooks/use-toast";

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

/**
 * ⭐ (C12) THE ACCOUNT MENU — Clerk's `UserButton` with one item of ours: the
 * build version (LND-09), which lost its home when the landing door went. It
 * sits after Clerk's own "Manage account" and "Sign out", and tapping it
 * copies the build id. The same menu opens from the header and from the
 * phone drawer (SH-08).
 */
export function AccountMenu() {
  return (
    <UserButton>
      <UserButton.MenuItems>
        <UserButton.Action
          label={VERSION_LABEL}
          labelIcon={<Info className="size-4" aria-hidden />}
          onClick={copyVersion}
        />
      </UserButton.MenuItems>
    </UserButton>
  );
}
