import { cn } from "../cn";

import { DRAWINGS, type Drawing, type DrawingArt, type DrawingKey } from "./drawings";

/** tile: catalog and list thumbnails (140x105); hero: the lot page photo; thumb: its thumbnail row. */
export type DrawingVariant = "tile" | "hero" | "thumb";

/**
 * Only the cloche was drawn at every size. Other drawings are shown at the missing sizes by
 * scaling their own art and keeping a line weight close to the drawn sizes.
 */
function resolveArt(drawing: Drawing, variant: DrawingVariant): DrawingArt {
  const drawn = drawing[variant];
  if (drawn) return drawn;
  if (drawing.tile) {
    return variant === "hero"
      ? { ...drawing.tile, width: 300, height: 225, strokeWidth: 2 }
      : { ...drawing.tile, width: 48, height: 36, strokeWidth: 1.25 };
  }
  const art = drawing.thumb ?? drawing.hero;
  if (!art) throw new Error("A drawing needs at least one size of art.");
  const scale = variant === "hero" ? 4 : 1;
  return { ...art, width: art.width * scale, height: art.height * scale, strokeWidth: 2, fixedStroke: true };
}

interface LotIllustrationProps {
  drawing: DrawingKey;
  variant: DrawingVariant;
  className?: string;
}

export function LotIllustration({ drawing, variant, className }: LotIllustrationProps) {
  const art = resolveArt(DRAWINGS[drawing], variant);
  return (
    <svg
      width={art.width}
      height={art.height}
      viewBox={art.viewBox}
      fill="none"
      strokeWidth={art.strokeWidth}
      strokeLinecap="round"
      strokeLinejoin={art.roundJoins ? "round" : undefined}
      aria-hidden="true"
      className={cn("flex-none stroke-ink", art.fixedStroke && "non-scaling-stroke overflow-visible", className)}
    >
      {art.paths}
    </svg>
  );
}
