/**
 * Replays a scripted auction into the rows a seed inserts, enforcing the rules the bidding
 * engine enforces live: bids only while a lot is open, at least the next minimum, never past a
 * paddle's hold, and Glim limits answering every rival by the minimum raise up to their max.
 * A script that breaks a rule throws, so seeded data can never show a state the engine could
 * not have produced.
 *
 * Commitments are the engine's own rule (commitmentCents): on an open lot the larger of the
 * paddle's active limit and its leading bid, on a closed lot the amount it won.
 */
import { commitmentCents } from "@/server/engine/rules";

import { SECOND } from "./storyClock";

export type BidSource = "guest" | "guest_max" | "glim" | "bot";

/** Cents, or a number of minimum raises over the current bid (the starting bid counts as one). */
export type BidAmount = number | { raises: number };

export interface ReplayLotSpec {
  number: number;
  startingBidCents: number;
  minRaiseCents: number;
  closesAt: Date;
}

export interface ReplayPaddleSpec {
  number: number;
  holdCents: number;
  holdAuthorizedAt: Date;
}

export interface GlimItemSpec {
  lot: number;
  maxCents: number;
}

export type ScriptEvent =
  | { kind: "bid"; at: Date; lot: number; paddle: number; amount: BidAmount; source: "guest" | "bot" }
  /** Starts Glim for a paddle; items are in priority order. */
  | { kind: "glim_plan"; at: Date; paddle: number; items: readonly GlimItemSpec[]; openingBids: boolean }
  | { kind: "glim_bid"; at: Date; paddle: number; lot: number; amount?: BidAmount };

export interface AuctionScript {
  opensAt: Date;
  lots: readonly ReplayLotSpec[];
  paddles: readonly ReplayPaddleSpec[];
  events: readonly ScriptEvent[];
}

export interface ReplayBid {
  id: number;
  lot: number;
  paddle: number;
  amountCents: number;
  source: BidSource;
  at: Date;
  glimActionId: number | null;
}

export type GlimActionKind = "plan_started" | "bid" | "raise" | "limit_reached" | "lot_won" | "lot_lost";

export interface ReplayGlimAction {
  id: number;
  paddle: number;
  lot: number | null;
  kind: GlimActionKind;
  amountCents: number | null;
  limitCents: number | null;
  at: Date;
  /** The rival bid a raise answered, or the bid that went over the limit. */
  triggerBidId: number | null;
}

export interface ReplayLimit {
  paddle: number;
  lot: number;
  maxCents: number;
  priority: number;
  createdAt: Date;
  active: boolean;
  /** Set when a rival went past the max, so Glim stopped. */
  exhaustedAt: Date | null;
  /** Set when the lot closed with the limit still active. */
  endedAt: Date | null;
}

export interface ReplayPlan {
  paddle: number;
  confirmedAt: Date;
  items: readonly { lot: number; maxCents: number; priority: number }[];
}

export interface ReplayLotState {
  number: number;
  status: "open" | "closed";
  currentBidCents: number | null;
  bidCount: number;
  highPaddle: number | null;
  highSource: BidSource | null;
  closedAt: Date | null;
}

export interface ReplayResult {
  /** The moment the state describes. */
  at: Date;
  lots: ReadonlyMap<number, ReplayLotState>;
  bids: readonly ReplayBid[];
  glimActions: readonly ReplayGlimAction[];
  limits: readonly ReplayLimit[];
  plans: readonly ReplayPlan[];
}

export class ScriptError extends Error {
  override name = "ScriptError";
}

interface LotRuntime extends ReplayLotState {
  spec: ReplayLotSpec;
  lastBidAt: Date | null;
}

export function nextMinimumCents(lot: { currentBidCents: number | null }, spec: ReplayLotSpec): number {
  return lot.currentBidCents === null ? spec.startingBidCents : lot.currentBidCents + spec.minRaiseCents;
}

/** Replays every scripted event up to and including `until`, and closes the lots due by then. */
export function replayAuction(script: AuctionScript, until: Date): ReplayResult {
  return new AuctionReplay(script, until).run();
}

class AuctionReplay {
  private readonly lots = new Map<number, LotRuntime>();
  private readonly paddles = new Map<number, ReplayPaddleSpec>();
  private readonly bids: ReplayBid[] = [];
  private readonly glimActions: ReplayGlimAction[] = [];
  private readonly limits: ReplayLimit[] = [];
  private readonly plans: ReplayPlan[] = [];

  constructor(
    private readonly script: AuctionScript,
    private readonly until: Date,
  ) {
    for (const spec of script.lots) {
      this.lots.set(spec.number, {
        spec,
        number: spec.number,
        status: "open",
        currentBidCents: null,
        bidCount: 0,
        highPaddle: null,
        highSource: null,
        closedAt: null,
        lastBidAt: null,
      });
    }
    for (const paddle of script.paddles) this.paddles.set(paddle.number, paddle);
  }

  run(): ReplayResult {
    const events = this.script.events
      .map((event, index) => ({ event, index }))
      .sort((a, b) => a.event.at.getTime() - b.event.at.getTime() || a.index - b.index)
      .map(({ event }) => event);

    for (const event of events) {
      if (event.at > this.until) break;
      if (event.at < this.script.opensAt) {
        throw new ScriptError(`${describe(event)} comes before the event opens`);
      }
      this.closeLotsDueBy(event.at);
      this.apply(event);
    }
    this.closeLotsDueBy(this.until);

    return {
      at: this.until,
      lots: new Map([...this.lots].map(([number, lot]) => [number, lotState(lot)])),
      bids: this.bids,
      glimActions: this.glimActions,
      limits: this.limits,
      plans: this.plans,
    };
  }

  private apply(event: ScriptEvent): void {
    switch (event.kind) {
      case "bid": {
        const lot = this.openLot(event.lot, event.at, event);
        this.requireHold(event.paddle, event.at, event);
        const amount = this.resolve(lot, event.amount, event);
        const bid = this.place(lot, event.paddle, amount, event.source, event.at, null, event);
        this.answerWithLimits(lot, event.at, bid.id);
        return;
      }
      case "glim_plan": {
        this.startPlan(event);
        return;
      }
      case "glim_bid": {
        const lot = this.openLot(event.lot, event.at, event);
        const limit = this.activeLimit(event.paddle, event.lot);
        if (!limit) throw new ScriptError(`${describe(event)}: no active Glim limit on that lot`);
        const amount = this.resolve(lot, event.amount ?? { raises: 1 }, event);
        if (amount > limit.maxCents) throw new ScriptError(`${describe(event)} goes past its limit`);
        const action = this.act(event.paddle, event.lot, "bid", amount, limit.maxCents, event.at, null);
        const bid = this.place(lot, event.paddle, amount, "glim", event.at, action.id, event);
        this.answerWithLimits(lot, event.at, bid.id);
        return;
      }
    }
  }

  private startPlan(event: Extract<ScriptEvent, { kind: "glim_plan" }>): void {
    this.requireHold(event.paddle, event.at, event);
    if (this.plans.some((plan) => plan.paddle === event.paddle)) {
      throw new ScriptError(`${describe(event)}: paddle ${event.paddle} already has a plan`);
    }
    const items = event.items.map((item, index) => ({ ...item, priority: index + 1 }));
    this.plans.push({ paddle: event.paddle, confirmedAt: event.at, items });
    for (const item of items) {
      this.openLot(item.lot, event.at, event);
      this.limits.push({
        paddle: event.paddle,
        lot: item.lot,
        maxCents: item.maxCents,
        priority: item.priority,
        createdAt: event.at,
        active: true,
        exhaustedAt: null,
        endedAt: null,
      });
    }
    this.assertWithinHold(event.paddle, event);
    this.act(event.paddle, null, "plan_started", null, null, event.at, null);

    if (!event.openingBids) return;
    // confirmPlan places an opening bid wherever the paddle is not already leading.
    let tick = event.at;
    for (const item of items) {
      const lot = this.lot(item.lot);
      const amount = nextMinimumCents(lot, lot.spec);
      if (lot.highPaddle === event.paddle || amount > item.maxCents) continue;
      tick = this.nextTick(tick, event);
      const action = this.act(event.paddle, item.lot, "bid", amount, item.maxCents, tick, null);
      const bid = this.place(lot, event.paddle, amount, "glim", tick, action.id, event);
      tick = this.answerWithLimits(lot, tick, bid.id);
    }
  }

  /**
   * The engine's proxy rule: while a limit holder is outbid and its max covers the next
   * minimum, it answers one second later by exactly the minimum raise. Returns the last tick.
   */
  private answerWithLimits(lot: LotRuntime, at: Date, triggerBidId: number): Date {
    let tick = at;
    let trigger = triggerBidId;
    for (;;) {
      const next = nextMinimumCents(lot, lot.spec);
      for (const limit of this.limitsOn(lot.number)) {
        if (limit.paddle !== lot.highPaddle && limit.maxCents < next) {
          limit.active = false;
          limit.exhaustedAt = tick;
          this.act(limit.paddle, lot.number, "limit_reached", lot.currentBidCents, limit.maxCents, tick, trigger);
        }
      }
      const responder = this.limitsOn(lot.number).find(
        (limit) => limit.paddle !== lot.highPaddle && limit.maxCents >= next,
      );
      if (!responder) return tick;
      tick = this.nextTick(tick, { kind: "glim_bid", at: tick, paddle: responder.paddle, lot: lot.number });
      const action = this.act(responder.paddle, lot.number, "raise", next, responder.maxCents, tick, trigger);
      trigger = this.place(lot, responder.paddle, next, "glim", tick, action.id, null).id;
    }
  }

  private closeLotsDueBy(at: Date): void {
    const due = [...this.lots.values()]
      .filter((lot) => lot.status === "open" && lot.spec.closesAt <= at)
      .sort((a, b) => a.spec.closesAt.getTime() - b.spec.closesAt.getTime() || a.number - b.number);
    for (const lot of due) {
      const closedAt = lot.spec.closesAt;
      lot.status = "closed";
      lot.closedAt = closedAt;
      for (const limit of this.limitsOn(lot.number)) {
        limit.active = false;
        limit.endedAt = closedAt;
      }
      // Glim reports the outcome of every lot its guest bid on or planned for.
      const involved = new Set([
        ...this.bids.filter((bid) => bid.lot === lot.number).map((bid) => bid.paddle),
        ...this.limits.filter((limit) => limit.lot === lot.number).map((limit) => limit.paddle),
      ]);
      const reporting = this.plans
        .filter((plan) => plan.confirmedAt < closedAt && involved.has(plan.paddle))
        .map((plan) => plan.paddle)
        .sort((a, b) => a - b);
      for (const paddle of reporting) {
        const won = lot.highPaddle === paddle;
        this.act(paddle, lot.number, won ? "lot_won" : "lot_lost", lot.currentBidCents, null, closedAt, null);
      }
    }
  }

  private place(
    lot: LotRuntime,
    paddle: number,
    amountCents: number,
    source: BidSource,
    at: Date,
    glimActionId: number | null,
    event: ScriptEvent | null,
  ): ReplayBid {
    const where = event ? describe(event) : `Glim's raise for paddle ${paddle} on lot ${lot.number}`;
    if (at >= lot.spec.closesAt) throw new ScriptError(`${where} lands after lot ${lot.number} closed`);
    if (at > this.until) throw new ScriptError(`${where} spills past the replay's end`);
    if (lot.lastBidAt && at <= lot.lastBidAt) throw new ScriptError(`${where} is not after the lot's last bid`);
    const minimum = nextMinimumCents(lot, lot.spec);
    if (amountCents < minimum) throw new ScriptError(`${where}: ${amountCents} is below the next minimum ${minimum}`);

    const bid: ReplayBid = { id: this.bids.length + 1, lot: lot.number, paddle, amountCents, source, at, glimActionId };
    this.bids.push(bid);
    lot.currentBidCents = amountCents;
    lot.bidCount += 1;
    lot.highPaddle = paddle;
    lot.highSource = source;
    lot.lastBidAt = at;
    this.assertWithinHold(paddle, event);
    return bid;
  }

  private act(
    paddle: number,
    lot: number | null,
    kind: GlimActionKind,
    amountCents: number | null,
    limitCents: number | null,
    at: Date,
    triggerBidId: number | null,
  ): ReplayGlimAction {
    const action = { id: this.glimActions.length + 1, paddle, lot, kind, amountCents, limitCents, at, triggerBidId };
    this.glimActions.push(action);
    return action;
  }

  private commitmentCents(paddle: number): number {
    let total = 0;
    for (const lot of this.lots.values()) {
      // The engine's rule speaks paddle ids; here a paddle's number is its id.
      const leader = lot.highPaddle === null ? null : String(lot.highPaddle);
      const closed = lot.status === "closed";
      total += commitmentCents(
        {
          status: lot.status,
          highPaddleId: leader,
          currentBidCents: lot.currentBidCents,
          winningPaddleId: closed ? leader : null,
          winningCents: closed ? lot.currentBidCents : null,
        },
        String(paddle),
        this.activeLimit(paddle, lot.number)?.maxCents ?? null,
      );
    }
    return total;
  }

  private assertWithinHold(paddle: number, event: ScriptEvent | null): void {
    const hold = this.paddles.get(paddle)?.holdCents ?? 0;
    const committed = this.commitmentCents(paddle);
    if (committed > hold) {
      const where = event ? describe(event) : `a raise for paddle ${paddle}`;
      throw new ScriptError(`${where}: paddle ${paddle} would commit ${committed} of a ${hold} hold`);
    }
  }

  private requireHold(paddle: number, at: Date, event: ScriptEvent): void {
    const spec = this.paddles.get(paddle);
    if (!spec) throw new ScriptError(`${describe(event)}: paddle ${paddle} is not in the script`);
    if (spec.holdAuthorizedAt > at) throw new ScriptError(`${describe(event)}: paddle ${paddle} has no hold yet`);
  }

  private resolve(lot: LotRuntime, amount: BidAmount, event: ScriptEvent): number {
    if (typeof amount === "number") return amount;
    if (!Number.isInteger(amount.raises) || amount.raises < 1) {
      throw new ScriptError(`${describe(event)}: raises must be a positive whole number`);
    }
    return nextMinimumCents(lot, lot.spec) + (amount.raises - 1) * lot.spec.minRaiseCents;
  }

  private openLot(number: number, at: Date, event: ScriptEvent): LotRuntime {
    const lot = this.lot(number);
    if (lot.status !== "open" || at >= lot.spec.closesAt) {
      throw new ScriptError(`${describe(event)}: lot ${number} is closed`);
    }
    return lot;
  }

  private lot(number: number): LotRuntime {
    const lot = this.lots.get(number);
    if (!lot) throw new ScriptError(`Lot ${number} is not in the script`);
    return lot;
  }

  private limitsOn(lot: number): ReplayLimit[] {
    return this.limits.filter((limit) => limit.lot === lot && limit.active);
  }

  private activeLimit(paddle: number, lot: number): ReplayLimit | undefined {
    return this.limits.find((limit) => limit.paddle === paddle && limit.lot === lot && limit.active);
  }

  private nextTick(tick: Date, event: ScriptEvent): Date {
    const next = new Date(tick.getTime() + SECOND);
    if (next > this.until) throw new ScriptError(`${describe(event)}: Glim's answer spills past the replay's end`);
    return next;
  }
}

function lotState(lot: LotRuntime): ReplayLotState {
  return {
    number: lot.number,
    status: lot.status,
    currentBidCents: lot.currentBidCents,
    bidCount: lot.bidCount,
    highPaddle: lot.highPaddle,
    highSource: lot.highSource,
    closedAt: lot.closedAt,
  };
}

function describe(event: ScriptEvent): string {
  const at = event.at.toISOString();
  switch (event.kind) {
    case "bid":
      return `Bid by paddle ${event.paddle} on lot ${event.lot} at ${at}`;
    case "glim_plan":
      return `Glim plan for paddle ${event.paddle} at ${at}`;
    case "glim_bid":
      return `Glim bid for paddle ${event.paddle} on lot ${event.lot} at ${at}`;
  }
}
