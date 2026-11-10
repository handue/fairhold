/**
 * THE switch for arming Glim's autopilot from the chat. On, a plan card carries `autopilot: true`,
 * draws its "ON MY OWN" block (V1, design/21, approved Nov 9), and Start bidding stores the mandate
 * the block states and arms the autopilot. Off, a card carries `autopilot: false`: Start bidding
 * creates the plan's limits and opening bids, stores no mandate and arms nothing, so Glim only ever
 * raises up to the card's maximums, and the card leaves the block out.
 *
 * The block and this switch belong together: the guest's consent covers only what the card showed.
 * GLIM_AUTOPILOT=off still wins over it.
 */
import { getServerEnv } from "@/server/lib/env";

export const PLAN_CARDS_ARM_AUTOPILOT: boolean = true;

export function planCardsArmAutopilot(): boolean {
  return PLAN_CARDS_ARM_AUTOPILOT && getServerEnv().GLIM_AUTOPILOT === "on";
}
