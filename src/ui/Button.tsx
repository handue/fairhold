import type { ButtonHTMLAttributes } from "react";

import { cn } from "./cn";

/**
 * Buttons as drawn in the approved screens. The lime CTA is the one primary action of an area;
 * ink is a solid secondary; outline and quiet are bordered (ink or line); ghost has no fill.
 */
export type ButtonVariant = "lime" | "ink" | "outline" | "quiet" | "ghost";

/** Heights in px. 30: tile actions; 36: card controls; 40: list controls; 48 and 56: CTAs. */
export type ButtonSize = 30 | 36 | 40 | 48 | 56;

const VARIANT: Record<ButtonVariant, string> = {
  lime: "bg-lime text-ink",
  ink: "bg-ink text-white",
  outline: "border border-ink text-ink",
  quiet: "border border-line text-ink",
  ghost: "border border-transparent text-ink",
};

const SIZE: Record<ButtonSize, string> = {
  30: "h-30 gap-7 rounded-full text-13 font-semibold",
  36: "h-36 gap-6 rounded-full text-13.5 font-semibold",
  40: "h-40 gap-8 rounded-full text-14 font-medium",
  48: "h-48 gap-10 rounded-16 text-15 font-semibold",
  56: "h-56 gap-10 rounded-16 text-16 font-semibold",
};

const DEFAULT_PADDING: Record<ButtonSize, string> = {
  30: "px-13",
  36: "pr-14 pl-11",
  40: "pr-16 pl-20",
  48: "pr-16 pl-20",
  56: "px-20",
};

export interface ButtonStyle {
  variant: ButtonVariant;
  size: ButtonSize;
  /** Replaces the size's default horizontal padding, for the few buttons drawn with their own. */
  padding?: string;
  /** A block-level button that fills its container, like the lot page's "Place bid". */
  fullWidth?: boolean;
  className?: string;
}

/** The class list of a button, for links and other elements that look like one. */
export function buttonClass({ variant, size, padding, fullWidth = false, className }: ButtonStyle): string {
  return cn(
    fullWidth ? "flex w-full" : "inline-flex",
    "cursor-pointer items-center whitespace-nowrap",
    VARIANT[variant],
    SIZE[size],
    padding ?? DEFAULT_PADDING[size],
    className,
  );
}

type ButtonProps = ButtonStyle & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className">;

export function Button({
  variant,
  size,
  padding,
  fullWidth,
  className,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button type={type} className={buttonClass({ variant, size, padding, fullWidth, className })} {...props} />
  );
}
