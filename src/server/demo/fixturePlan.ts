/**
 * The approved Jamie state: the Riverside Shelter Gala on its own evening, as it stood at one of
 * the moments the approved screens show (see FIXTURE_MOMENTS). Times are the story's real
 * instants, so a visual check freezes the app's clock at the moment it seeded.
 */
import { deriveBotProfiles } from "./botProfiles";
import { glimChip, glimLine } from "./glimLines";
import type {
  EventPlan,
  GlimPlanItemStatus,
  PlannedGlimAction,
  PlannedGlimPlan,
  PlannedGlimPlanItem,
  PlannedPaddle,
} from "./plan";
import { plannedHold, plannedLotPhotos, plannedLots } from "./plan";
import type { ReplayResult } from "./replay";
import { replayAuction } from "./replay";
import { JAMIE, SIMULATED_GUESTS } from "./roster";
import { storyLotClosesAt } from "./schedule";
import { JAMIE_FAVORITES, riversideStory } from "./story";
import { FIXTURE_MOMENTS, MINUTE, STORY_CLOSES_AT, STORY_OPENS_AT, type FixtureMoment } from "./storyClock";
import { FIXTURE_SLUG, RIVERSIDE_EVENT, TEMPLATE_KEY, templateLot } from "./template";

export interface FixturePlanInput {
  moment: FixtureMoment;
  slug?: string;
}

export function buildFixtureEventPlan({ moment, slug = FIXTURE_SLUG }: FixturePlanInput): EventPlan {
  const at = FIXTURE_MOMENTS[moment];
  const script = riversideStory({ withJamie: true });
  const state = replayAuction(script, at);
  const evening = replayAuction(script, STORY_CLOSES_AT);
  const closed = at >= STORY_CLOSES_AT;

  const holdOf = new Map(script.paddles.map((paddle) => [paddle.number, paddle]));
  const paddleSpec = (number: number) => {
    const spec = holdOf.get(number);
    if (!spec) throw new Error(`Paddle ${number} is not in the story`);
    return spec;
  };

  const simulatedNumbers = new Set(SIMULATED_GUESTS.map((guest) => guest.number));
  const profiles = deriveBotProfiles(script, evening, simulatedNumbers);
  const guests = [...SIMULATED_GUESTS, JAMIE];
  const paddles: PlannedPaddle[] = guests.map((guest) => ({
    number: guest.number,
    firstName: guest.firstName,
    lastInitial: guest.lastInitial,
    isSimulated: simulatedNumbers.has(guest.number),
    botProfile: profiles.get(guest.number) ?? null,
    createdAt: new Date(paddleSpec(guest.number).holdAuthorizedAt.getTime() - MINUTE),
  }));

  const glimPlans: PlannedGlimPlan[] = state.plans.map((plan) => ({
    paddleNumber: plan.paddle,
    status: closed ? "ended" : "active",
    budgetCents: plan.items.reduce((sum, item) => sum + item.maxCents, 0),
    proposal: {
      budgetCents: plan.items.reduce((sum, item) => sum + item.maxCents, 0),
      items: plan.items.map((item) => ({ lotNumber: item.lot, priority: item.priority, maxCents: item.maxCents })),
    },
    confirmedAt: plan.confirmedAt,
    endedAt: closed ? STORY_CLOSES_AT : null,
  }));

  const glimPlanItems: PlannedGlimPlanItem[] = state.plans.flatMap((plan) =>
    plan.items.map((item) => ({
      paddleNumber: plan.paddle,
      lotNumber: item.lot,
      priority: item.priority,
      maxCents: item.maxCents,
      status: planItemStatus(state, plan.paddle, item.lot, item.maxCents),
    })),
  );

  return {
    event: {
      slug,
      name: RIVERSIDE_EVENT.name,
      charityName: RIVERSIDE_EVENT.charityName,
      charityEin: RIVERSIDE_EVENT.charityEin,
      charityIs501c3: RIVERSIDE_EVENT.charityIs501c3,
      timeZone: RIVERSIDE_EVENT.timeZone,
      currency: RIVERSIDE_EVENT.currency,
      opensAt: STORY_OPENS_AT,
      closesAt: STORY_CLOSES_AT,
      status: closed ? "closed" : "live",
      softDescriptor: RIVERSIDE_EVENT.softDescriptor,
      holdPresetsCents: [...RIVERSIDE_EVENT.holdPresetsCents],
      holdMinCents: RIVERSIDE_EVENT.holdMinCents,
      holdMaxCents: RIVERSIDE_EVENT.holdMaxCents,
      pickupNote: RIVERSIDE_EVENT.pickupNote,
      joinUrl: `/e/${slug}`,
      isDemo: false,
      demoExpiresAt: null,
      templateKey: TEMPLATE_KEY,
      closedAt: closed ? STORY_CLOSES_AT : null,
    },
    paddles,
    holds: guests.map((guest) => plannedHold(guest.number, guest.holdCents, paddleSpec(guest.number).holdAuthorizedAt)),
    lots: plannedLots(state, (lot) => storyLotClosesAt(lot.number)),
    lotPhotos: plannedLotPhotos(),
    bids: state.bids.map((bid) => ({
      key: bid.id,
      lotNumber: bid.lot,
      paddleNumber: bid.paddle,
      amountCents: bid.amountCents,
      source: bid.source,
      createdAt: bid.at,
      glimActionKey: bid.glimActionId,
    })),
    favorites: JAMIE_FAVORITES.filter((favorite) => favorite.at <= at).map((favorite) => ({
      paddleNumber: JAMIE.number,
      lotNumber: favorite.lot,
      createdAt: favorite.at,
    })),
    glimPlans,
    glimPlanItems,
    bidLimits: state.limits.map((limit) => ({
      paddleNumber: limit.paddle,
      lotNumber: limit.lot,
      maxCents: limit.maxCents,
      owner: "glim",
      active: limit.active,
      exhaustedAt: limit.exhaustedAt,
      endedAt: limit.exhaustedAt ?? limit.endedAt,
      createdAt: limit.createdAt,
    })),
    glimActions: plannedGlimActions(state, (number) => paddleSpec(number).holdCents),
  };
}

function planItemStatus(state: ReplayResult, paddle: number, lotNumber: number, maxCents: number): GlimPlanItemStatus {
  const lot = state.lots.get(lotNumber);
  if (!lot) throw new Error(`The replay has no lot ${lotNumber}`);
  if (lot.status === "closed") return lot.highPaddle === paddle ? "won" : "lost";
  const limit = state.limits.find((candidate) => candidate.paddle === paddle && candidate.lot === lotNumber);
  if (limit?.exhaustedAt) return "outbid_over_limit";
  if (lot.highPaddle === paddle) return lot.currentBidCents === maxCents ? "at_limit" : "winning";
  return "watching";
}

function plannedGlimActions(state: ReplayResult, holdCents: (paddle: number) => number): PlannedGlimAction[] {
  const bidAmount = new Map(state.bids.map((bid) => [bid.id, bid.amountCents]));
  const planOf = new Map(state.plans.map((plan) => [plan.paddle, plan]));
  return state.glimActions.map((action) => {
    const plan = planOf.get(action.paddle);
    const message = glimLine({
      kind: action.kind,
      amountCents: action.amountCents,
      limitCents: action.limitCents,
      triggerCents: action.triggerBidId === null ? null : (bidAmount.get(action.triggerBidId) ?? null),
      planItems: (plan?.items ?? []).map((item) => ({
        shortTitle: templateLot(item.lot).shortTitle,
        maxCents: item.maxCents,
      })),
    });
    return {
      key: action.id,
      paddleNumber: action.paddle,
      lotNumber: action.lot,
      kind: action.kind,
      amountCents: action.amountCents,
      limitCents: action.limitCents,
      holdCentsAtTime: holdCents(action.paddle),
      decision: "executed",
      message,
      chip: glimChip(action.kind),
      triggerBidKey: action.triggerBidId,
      createdAt: action.at,
    };
  });
}
