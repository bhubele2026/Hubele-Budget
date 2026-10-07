import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import type { LucideIcon } from "lucide-react";
import { cx } from "@/lib/cx";

export type ButtonVariant = "primary" | "quiet" | "danger" | "link";
export type ButtonSize = "sm" | "md";

const BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-1 type-label transition-colors disabled:cursor-not-allowed disabled:opacity-50";

const SIZE: Record<ButtonSize, string> = {
  sm: "h-8 px-3",
  md: "h-10 px-4",
};

/**
 * Four kinds and no more. Primary is the one action a screen asks for; quiet is
 * everything else; danger only for what cannot be undone; link reads as a
 * word in a sentence. Paper on moss is 7.1:1, clay on paper 5.7:1.
 */
const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-moss text-paper-0 hover:bg-moss-ink",
  quiet: "border border-rule-strong bg-paper-0 text-ink hover:bg-paper-1",
  danger: "border border-clay bg-paper-0 text-clay hover:bg-clay-wash",
  link: "text-moss underline decoration-1 underline-offset-4 hover:text-moss-ink",
};

/** The class string for a button-shaped element (an anchor that acts as a button, say). */
export function buttonClass({
  variant = "quiet",
  size = "md",
}: { variant?: ButtonVariant; size?: ButtonSize } = {}): string {
  return cx(BASE, variant === "link" ? "h-auto px-0" : SIZE[size], VARIANT[variant]);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** A lucide icon, drawn at 16 px beside the label. The label stays. */
  icon?: LucideIcon;
  children?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = "quiet",
  size = "md",
  icon: Icon,
  className,
  children,
  type = "button",
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button ref={ref} type={type} className={cx(buttonClass({ variant, size }), className)} {...rest}>
      {Icon && <Icon size={16} strokeWidth={1.75} aria-hidden />}
      {children}
    </button>
  );
}
