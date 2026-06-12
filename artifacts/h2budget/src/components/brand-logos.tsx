// Lightweight brand marks for the account pages. Approximations of the
// real logos in the official brand blues — recognizable without shipping
// trademarked raster assets.

export function ChaseLogo({ className }: { className?: string }) {
  // Chase blue octagon ring (#117ACA) with the square center void.
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      role="img"
      aria-label="Chase"
    >
      <path
        fill="#117ACA"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M11 3h10l8 8v10l-8 8H11l-8-8V11l8-8Zm1.5 9.5v7h7v-7h-7Z"
      />
    </svg>
  );
}

export function AmexLogo({ className }: { className?: string }) {
  // American Express blue box (#016FD0).
  return (
    <svg
      viewBox="0 0 32 32"
      className={className}
      role="img"
      aria-label="American Express"
    >
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
  );
}
