import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// Real bank logos, fetched from a logo CDN (Clearbit) so the account-page
// "app icon" shows the actual brand mark. If the network image fails to
// load (offline, blocked, CDN down) we fall back to a clean inline SVG so
// the tile never breaks.

function CdnLogo({
  domain,
  alt,
  className,
  fallback,
}: {
  domain: string;
  alt: string;
  className?: string;
  fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  if (failed) return <>{fallback}</>;
  return (
    <img
      src={`https://logo.clearbit.com/${domain}`}
      alt={alt}
      className={cn("object-contain", className)}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}

export function ChaseLogo({ className }: { className?: string }) {
  return (
    <CdnLogo
      domain="chase.com"
      alt="Chase"
      className={className}
      fallback={
        <svg viewBox="0 0 32 32" className={className} role="img" aria-label="Chase">
          <path
            fill="#117ACA"
            fillRule="evenodd"
            clipRule="evenodd"
            d="M11 3h10l8 8v10l-8 8H11l-8-8V11l8-8Zm1.5 9.5v7h7v-7h-7Z"
          />
        </svg>
      }
    />
  );
}

export function AmexLogo({ className }: { className?: string }) {
  return (
    <CdnLogo
      domain="americanexpress.com"
      alt="American Express"
      className={className}
      fallback={
        <svg viewBox="0 0 32 32" className={className} role="img" aria-label="American Express">
          <rect x="2.5" y="6" width="27" height="20" rx="2.5" fill="#016FD0" />
          <text
            x="16"
            y="16.6"
            textAnchor="middle"
            dominantBaseline="central"
            fontFamily="Arial, Helvetica, sans-serif"
            fontSize="6.5"
            fontWeight="700"
            letterSpacing="0.3"
            fill="#fff"
          >
            AMEX
          </text>
        </svg>
      }
    />
  );
}
