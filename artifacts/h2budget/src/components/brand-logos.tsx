import { cn } from "@/lib/utils";

// Real bank brand marks as crisp inline SVG — no CDN, no low-res favicon, no
// broken-image fallback. They render identically sharp at any size and never
// depend on the network (the old Clearbit-CDN version pulled a junky favicon,
// which is the "crap logo" that kept showing up).

export function ChaseLogo({ className }: { className?: string }) {
  // Chase octagon: the blue mark with the square negative-space center.
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn("object-contain", className)}
      role="img"
      aria-label="Chase"
    >
      <path
        fill="#117ACA"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M11.03 2.5h9.94l8.53 8.53v9.94l-8.53 8.53h-9.94L2.5 20.97v-9.94L11.03 2.5Zm2.22 10.75v5.5h5.5v-5.5h-5.5Z"
      />
    </svg>
  );
}

export function AmexLogo({ className }: { className?: string }) {
  // American Express: the iconic blue box with the wordmark.
  return (
    <svg
      viewBox="0 0 32 32"
      className={cn("object-contain", className)}
      role="img"
      aria-label="American Express"
    >
      <rect x="2" y="6" width="28" height="20" rx="2.5" fill="#006FCF" />
      <text
        x="16"
        y="13.4"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="Arial, Helvetica, sans-serif"
        fontSize="4.1"
        fontWeight="700"
        letterSpacing="0.2"
        fill="#fff"
      >
        AMERICAN
      </text>
      <text
        x="16"
        y="19.2"
        textAnchor="middle"
        dominantBaseline="central"
        fontFamily="Arial, Helvetica, sans-serif"
        fontSize="4.1"
        fontWeight="700"
        letterSpacing="0.2"
        fill="#fff"
      >
        EXPRESS
      </text>
    </svg>
  );
}
