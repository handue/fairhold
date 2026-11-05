import { cn } from "./cn";

/**
 * Glim: a frosted lime orb with two ink eyes and no mouth. Every approved size has its own eye
 * geometry and shading, so sizes are a closed set rather than a scale.
 *
 * 68 rests in the page corner, 38 heads Glim's panels, 32 sits in the catalog band, 26 marks
 * Glim's events, 22 and 18 sit inside buttons and table cells.
 */
export type OrbSize = 68 | 38 | 32 | 26 | 22 | 18;

interface OrbGeometry {
  size: string;
  shadow: string;
  eye: string;
  left: string;
  right: string;
}

const ORB_GEOMETRY: Record<OrbSize, OrbGeometry> = {
  68: { size: "size-68", shadow: "shadow-orb-68", eye: "top-27 h-9 w-6 rounded-3", left: "left-24", right: "right-24" },
  38: { size: "size-38", shadow: "shadow-orb-38", eye: "top-15 h-6 w-4 rounded-2", left: "left-13", right: "right-13" },
  32: { size: "size-32", shadow: "shadow-orb-32", eye: "top-12 h-6 w-3.5 rounded-2", left: "left-10.25", right: "right-10.25" },
  26: { size: "size-26", shadow: "shadow-orb-38", eye: "top-10 h-5 w-3 rounded-2", left: "left-8.5", right: "right-8.5" },
  22: { size: "size-22", shadow: "shadow-orb-22", eye: "top-8.5 h-4.5 w-2.5 rounded-1.25", left: "left-7.25", right: "right-7.25" },
  18: { size: "size-18", shadow: "shadow-orb-18", eye: "top-7 h-3.75 w-2 rounded-1", left: "left-6", right: "right-6" },
};

interface OrbProps {
  size: OrbSize;
  /** "soft" is the flat glow of the lot page's agent link; everywhere else the orb is shaded. */
  glow?: "shaded" | "soft";
  className?: string;
}

export function Orb({ size, glow = "shaded", className }: OrbProps) {
  const geometry = ORB_GEOMETRY[size];
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative block flex-none rounded-full bg-orb",
        geometry.size,
        glow === "soft" ? "shadow-orb-soft" : geometry.shadow,
        className,
      )}
    >
      <span className={cn("absolute bg-ink", geometry.eye, geometry.left)} />
      <span className={cn("absolute bg-ink", geometry.eye, geometry.right)} />
    </span>
  );
}
