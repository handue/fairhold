import type { DrawingKey } from "./drawings";

/**
 * The drawings of the Riverside Shelter Gala template, by lot number: the cover first, then the
 * lot's other photos. Every one of the 24 lots has a cover (design/29). Seeds store them as
 * lot_photos.illustration_key.
 */
export const RIVERSIDE_LOT_DRAWINGS: Readonly<Record<number, readonly DrawingKey[]>> = {
  1: ["puppy"],
  2: ["balloon"],
  3: ["cabin"],
  4: ["theater-ticket"],
  5: ["pottery"],
  6: ["sailboat"],
  7: ["cloche", "wine-glass", "chef-hat", "menu-card"],
  8: ["bakery-box"],
  9: ["wine"],
  10: ["wine-crate"],
  11: ["coffee"],
  12: ["spa-stones", "steam", "day-passes"],
  13: ["massage-table"],
  14: ["watercolor"],
  15: ["cooking-pot"],
  16: ["photo-print"],
  17: ["pottery-wheel"],
  18: ["camera"],
  19: ["yoga-mat"],
  20: ["grooming"],
  21: ["dog"],
  22: ["golf-flag"],
  23: ["pet-portrait"],
  24: ["shelter-pass"],
};
