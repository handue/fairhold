/**
 * An event as the rows a seed inserts, before anything touches the database. Rows refer to each
 * other by paddle and lot numbers (and replay keys for bids and Glim actions); persist.ts turns
 * those into foreign keys.
 */
import { RIVERSIDE_LOT_DRAWINGS } from "@/ui/drawings/riverside";

import type { BotProfile } from "./botProfiles";
import type { BidSource, GlimActionKind, ReplayResult } from "./replay";
import type { LotCategory, TemplateLot } from "./template";
import { RIVERSIDE_LOTS } from "./template";

export type EventStatus = "live" | "closed";

export interface PlannedEvent {
  slug: string;
  name: string;
  charityName: string;
  charityEin: string;
  charityIs501c3: boolean;
  timeZone: string;
  currency: string;
  opensAt: Date;
  closesAt: Date;
  status: EventStatus;
  softDescriptor: string;
  holdPresetsCents: number[];
  holdMinCents: number;
  holdMaxCents: number;
  pickupNote: string;
  /** Relative to the site's origin; the projector's QR code prefixes it. */
  joinUrl: string;
  isDemo: boolean;
  demoExpiresAt: Date | null;
  templateKey: string;
  closedAt: Date | null;
}

export interface PlannedPaddle {
  number: number;
  firstName: string;
  lastInitial: string | null;
  isSimulated: boolean;
  botProfile: BotProfile | null;
  createdAt: Date;
}

export interface PlannedHold {
  paddleNumber: number;
  kind: "simulated";
  amountCents: number;
  status: "authorized";
  authorizedAt: Date;
  honorUntil: Date;
  expiresAt: Date;
}

export interface PlannedLot {
  number: number;
  category: LotCategory;
  title: string;
  shortTitle: string;
  donorName: string;
  description: string | null;
  estimatedValueCents: number | null;
  valueBasis: string | null;
  startingBidCents: number;
  minRaiseCents: number;
  closesAt: Date;
  status: "open" | "closed";
  currentBidCents: number | null;
  bidCount: number;
  highPaddleNumber: number | null;
  highBidSource: BidSource | null;
  winningPaddleNumber: number | null;
  winningCents: number | null;
  closedAt: Date | null;
}

export interface PlannedLotPhoto {
  lotNumber: number;
  position: number;
  isCover: boolean;
  kind: "illustration";
  illustrationKey: string;
  alt: string;
}

export interface PlannedBid {
  /** The replay's bid id, unique within the plan. */
  key: number;
  lotNumber: number;
  paddleNumber: number;
  amountCents: number;
  source: BidSource;
  createdAt: Date;
  glimActionKey: number | null;
}

export interface PlannedFavorite {
  paddleNumber: number;
  lotNumber: number;
  createdAt: Date;
}

export type GlimPlanStatus = "active" | "ended";
export type GlimPlanItemStatus = "watching" | "winning" | "at_limit" | "outbid_over_limit" | "won" | "lost";

export interface PlannedGlimPlan {
  paddleNumber: number;
  status: GlimPlanStatus;
  budgetCents: number;
  proposal: { budgetCents: number; items: { lotNumber: number; priority: number; maxCents: number }[] };
  confirmedAt: Date;
  endedAt: Date | null;
}

export interface PlannedGlimPlanItem {
  paddleNumber: number;
  lotNumber: number;
  priority: number;
  maxCents: number;
  status: GlimPlanItemStatus;
}

export interface PlannedBidLimit {
  paddleNumber: number;
  lotNumber: number;
  maxCents: number;
  owner: "glim";
  active: boolean;
  exhaustedAt: Date | null;
  /** When the limit stopped: exhausted, or its lot closed. */
  endedAt: Date | null;
  createdAt: Date;
}

export type GlimChip = "winning" | "closed" | "none";

export interface PlannedGlimAction {
  /** The replay's action id, unique within the plan. */
  key: number;
  paddleNumber: number;
  lotNumber: number | null;
  kind: GlimActionKind;
  amountCents: number | null;
  limitCents: number | null;
  holdCentsAtTime: number;
  decision: "executed";
  message: string;
  chip: GlimChip;
  /** The replay key of the bid this action answered or stopped at. */
  triggerBidKey: number | null;
  createdAt: Date;
}

export interface EventPlan {
  event: PlannedEvent;
  paddles: PlannedPaddle[];
  holds: PlannedHold[];
  lots: PlannedLot[];
  lotPhotos: PlannedLotPhoto[];
  bids: PlannedBid[];
  favorites: PlannedFavorite[];
  glimPlans: PlannedGlimPlan[];
  glimPlanItems: PlannedGlimPlanItem[];
  bidLimits: PlannedBidLimit[];
  glimActions: PlannedGlimAction[];
}

const DAY = 24 * 60 * 60 * 1_000;
// PayPal's honor period and validity for an authorization, mirrored so simulated holds age the
// same way real ones do.
const HONOR_PERIOD_MS = 3 * DAY;
const VALIDITY_MS = 29 * DAY;

export function plannedHold(paddleNumber: number, amountCents: number, authorizedAt: Date): PlannedHold {
  return {
    paddleNumber,
    kind: "simulated",
    amountCents,
    status: "authorized",
    authorizedAt,
    honorUntil: new Date(authorizedAt.getTime() + HONOR_PERIOD_MS),
    expiresAt: new Date(authorizedAt.getTime() + VALIDITY_MS),
  };
}

/** The template's lots carrying a replayed state, with close times from `closesAt`. */
export function plannedLots(state: ReplayResult, closesAt: (lot: TemplateLot) => Date): PlannedLot[] {
  return RIVERSIDE_LOTS.map((lot) => {
    const replayed = state.lots.get(lot.number);
    if (!replayed) throw new Error(`The replay has no lot ${lot.number}`);
    const closed = replayed.status === "closed";
    return {
      number: lot.number,
      category: lot.category,
      title: lot.title,
      shortTitle: lot.shortTitle,
      donorName: lot.donorName,
      description: lot.description,
      estimatedValueCents: lot.estimatedValueCents,
      valueBasis: lot.valueBasis,
      startingBidCents: lot.startingBidCents,
      minRaiseCents: lot.minRaiseCents,
      closesAt: closesAt(lot),
      status: replayed.status,
      currentBidCents: replayed.currentBidCents,
      bidCount: replayed.bidCount,
      highPaddleNumber: replayed.highPaddle,
      highBidSource: replayed.highSource,
      winningPaddleNumber: closed ? replayed.highPaddle : null,
      winningCents: closed && replayed.highPaddle !== null ? replayed.currentBidCents : null,
      closedAt: replayed.closedAt,
    };
  });
}

/** The approved line drawings as each lot's photos, cover first. Lots without one have none. */
export function plannedLotPhotos(): PlannedLotPhoto[] {
  return RIVERSIDE_LOTS.flatMap((lot) => {
    const drawings = RIVERSIDE_LOT_DRAWINGS[lot.number] ?? [];
    return drawings.map((illustrationKey, position) => ({
      lotNumber: lot.number,
      position,
      isCover: position === 0,
      kind: "illustration" as const,
      illustrationKey,
      alt: drawings.length === 1 ? lot.title : `${lot.title}, photo ${position + 1} of ${drawings.length}`,
    }));
  });
}
