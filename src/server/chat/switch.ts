/**
 * THE switch for arming Glim's autopilot from the chat. While it is false, a plan card carries
 * `autopilot: false`: Start bidding creates the plan's limits and opening bids through confirmPlan,
 * stores no mandate and arms nothing, so Glim only ever raises up to the card's maximums.
 *
 * It stays false until the user approves V1 (design/21), the card's "ON MY OWN" block, because the
 * guest's consent covers only what the card showed. To turn it on: set it to true, and draw the block
 * in src/ui/glim/cards.tsx in the same change. GLIM_AUTOPILOT=off still wins over it.
 */
import { getServerEnv } from "@/server/lib/env";

export const PLAN_CARDS_ARM_AUTOPILOT: boolean = false;

export function planCardsArmAutopilot(): boolean {
  return PLAN_CARDS_ARM_AUTOPILOT && getServerEnv().GLIM_AUTOPILOT === "on";
}
