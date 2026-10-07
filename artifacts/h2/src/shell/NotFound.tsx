import { Link } from "wouter";
import { buttonClass } from "@/kit/Button";

/**
 * A path H2 does not have. Rendered INSIDE the shell, so the masthead and the
 * dock are still there: never a blank page.
 */
export function NotFound() {
  return (
    <div className="flex flex-col gap-4" data-testid="not-found">
      <h1 className="type-headline text-ink">Nothing here.</h1>
      <p className="type-body text-ink-2">This page is not part of H2 yet.</p>
      <div className="flex flex-wrap gap-3">
        <Link href="/" className={buttonClass({ variant: "primary", size: "sm" })}>
          Back to Today
        </Link>
        <a href="/classic/" className={buttonClass({ variant: "quiet", size: "sm" })}>
          Open the classic app
        </a>
      </div>
    </div>
  );
}
