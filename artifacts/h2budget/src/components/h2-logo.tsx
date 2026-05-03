import { cn } from "@/lib/utils";

const LIGHT_SRC = `${import.meta.env.BASE_URL}logo.png`;
const DARK_SRC = `${import.meta.env.BASE_URL}logo-dark.png`;

export function H2Logo({
  className,
  alt = "H2 Budget",
}: {
  className?: string;
  alt?: string;
}) {
  return (
    <>
      <img
        src={LIGHT_SRC}
        alt={alt}
        className={cn("block dark:hidden", className)}
        data-testid="logo-light"
      />
      <img
        src={DARK_SRC}
        alt={alt}
        className={cn("hidden dark:block", className)}
        data-testid="logo-dark"
      />
    </>
  );
}
