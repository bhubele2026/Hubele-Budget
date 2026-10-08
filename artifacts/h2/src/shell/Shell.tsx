import type { ReactNode } from "react";
import { useLocation } from "wouter";
import { Show } from "@clerk/react";
import { Masthead } from "@/kit/Masthead";
import { Dock } from "@/kit/Dock";
import { AccountMenu } from "./AccountMenu";

/**
 * The frame every screen sits in: masthead, a 720 px reading column with
 * 16 px gutters on a phone and 32 px on a desktop, and the dock on a phone.
 * It reads no data, so it can paint before anything has loaded.
 */
export function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return (
    <div className="min-h-dvh bg-paper-0 text-ink" data-testid="shell">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-1 focus:bg-paper-0 focus:px-3 focus:py-2 type-label"
      >
        Skip to content
      </a>
      <Masthead
        location={location}
        account={
          <Show when="signed-in">
            <AccountMenu />
          </Show>
        }
      />
      <main id="main" className="mx-auto w-full max-w-read px-4 pt-6 pb-28 sm:px-8 sm:pt-8 md:pb-16">
        {children}
      </main>
      <Dock location={location} />
    </div>
  );
}

/**
 * The frame before Clerk has answered, for a browser never signed in here:
 * paper and the wordmark, zero numbers. Better than a blank page; the redirect
 * to sign-in follows as soon as Clerk knows.
 */
export function BootFrame() {
  return (
    <div className="min-h-dvh bg-paper-0" data-testid="boot-frame" aria-busy="true">
      <div className="border-b border-rule">
        <div className="mx-auto flex h-14 max-w-read items-center px-4 sm:px-8">
          <span className="type-headline leading-none font-semibold text-ink">
            H<span className="text-moss">2</span>
          </span>
        </div>
      </div>
    </div>
  );
}
