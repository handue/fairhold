import { EngineError } from "./errors";
import type { EngineEvent, EnginePayload } from "./events";
import { sortedUnique } from "./ids";
import { refused, type Outcome, type Refusal } from "./refusals";
import { biddingGate, commitmentCents, minimumLimitCents, nextMinimumCents } from "./rules";
import type { ChangeSet, LotBiddingUpdate, LotClose, NewBid } from "./store";
import type {
  BidSource,
  Cents,
  ClosedLotView,
  CommitmentRow,
  HoldState,
  LimitOwner,
  LimitState,
  LimitView,
  LotState,
  LotView,
  PaddleInfo,
  PlacedBid,
} from "./types";

/**
 * More proxy bids than this in one action means a minimum raise far too small for the maxes
 * involved; the action fails instead of writing the war.
 */
export const MAX_PROXY_BIDS = 5_000;

/** What an action locked and read before deciding anything. */
export interface WorkspaceSnapshot {
  /** The lots the action may change, read under their row locks. */
  lots: readonly LotState[];
  /** Every active limit on those lots, whichever paddle owns it. */
  limits: readonly LimitState[];
  /** Authorized holds of the paddles involved, read under their row locks. */
  holds: readonly HoldState[];
  paddles: readonly PaddleInfo[];
  /** Commitment rows of the paddles involved; rows for the locked lots are recomputed here. */
  commitments: readonly CommitmentRow[];
}

export interface LimitInput {
  paddleId: string;
  lotId: string;
  maxCents: Cents;
  owner: LimitOwner;
  planItemId: string | null;
}

interface TrackedLimit {
  readonly id: string;
  readonly paddleId: string;
  readonly lotId: string;
  readonly maxCents: Cents;
  readonly owner: LimitOwner;
  readonly planItemId: string | null;
  /** Creation order: of two equal maxes, the older limit answers first. */
  readonly rank: number;
  readonly isNew: boolean;
  readonly initiallyPaused: boolean;
  paused: boolean;
  active: boolean;
  exhausted: boolean;
  raises: number;
  lastRaise: { amountCents: Cents; triggerAmountCents: Cents | null } | null;
}

/**
 * The deterministic core of the engine: every rule about bids, limits and closing, applied to a
 * locked snapshot with no I/O. Actions build one per transaction, call its methods, and persist
 * `changes()`. Refusals are decided before anything changes, so a refused action writes nothing.
 */
export class AuctionWorkspace {
  private readonly lots = new Map<string, LotState>();
  private readonly initialLeaders = new Map<string, { paddleId: string | null; amountCents: Cents | null }>();
  private readonly limits: TrackedLimit[] = [];
  private readonly holds = new Map<string, HoldState>();
  private readonly paddles = new Map<string, PaddleInfo>();
  private readonly committedOutside = new Map<string, Cents>();
  private readonly bids: NewBid[] = [];
  private readonly lotCloses: LotClose[] = [];
  /** Limit lifecycle news, in the order the action caused it. */
  private readonly limitEvents: EngineEvent[] = [];
  /** Limits that ran out or were blocked while bidding settled. */
  private readonly settleEvents: EngineEvent[] = [];
  private readonly closeEvents: EngineEvent[] = [];
  private nextRank = 0;

  constructor(
    snapshot: WorkspaceSnapshot,
    private readonly newId: () => string,
  ) {
    for (const lot of snapshot.lots) {
      this.lots.set(lot.id, { ...lot });
      this.initialLeaders.set(lot.id, { paddleId: lot.highPaddleId, amountCents: lot.currentBidCents });
    }
    const byAge = [...snapshot.limits].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    for (const limit of byAge) {
      if (!this.lots.has(limit.lotId)) continue;
      this.limits.push({
        id: limit.id,
        paddleId: limit.paddleId,
        lotId: limit.lotId,
        maxCents: limit.maxCents,
        owner: limit.owner,
        planItemId: limit.planItemId,
        rank: this.nextRank++,
        isNew: false,
        initiallyPaused: limit.paused,
        paused: limit.paused,
        active: true,
        exhausted: false,
        raises: 0,
        lastRaise: null,
      });
    }
    for (const hold of snapshot.holds) this.holds.set(hold.paddleId, hold);
    for (const paddle of snapshot.paddles) this.paddles.set(paddle.id, paddle);
    for (const row of snapshot.commitments) {
      if (this.lots.has(row.lotId)) continue;
      this.committedOutside.set(row.paddleId, (this.committedOutside.get(row.paddleId) ?? 0) + row.cents);
    }
  }

  lot(lotId: string): LotState {
    const lot = this.lots.get(lotId);
    if (!lot) throw new Error(`Lot ${lotId} is not part of this workspace`);
    return lot;
  }

  lotView(lotId: string): LotView {
    const lot = this.lot(lotId);
    return {
      id: lot.id,
      number: lot.number,
      currentBidCents: lot.currentBidCents,
      bidCount: lot.bidCount,
      highPaddleId: lot.highPaddleId,
      nextMinimumCents: nextMinimumCents(lot),
    };
  }

  isLeading(paddleId: string, lotId: string): boolean {
    return this.lot(lotId).highPaddleId === paddleId;
  }

  placedBids(): PlacedBid[] {
    return this.bids.map((bid) => ({ ...bid }));
  }

  limitView(limitId: string): LimitView {
    const limit = this.limits.find((candidate) => candidate.id === limitId);
    if (!limit) throw new Error(`Limit ${limitId} is not part of this workspace`);
    return toLimitView(limit);
  }

  /**
   * Everything the paddle has committed across its event. `leadingAt` evaluates a bid before
   * placing it: the paddle counts as leading that lot at that amount.
   */
  committedCents(paddleId: string, leadingAt?: { lotId: string; amountCents: Cents }): Cents {
    let total = this.committedOutside.get(paddleId) ?? 0;
    for (const lot of this.lots.values()) {
      total += this.commitmentOn(lot, paddleId, leadingAt?.lotId === lot.id ? leadingAt.amountCents : undefined);
    }
    return total;
  }

  /** A manual bid (guest or bot), followed by every proxy response it sets off. */
  placeBid(
    paddleId: string,
    lotId: string,
    amountCents: Cents,
    source: BidSource,
  ): Outcome<{ bid: PlacedBid }> {
    const lot = this.lot(lotId);
    const gate = biddingGate(lot);
    if (gate) return refused(gate);
    const hold = this.holds.get(paddleId);
    if (!hold) return refused({ reason: "no_hold", paddleId });
    const minimumCents = nextMinimumCents(lot);
    if (amountCents < minimumCents) {
      return refused({ reason: "below_minimum", lotId, minimumCents, amountCents });
    }
    const overspend = this.overspend(paddleId, hold, [lotId], { lotId, amountCents });
    if (overspend) return refused(overspend);

    const bid = this.recordBid(lot, paddleId, amountCents, source, null);
    this.settle(lotId);
    return { ok: true, bid: { ...bid } };
  }

  /**
   * Creates the paddle's limit on a lot, replacing any active one it has there. The caller checks
   * the hold afterwards (checkWithinHold) and then settles the lot so the new limit can bid.
   */
  setLimit(input: LimitInput): Outcome<{ limitId: string }> {
    const lot = this.lot(input.lotId);
    const gate = biddingGate(lot);
    if (gate) return refused(gate);
    if (!this.holds.has(input.paddleId)) return refused({ reason: "no_hold", paddleId: input.paddleId });
    const minimumCents = minimumLimitCents(lot, input.paddleId);
    if (input.maxCents < minimumCents) {
      return refused({ reason: "below_minimum", lotId: lot.id, minimumCents, amountCents: input.maxCents });
    }

    const previous = this.activeLimitOf(input.paddleId, lot.id);
    if (previous) previous.active = false;
    const limit: TrackedLimit = {
      ...input,
      id: this.newId(),
      rank: this.nextRank++,
      isNew: true,
      initiallyPaused: false,
      paused: false,
      active: true,
      exhausted: false,
      raises: 0,
      lastRaise: null,
    };
    this.limits.push(limit);
    this.limitEvents.push(
      this.event(lot.eventId, input.paddleId, {
        kind: "limit_set",
        ...this.limitRef(limit),
        maxCents: limit.maxCents,
        replacedLimitId: previous?.id ?? null,
      }),
    );
    return { ok: true, limitId: limit.id };
  }

  /** Null when the paddle's commitments fit its hold; otherwise the refusal, blaming `lotIds`. */
  checkWithinHold(paddleId: string, lotIds: readonly string[]): Refusal | null {
    const hold = this.holds.get(paddleId);
    if (!hold) return { reason: "no_hold", paddleId };
    return this.overspend(paddleId, hold, lotIds);
  }

  /**
   * Lets the lot's active limits answer, one minimum raise at a time, until none can: the
   * highest max answers first, the older limit on a tie. Each response gets the checks a manual
   * bid gets. Limits left below the next minimum are then exhausted, which releases their hold.
   */
  settle(lotId: string): void {
    const lot = this.lot(lotId);
    if (biddingGate(lot)) return;
    const blocked = new Set<string>();
    for (let responses = 0; ; responses += 1) {
      if (responses > MAX_PROXY_BIDS) {
        throw new EngineError("proxy_runaway", `Lot ${lot.number}: over ${MAX_PROXY_BIDS} proxy bids in one action`);
      }
      const amountCents = nextMinimumCents(lot);
      const responder = this.nextResponder(lot, amountCents, blocked);
      if (!responder) break;
      this.recordBid(lot, responder.paddleId, amountCents, responder.owner, responder);
    }
    this.exhaustOutbidLimits(lot);
  }

  /** Ends the paddle's active limit on the lot; with `owner`, only a limit of that owner. */
  removeLimit(paddleId: string, lotId: string, owner: LimitOwner | null): LimitView | null {
    const limit = this.activeLimitOf(paddleId, lotId);
    if (!limit || (owner !== null && limit.owner !== owner)) return null;
    limit.active = false;
    this.limitEvents.push(
      this.event(this.lot(lotId).eventId, paddleId, { kind: "limit_removed", ...this.limitRef(limit) }),
    );
    return toLimitView(limit);
  }

  /** Paused limits keep their hold reserved but place no bids, so resuming can never overspend. */
  pauseLimits(paddleId: string, owner: LimitOwner): string[] {
    const limits = this.limits.filter(
      (limit) => limit.active && !limit.paused && limit.paddleId === paddleId && limit.owner === owner,
    );
    for (const limit of limits) limit.paused = true;
    this.recordPauseChange(paddleId, owner, limits, "limits_paused");
    return limits.map((limit) => limit.id);
  }

  /** Unpauses the paddle's limits and lets each one answer any bid it missed while paused. */
  resumeLimits(paddleId: string, owner: LimitOwner): string[] {
    const limits = this.limits.filter(
      (limit) => limit.active && limit.paused && limit.paddleId === paddleId && limit.owner === owner,
    );
    for (const limit of limits) limit.paused = false;
    this.recordPauseChange(paddleId, owner, limits, "limits_resumed");
    for (const lotId of sortedUnique(limits.map((limit) => limit.lotId))) this.settle(lotId);
    return limits.map((limit) => limit.id);
  }

  /**
   * Closes the lot with the leading bid as the winner, and ends every limit on it. Without
   * `forced` it only closes a lot whose closes_at has passed. Already closed: null.
   */
  closeLot(
    lotId: string,
    { forced, bidderIds }: { forced: boolean; bidderIds: readonly string[] },
  ): ClosedLotView | null {
    const lot = this.lot(lotId);
    if (lot.status !== "open") return null;
    if (!forced && !lot.pastClose) return null;

    lot.status = "closed";
    lot.winningPaddleId = lot.highPaddleId;
    lot.winningCents = lot.highPaddleId === null ? null : lot.currentBidCents;
    const limitHolders: string[] = [];
    for (const limit of this.activeLimitsOn(lotId)) {
      limit.active = false;
      limitHolders.push(limit.paddleId);
    }
    this.lotCloses.push({ lotId, winningPaddleId: lot.winningPaddleId, winningCents: lot.winningCents, forced });

    const lotRef = { lotId, lotNumber: lot.number };
    this.closeEvents.push(
      this.event(lot.eventId, null, {
        kind: "lot_closed",
        ...lotRef,
        winningPaddleId: lot.winningPaddleId,
        winningPaddleNumber: lot.winningPaddleId === null ? null : this.paddleNumber(lot.winningPaddleId),
        winningCents: lot.winningCents,
        bidCount: lot.bidCount,
      }),
    );
    if (lot.winningPaddleId !== null && lot.winningCents !== null) {
      this.closeEvents.push(
        this.event(lot.eventId, lot.winningPaddleId, { kind: "lot_won", ...lotRef, amountCents: lot.winningCents }),
      );
    }
    for (const paddleId of sortedUnique([...bidderIds, ...limitHolders])) {
      if (paddleId === lot.winningPaddleId) continue;
      this.closeEvents.push(
        this.event(lot.eventId, paddleId, { kind: "lot_lost", ...lotRef, winningCents: lot.winningCents }),
      );
    }
    return {
      lotId,
      eventId: lot.eventId,
      number: lot.number,
      winningPaddleId: lot.winningPaddleId,
      winningCents: lot.winningCents,
      bidCount: lot.bidCount,
    };
  }

  /** Everything this workspace decided, for the store to write in one go. */
  changes(): ChangeSet {
    const lotIdsWithBids = sortedUnique(this.bids.map((bid) => bid.lotId));
    return {
      newLimits: this.limits
        .filter((limit) => limit.isNew)
        .map((limit) => ({
          id: limit.id,
          paddleId: limit.paddleId,
          lotId: limit.lotId,
          maxCents: limit.maxCents,
          owner: limit.owner,
          planItemId: limit.planItemId,
          active: limit.active,
          exhausted: limit.exhausted,
        })),
      endedLimits: this.limits
        .filter((limit) => !limit.isNew && !limit.active)
        .map((limit) => ({ id: limit.id, exhausted: limit.exhausted })),
      pausedLimitIds: this.limits
        .filter((limit) => !limit.isNew && limit.active && limit.paused && !limit.initiallyPaused)
        .map((limit) => limit.id),
      resumedLimitIds: this.limits
        .filter((limit) => !limit.isNew && limit.active && !limit.paused && limit.initiallyPaused)
        .map((limit) => limit.id),
      bids: this.bids.map((bid) => ({ ...bid })),
      lotUpdates: lotIdsWithBids.map((lotId) => this.biddingUpdate(lotId)),
      lotCloses: [...this.lotCloses],
      events: [
        ...this.limitEvents,
        ...lotIdsWithBids.flatMap((lotId) => this.bidEvents(lotId)),
        ...this.settleEvents,
        ...this.closeEvents,
      ],
    };
  }

  private commitmentOn(lot: LotState, paddleId: string, leadingAtCents?: Cents): Cents {
    const limitMaxCents = this.activeLimitOf(paddleId, lot.id)?.maxCents ?? null;
    if (leadingAtCents === undefined) return commitmentCents(lot, paddleId, limitMaxCents);
    return commitmentCents(
      { ...lot, highPaddleId: paddleId, currentBidCents: leadingAtCents },
      paddleId,
      limitMaxCents,
    );
  }

  private overspend(
    paddleId: string,
    hold: HoldState,
    lotIds: readonly string[],
    leadingAt?: { lotId: string; amountCents: Cents },
  ): Refusal | null {
    const totalCents = this.committedCents(paddleId, leadingAt);
    if (totalCents <= hold.amountCents) return null;
    const requiredCents = lotIds.reduce(
      (sum, lotId) =>
        sum +
        this.commitmentOn(this.lot(lotId), paddleId, leadingAt?.lotId === lotId ? leadingAt.amountCents : undefined),
      0,
    );
    const committedElsewhereCents = totalCents - requiredCents;
    const availableCents = Math.max(0, hold.amountCents - committedElsewhereCents);
    return {
      reason: "over_bidding_power",
      paddleId,
      lotIds: [...lotIds],
      holdCents: hold.amountCents,
      committedElsewhereCents,
      availableCents,
      requiredCents,
      shortfallCents: requiredCents - availableCents,
    };
  }

  private nextResponder(lot: LotState, amountCents: Cents, blocked: Set<string>): TrackedLimit | null {
    const candidates = this.activeLimitsOn(lot.id)
      .filter(
        (limit) =>
          !limit.paused &&
          !blocked.has(limit.id) &&
          limit.paddleId !== lot.highPaddleId &&
          limit.maxCents >= amountCents,
      )
      .sort((a, b) => b.maxCents - a.maxCents || a.rank - b.rank);
    for (const limit of candidates) {
      const blocker = this.responseBlocker(limit, lot, amountCents);
      if (blocker === null) return limit;
      blocked.add(limit.id);
      this.settleEvents.push(
        this.event(lot.eventId, limit.paddleId, {
          kind: "limit_blocked",
          ...this.limitRef(limit),
          reason: blocker,
          amountCents,
        }),
      );
    }
    return null;
  }

  /** A proxy response gets a manual bid's checks: an authorized hold, and the invariant after it. */
  private responseBlocker(
    limit: TrackedLimit,
    lot: LotState,
    amountCents: Cents,
  ): "no_hold" | "over_bidding_power" | null {
    const hold = this.holds.get(limit.paddleId);
    if (!hold) return "no_hold";
    const totalCents = this.committedCents(limit.paddleId, { lotId: lot.id, amountCents });
    return totalCents > hold.amountCents ? "over_bidding_power" : null;
  }

  private exhaustOutbidLimits(lot: LotState): void {
    const minimumCents = nextMinimumCents(lot);
    for (const limit of this.activeLimitsOn(lot.id)) {
      if (limit.paddleId === lot.highPaddleId || limit.maxCents >= minimumCents) continue;
      limit.active = false;
      limit.exhausted = true;
      this.settleEvents.push(
        this.event(lot.eventId, limit.paddleId, {
          kind: "limit_exhausted",
          ...this.limitRef(limit),
          limitCents: limit.maxCents,
          currentBidCents: lot.currentBidCents ?? 0,
        }),
      );
    }
  }

  private recordBid(
    lot: LotState,
    paddleId: string,
    amountCents: Cents,
    source: BidSource,
    limit: TrackedLimit | null,
  ): NewBid {
    const bid: NewBid = { id: this.newId(), lotId: lot.id, paddleId, amountCents, source, limitId: limit?.id ?? null };
    if (limit) {
      limit.raises += 1;
      limit.lastRaise = { amountCents, triggerAmountCents: lot.currentBidCents };
    }
    lot.currentBidCents = amountCents;
    lot.bidCount += 1;
    lot.highPaddleId = paddleId;
    lot.highBidSource = source;
    this.bids.push(bid);
    return bid;
  }

  private biddingUpdate(lotId: string): LotBiddingUpdate {
    const lot = this.lot(lotId);
    if (lot.currentBidCents === null || lot.highPaddleId === null || lot.highBidSource === null) {
      throw new Error(`Lot ${lotId} received bids but has no leader`);
    }
    return {
      lotId,
      currentBidCents: lot.currentBidCents,
      bidCount: lot.bidCount,
      highPaddleId: lot.highPaddleId,
      highBidSource: lot.highBidSource,
    };
  }

  /** The public bid row for the lot, then each limit's raise and each paddle that fell behind. */
  private bidEvents(lotId: string): EngineEvent[] {
    const lot = this.lot(lotId);
    const { currentBidCents, highPaddleId } = this.biddingUpdate(lotId);
    const nextMinimum = nextMinimumCents(lot);
    const lotBids = this.bids.filter((bid) => bid.lotId === lotId);
    const events: EngineEvent[] = [
      this.event(lot.eventId, null, {
        kind: "bids_placed",
        lotId,
        lotNumber: lot.number,
        bids: lotBids.map((bid) => ({
          bidId: bid.id,
          paddleId: bid.paddleId,
          paddleNumber: this.paddleNumber(bid.paddleId),
          amountCents: bid.amountCents,
          source: bid.source,
        })),
        currentBidCents,
        bidCount: lot.bidCount,
        highPaddleId,
        highPaddleNumber: this.paddleNumber(highPaddleId),
        nextMinimumCents: nextMinimum,
      }),
    ];

    for (const limit of this.limits) {
      if (limit.lotId !== lotId || limit.lastRaise === null) continue;
      events.push(
        this.event(lot.eventId, limit.paddleId, {
          kind: "limit_raised",
          ...this.limitRef(limit),
          amountCents: limit.lastRaise.amountCents,
          limitCents: limit.maxCents,
          triggerAmountCents: limit.lastRaise.triggerAmountCents,
          raises: limit.raises,
          opening: limit.isNew,
          leading: highPaddleId === limit.paddleId,
        }),
      );
    }

    const yourBids = new Map<string, Cents>();
    const initial = this.initialLeaders.get(lotId);
    if (initial?.paddleId && initial.amountCents !== null) yourBids.set(initial.paddleId, initial.amountCents);
    for (const bid of lotBids) {
      yourBids.set(bid.paddleId, Math.max(yourBids.get(bid.paddleId) ?? 0, bid.amountCents));
    }
    for (const [paddleId, yourBidCents] of yourBids) {
      if (paddleId === highPaddleId) continue;
      events.push(
        this.event(lot.eventId, paddleId, {
          kind: "outbid",
          lotId,
          lotNumber: lot.number,
          yourBidCents,
          currentBidCents,
          nextMinimumCents: nextMinimum,
        }),
      );
    }
    return events;
  }

  private recordPauseChange(
    paddleId: string,
    owner: LimitOwner,
    limits: readonly TrackedLimit[],
    kind: "limits_paused" | "limits_resumed",
  ): void {
    const first = limits[0];
    if (!first) return;
    this.limitEvents.push(
      this.event(this.lot(first.lotId).eventId, paddleId, {
        kind,
        owner,
        limitIds: limits.map((limit) => limit.id),
        lotIds: sortedUnique(limits.map((limit) => limit.lotId)),
      }),
    );
  }

  private activeLimitOf(paddleId: string, lotId: string): TrackedLimit | undefined {
    return this.limits.find((limit) => limit.active && limit.paddleId === paddleId && limit.lotId === lotId);
  }

  private activeLimitsOn(lotId: string): TrackedLimit[] {
    return this.limits.filter((limit) => limit.active && limit.lotId === lotId);
  }

  private limitRef(limit: TrackedLimit) {
    return {
      lotId: limit.lotId,
      lotNumber: this.lot(limit.lotId).number,
      limitId: limit.id,
      owner: limit.owner,
      planItemId: limit.planItemId,
    };
  }

  private paddleNumber(paddleId: string): number {
    const paddle = this.paddles.get(paddleId);
    if (!paddle) throw new Error(`Paddle ${paddleId} was not loaded into this workspace`);
    return paddle.number;
  }

  private event(eventId: string, paddleId: string | null, payload: EnginePayload): EngineEvent {
    return { eventId, paddleId, payload };
  }
}

function toLimitView(limit: TrackedLimit): LimitView {
  return {
    id: limit.id,
    paddleId: limit.paddleId,
    lotId: limit.lotId,
    maxCents: limit.maxCents,
    owner: limit.owner,
    planItemId: limit.planItemId,
    active: limit.active,
  };
}
