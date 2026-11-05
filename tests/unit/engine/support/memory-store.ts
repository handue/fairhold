/**
 * An in-memory EngineStore with the Postgres store's semantics: each transaction works on a copy
 * of the state and replaces it on success, the clock advances one millisecond per transaction,
 * and the database constraints the engine relies on throw here too. The property tests drive
 * the real actions through it; the integration tests check it against Postgres command by command.
 */
import { commitmentCents } from "@/server/engine/rules";
import type { ChangeSet, EngineStore, EngineTx, LotBidder, LotRef } from "@/server/engine/store";
import { toEventLogEntry } from "@/server/engine/events";
import type {
  BidSource,
  Cents,
  CommitmentRow,
  EventStatus,
  HoldState,
  LimitOwner,
  LimitState,
  LotState,
  LotStatus,
  PaddleInfo,
} from "@/server/engine/types";
import type { EventLogEntry } from "@/server/sse/notify";

export interface MemoryEvent {
  id: string;
  status: EventStatus;
  closedAt: number | null;
}

export interface MemoryLot {
  id: string;
  eventId: string;
  number: number;
  status: LotStatus;
  startingBidCents: Cents;
  minRaiseCents: Cents;
  currentBidCents: Cents | null;
  bidCount: number;
  highPaddleId: string | null;
  highBidSource: BidSource | null;
  closesAt: number;
  winningPaddleId: string | null;
  winningCents: Cents | null;
  closedAt: number | null;
}

export interface MemoryHold {
  id: string;
  paddleId: string;
  amountCents: Cents;
  status: "authorized" | "replaced" | "voided";
}

export interface MemoryLimit {
  id: string;
  paddleId: string;
  lotId: string;
  maxCents: Cents;
  owner: LimitOwner;
  planItemId: string | null;
  active: boolean;
  pausedAt: number | null;
  exhaustedAt: number | null;
  endedAt: number | null;
  createdAt: number;
}

export interface MemoryBid {
  id: string;
  lotId: string;
  paddleId: string;
  amountCents: Cents;
  source: BidSource;
  limitId: string | null;
  createdAt: number;
}

export interface MemoryLogRow extends EventLogEntry {
  id: number;
  createdAt: number;
}

export interface MemoryState {
  clock: number;
  events: Map<string, MemoryEvent>;
  paddles: Map<string, PaddleInfo>;
  lots: Map<string, MemoryLot>;
  holds: Map<string, MemoryHold>;
  limits: Map<string, MemoryLimit>;
  bids: MemoryBid[];
  eventLog: MemoryLogRow[];
}

export class MemoryEngineStore implements EngineStore {
  state: MemoryState = {
    clock: Date.UTC(2026, 10, 7, 4, 0, 0),
    events: new Map(),
    paddles: new Map(),
    lots: new Map(),
    holds: new Map(),
    limits: new Map(),
    bids: [],
    eventLog: [],
  };
  private nextId = 1;

  /** Ids sort in creation order, like the timestamps they are created with. */
  newId(): string {
    return `m${String(this.nextId++).padStart(8, "0")}`;
  }

  async transaction<T>(work: (tx: EngineTx) => Promise<T>): Promise<T> {
    const draft = structuredClone(this.state);
    draft.clock += 1;
    const result = await work(new MemoryTx(draft, () => this.newId()));
    this.state = draft;
    return result;
  }

  /** A setup or test-only change, applied as its own transaction with that transaction's clock. */
  mutate(change: (state: MemoryState, now: number) => void): void {
    const draft = structuredClone(this.state);
    draft.clock += 1;
    change(draft, draft.clock);
    this.state = draft;
  }

  addEvent(status: EventStatus = "live"): string {
    const id = this.newId();
    this.mutate((state) => state.events.set(id, { id, status, closedAt: null }));
    return id;
  }

  addPaddle(eventId: string, number: number): string {
    const id = this.newId();
    this.mutate((state) => state.paddles.set(id, { id, eventId, number }));
    return id;
  }

  addHold(paddleId: string, amountCents: Cents): string {
    const id = this.newId();
    this.mutate((state) => {
      for (const hold of state.holds.values()) {
        if (hold.paddleId === paddleId && hold.status === "authorized") hold.status = "replaced";
      }
      state.holds.set(id, { id, paddleId, amountCents, status: "authorized" });
    });
    return id;
  }

  addLot(
    eventId: string,
    lot: Pick<MemoryLot, "number" | "startingBidCents" | "minRaiseCents"> & {
      closesInMs?: number;
      status?: LotStatus;
    },
  ): string {
    const id = this.newId();
    this.mutate((state, now) =>
      state.lots.set(id, {
        id,
        eventId,
        number: lot.number,
        status: lot.status ?? "open",
        startingBidCents: lot.startingBidCents,
        minRaiseCents: lot.minRaiseCents,
        currentBidCents: null,
        bidCount: 0,
        highPaddleId: null,
        highBidSource: null,
        closesAt: now + (lot.closesInMs ?? 60 * 60 * 1000),
        winningPaddleId: null,
        winningCents: null,
        closedAt: null,
      }),
    );
    return id;
  }

  /** "Close next lot": closes_at becomes this moment, so every later transaction is past it. */
  expireLot(lotId: string): void {
    this.mutate((state, now) => {
      const lot = state.lots.get(lotId);
      if (lot && now < lot.closesAt) lot.closesAt = now;
    });
  }
}

class MemoryTx implements EngineTx {
  constructor(
    private readonly state: MemoryState,
    private readonly makeId: () => string,
  ) {}

  private get now(): number {
    return this.state.clock;
  }

  newId(): string {
    return this.makeId();
  }

  async findPaddles(paddleIds: readonly string[]): Promise<PaddleInfo[]> {
    return paddleIds.flatMap((id) => {
      const paddle = this.state.paddles.get(id);
      return paddle ? [{ ...paddle }] : [];
    });
  }

  async lockLots(lotIds: readonly string[]): Promise<LotState[]> {
    return [...new Set(lotIds)]
      .sort()
      .flatMap((id) => {
        const lot = this.state.lots.get(id);
        if (!lot) return [];
        const event = this.requireEvent(lot.eventId);
        return [
          {
            ...lot,
            eventStatus: event.status,
            closesAt: new Date(lot.closesAt),
            pastClose: this.now >= lot.closesAt,
            closedAt: lot.closedAt === null ? null : new Date(lot.closedAt),
          },
        ];
      });
  }

  async activeLimitsOnLots(lotIds: readonly string[]): Promise<LimitState[]> {
    const wanted = new Set(lotIds);
    return [...this.state.limits.values()]
      .filter((limit) => limit.active && wanted.has(limit.lotId))
      .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
      .map((limit) => ({
        id: limit.id,
        paddleId: limit.paddleId,
        lotId: limit.lotId,
        maxCents: limit.maxCents,
        owner: limit.owner,
        planItemId: limit.planItemId,
        paused: limit.pausedAt !== null,
        createdAt: new Date(limit.createdAt),
      }));
  }

  async activeLimitLotIds(paddleId: string, owner: LimitOwner | null): Promise<string[]> {
    return [...this.state.limits.values()]
      .filter((limit) => limit.active && limit.paddleId === paddleId && (owner === null || limit.owner === owner))
      .map((limit) => limit.lotId)
      .sort();
  }

  async lockAuthorizedHolds(paddleIds: readonly string[]): Promise<HoldState[]> {
    const wanted = new Set(paddleIds);
    return [...this.state.holds.values()]
      .filter((hold) => hold.status === "authorized" && wanted.has(hold.paddleId))
      .sort((a, b) => (a.paddleId < b.paddleId ? -1 : 1))
      .map((hold) => ({ id: hold.id, paddleId: hold.paddleId, amountCents: hold.amountCents }));
  }

  async commitments(paddleIds: readonly string[]): Promise<CommitmentRow[]> {
    return paddleIds.flatMap((paddleId) => commitmentsOf(this.state, paddleId));
  }

  async lotBidders(lotIds: readonly string[]): Promise<LotBidder[]> {
    const wanted = new Set(lotIds);
    const seen = new Set<string>();
    const bidders: LotBidder[] = [];
    for (const bid of this.state.bids) {
      const key = `${bid.lotId}/${bid.paddleId}`;
      if (!wanted.has(bid.lotId) || seen.has(key)) continue;
      seen.add(key);
      bidders.push({ lotId: bid.lotId, paddleId: bid.paddleId });
    }
    return bidders;
  }

  async dueLots(asOf: Date | null, limit: number): Promise<LotRef[]> {
    const cutoff = Math.min(this.now, asOf?.getTime() ?? this.now);
    return [...this.state.lots.values()]
      .filter((lot) => lot.status === "open" && lot.closesAt <= cutoff)
      .sort((a, b) => a.closesAt - b.closesAt || (a.id < b.id ? -1 : 1))
      .slice(0, limit)
      .map((lot) => ({ id: lot.id, eventId: lot.eventId }));
  }

  async liveEventsWithoutOpenLots(limit: number): Promise<string[]> {
    return [...this.state.events.values()]
      .filter((event) => {
        const lots = [...this.state.lots.values()].filter((lot) => lot.eventId === event.id);
        return event.status === "live" && lots.length > 0 && lots.every((lot) => lot.status !== "open");
      })
      .map((event) => event.id)
      .sort()
      .slice(0, limit);
  }

  async openLotIds(eventId: string): Promise<string[]> {
    return [...this.state.lots.values()]
      .filter((lot) => lot.eventId === eventId && lot.status === "open")
      .map((lot) => lot.id)
      .sort();
  }

  async closeEventIfDone(eventId: string): Promise<boolean> {
    const event = this.state.events.get(eventId);
    if (!event || event.status !== "live") return false;
    const hasOpenLots = [...this.state.lots.values()].some((lot) => lot.eventId === eventId && lot.status === "open");
    if (hasOpenLots) return false;
    event.status = "closed";
    event.closedAt = this.now;
    return true;
  }

  async apply(changes: ChangeSet): Promise<void> {
    for (const ended of changes.endedLimits) {
      const limit = this.requireLimit(ended.id);
      limit.active = false;
      limit.endedAt = this.now;
      if (ended.exhausted) limit.exhaustedAt = this.now;
    }
    for (const created of changes.newLimits) {
      if (created.active && this.activeLimit(created.paddleId, created.lotId)) {
        throw new Error("unique violation: one active limit per paddle and lot");
      }
      this.state.limits.set(created.id, {
        id: created.id,
        paddleId: created.paddleId,
        lotId: created.lotId,
        maxCents: created.maxCents,
        owner: created.owner,
        planItemId: created.planItemId,
        active: created.active,
        pausedAt: null,
        exhaustedAt: created.exhausted ? this.now : null,
        endedAt: created.active ? null : this.now,
        createdAt: this.now,
      });
    }
    for (const id of changes.pausedLimitIds) this.requireLimit(id).pausedAt = this.now;
    for (const id of changes.resumedLimitIds) this.requireLimit(id).pausedAt = null;
    for (const bid of changes.bids) {
      if (this.state.bids.some((other) => other.lotId === bid.lotId && other.amountCents === bid.amountCents)) {
        throw new Error("unique violation: one bid per lot and amount");
      }
      this.state.bids.push({ ...bid, createdAt: this.now });
    }
    for (const update of changes.lotUpdates) {
      Object.assign(this.requireLot(update.lotId), {
        currentBidCents: update.currentBidCents,
        bidCount: update.bidCount,
        highPaddleId: update.highPaddleId,
        highBidSource: update.highBidSource,
      });
    }
    for (const close of changes.lotCloses) {
      const lot = this.requireLot(close.lotId);
      lot.status = "closed";
      lot.winningPaddleId = close.winningPaddleId;
      lot.winningCents = close.winningCents;
      lot.closedAt = this.now;
      if (close.forced) lot.closesAt = Math.min(lot.closesAt, this.now);
    }
    for (const event of changes.events) {
      this.state.eventLog.push({ ...toEventLogEntry(event), id: this.state.eventLog.length + 1, createdAt: this.now });
    }
  }

  private activeLimit(paddleId: string, lotId: string): MemoryLimit | undefined {
    return [...this.state.limits.values()].find(
      (limit) => limit.active && limit.paddleId === paddleId && limit.lotId === lotId,
    );
  }

  private requireEvent(id: string): MemoryEvent {
    const event = this.state.events.get(id);
    if (!event) throw new Error(`no event ${id}`);
    return event;
  }

  private requireLot(id: string): MemoryLot {
    const lot = this.state.lots.get(id);
    if (!lot) throw new Error(`no lot ${id}`);
    return lot;
  }

  private requireLimit(id: string): MemoryLimit {
    const limit = this.state.limits.get(id);
    if (!limit) throw new Error(`no limit ${id}`);
    return limit;
  }
}

/** The memory twin of COMMITMENTS_SQL: one row per lot where the paddle has something committed. */
export function commitmentsOf(state: MemoryState, paddleId: string): CommitmentRow[] {
  const paddle = state.paddles.get(paddleId);
  if (!paddle) return [];
  const rows: CommitmentRow[] = [];
  for (const lot of state.lots.values()) {
    if (lot.eventId !== paddle.eventId) continue;
    const limit = [...state.limits.values()].find(
      (candidate) => candidate.active && candidate.paddleId === paddleId && candidate.lotId === lot.id,
    );
    if (!limit && lot.highPaddleId !== paddleId && lot.winningPaddleId !== paddleId) continue;
    rows.push({ paddleId, lotId: lot.id, cents: commitmentCents(lot, paddleId, limit?.maxCents ?? null) });
  }
  return rows;
}
