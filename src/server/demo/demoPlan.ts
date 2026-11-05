/**
 * A private demo gala: the story up to 8:58 PM, moved to start now, on a 25-minute schedule.
 * The creator gets paddle 142 with no hold yet; 85 simulated guests hold theirs and have placed
 * the opening bids. Their Glim bids become plain bot bids, because a demo starts without Glim
 * plans: only the creator's own plan, once confirmed, may answer bids for them.
 */
import { deriveBotProfiles } from "./botProfiles";
import { MINUTE, HOUR, DEMO_ANCHOR, STORY_CLOSES_AT, STORY_OPENS_AT } from "./storyClock";
import type { EventPlan, PlannedPaddle } from "./plan";
import { plannedHold, plannedLotPhotos, plannedLots } from "./plan";
import { replayAuction } from "./replay";
import { SIMULATED_GUESTS } from "./roster";
import { DEMO_LENGTH_MS, demoLotCloseOffsetMs } from "./schedule";
import { riversideStory } from "./story";
import { CREATOR_PADDLE_NUMBER, RIVERSIDE_EVENT, TEMPLATE_KEY } from "./template";

export const DEMO_LIFETIME_MS = 6 * HOUR;

export interface DemoCreator {
  firstName: string;
  lastInitial: string | null;
}

export interface DemoPlanInput {
  now: Date;
  slug: string;
  /** An IANA zone, already validated. */
  timeZone: string;
  creator: DemoCreator;
}

export function buildDemoEventPlan({ now, slug, timeZone, creator }: DemoPlanInput): EventPlan {
  const script = riversideStory({ withJamie: false });
  const opening = replayAuction(script, DEMO_ANCHOR);
  const evening = replayAuction(script, STORY_CLOSES_AT);
  const shift = (storyTime: Date) => new Date(now.getTime() + (storyTime.getTime() - DEMO_ANCHOR.getTime()));

  const lots = plannedLots(opening, (lot) => new Date(now.getTime() + demoLotCloseOffsetMs(lot.number)));
  if (lots.some((lot) => lot.status !== "open")) throw new Error("A demo must open with every lot open");
  for (const lot of lots) if (lot.highBidSource === "glim") lot.highBidSource = "bot";

  const simulatedNumbers = new Set(SIMULATED_GUESTS.map((guest) => guest.number));
  const profiles = deriveBotProfiles(script, evening, simulatedNumbers);
  const holdTimes = new Map(script.paddles.map((paddle) => [paddle.number, shift(paddle.holdAuthorizedAt)]));
  const holdTime = (number: number) => {
    const at = holdTimes.get(number);
    if (!at) throw new Error(`Paddle ${number} has no hold time in the story`);
    return at;
  };

  const simulated: PlannedPaddle[] = SIMULATED_GUESTS.map((guest) => ({
    number: guest.number,
    firstName: guest.firstName,
    lastInitial: guest.lastInitial,
    isSimulated: true,
    botProfile: profiles.get(guest.number) ?? null,
    createdAt: new Date(holdTime(guest.number).getTime() - MINUTE),
  }));
  const creatorPaddle: PlannedPaddle = {
    number: CREATOR_PADDLE_NUMBER,
    firstName: creator.firstName,
    lastInitial: creator.lastInitial,
    isSimulated: false,
    botProfile: null,
    createdAt: now,
  };

  return {
    event: {
      slug,
      name: RIVERSIDE_EVENT.name,
      charityName: RIVERSIDE_EVENT.charityName,
      charityEin: RIVERSIDE_EVENT.charityEin,
      charityIs501c3: RIVERSIDE_EVENT.charityIs501c3,
      timeZone,
      currency: RIVERSIDE_EVENT.currency,
      opensAt: shift(STORY_OPENS_AT),
      closesAt: new Date(now.getTime() + DEMO_LENGTH_MS),
      status: "live",
      softDescriptor: RIVERSIDE_EVENT.softDescriptor,
      holdPresetsCents: [...RIVERSIDE_EVENT.holdPresetsCents],
      holdMinCents: RIVERSIDE_EVENT.holdMinCents,
      holdMaxCents: RIVERSIDE_EVENT.holdMaxCents,
      pickupNote: RIVERSIDE_EVENT.pickupNote,
      joinUrl: `/e/${slug}`,
      isDemo: true,
      demoExpiresAt: new Date(now.getTime() + DEMO_LIFETIME_MS),
      templateKey: TEMPLATE_KEY,
      closedAt: null,
    },
    paddles: [...simulated, creatorPaddle],
    holds: SIMULATED_GUESTS.map((guest) => plannedHold(guest.number, guest.holdCents, holdTime(guest.number))),
    lots,
    lotPhotos: plannedLotPhotos(),
    bids: opening.bids.map((bid) => ({
      key: bid.id,
      lotNumber: bid.lot,
      paddleNumber: bid.paddle,
      amountCents: bid.amountCents,
      source: "bot",
      createdAt: shift(bid.at),
      glimActionKey: null,
    })),
    favorites: [],
    glimPlans: [],
    glimPlanItems: [],
    bidLimits: [],
    glimActions: [],
  };
}
