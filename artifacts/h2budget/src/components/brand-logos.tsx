import { cn } from "@/lib/utils";

// Matte, monochrome bank marks. Inline SVG (no CDN, always crisp) drawn in
// `currentColor` so they pick up the surrounding text color — off-white on
// the matte-black tiles, ink on light. No blue, no gloss: matte everything,
// to match the rest of the app.

export function ChaseLogo({ className }: { className?: string }) {
  // Chase octagon with the square negative-space center.
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn("object-contain", className)}
      role="img"
      aria-label="Chase"
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M11.03 2.5h9.94l8.53 8.53v9.94l-8.53 8.53h-9.94L2.5 20.97v-9.94L11.03 2.5Zm2.22 10.75v5.5h5.5v-5.5h-5.5Z"
      />
    </svg>
  );
}

export function AmexLogo({ className }: { className?: string }) {
  // American Express: a matte outlined badge with the AMEX wordmark.
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn("object-contain", className)}
      role="img"
      aria-label="American Express"
    >
      <rect
        x="2.5"
        y="6.5"
        width="27"
        height="19"
        rx="2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <text
        x="16"
        y="16.4"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="Arial, Helvetica, sans-serif"
        fontSize="6.4"
        fontWeight="700"
        letterSpacing="0.4"
        fill="currentColor"
      >
        AMEX
      </text>
    </svg>
  );
}
