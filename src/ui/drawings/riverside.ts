import type { DrawingKey } from "./drawings";

/**
 * The drawings of the Riverside Shelter Gala template, by lot number: the cover first, then the
 * lot's other photos. Seeds store them as lot_photos.illustration_key.
 */
export const RIVERSIDE_LOT_DRAWINGS: Readonly<Record<number, readonly DrawingKey[]>> = {
  3: ["cabin"],
  5: ["pottery"],
  7: ["cloche", "wine-glass", "chef-hat", "menu-card"],
  9: ["wine"],
  12: ["spa-stones", "steam", "day-passes"],
  14: ["watercolor"],
  18: ["camera"],
  21: ["dog"],
};
