import { cn } from "@/lib/utils";

const LOGO_SRC = `${import.meta.env.BASE_URL}logo.png`;

/**
 * One mark, one file. Dark mode is gone (the app is light-only, on the
 * dashboard's navy/platinum palette), so the light/dark `<img>` pair and
 * `logo-dark.png` went with it.
 *
 * ⚠️ `data-testid="logo-light"` is kept verbatim — testids stay stable across
 * the overhaul even when the thing they name has stopped being a variant.
 */
export function H2Logo({
  className,
  alt = "H2 Budget",
}: {
  className?: string;
  alt?: string;
}) {
  return (
    <img
      src={LOGO_SRC}
      alt={alt}
      className={cn("block", className)}
      data-testid="logo-light"
    />
  );
}
