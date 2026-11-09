/** An in-memory HoldStore with the same guarded transitions and swap rule as the Postgres one. */
import type { EventStatus } from "@/server/engine";
import {
  holdSwapRefusal,
  type HoldAuthorization,
  type HoldRecord,
  type HoldStatus,
  type HoldStore,
  type MarkAuthorizedResult,
  type PaypalErrorRecord,
} from "@/server/paypal/hold-store";

export interface StoredHold extends HoldRecord {
  authorizedAt: Date | null;
  honorUntil: Date | null;
  expiresAt: Date | null;
  replacedByHoldId: string | null;
  lastError: PaypalErrorRecord | null;
  payerEmail: string | null;
}

export class MemoryHoldStore implements HoldStore {
  readonly holds = new Map<string, StoredHold>();
  /** Lets a test change the hold between the PayPal call and the write, like a racing request. */
  beforeMarkAuthorized: (() => void) | undefined;
  /** The status of the event every hold here belongs to. */
  eventStatus: EventStatus = "live";
  /** What each paddle has committed, as the engine's COMMITMENTS_SQL would sum it. */
  readonly committedCents = new Map<string, number>();

  add(hold: Partial<StoredHold> & Pick<HoldRecord, "id" | "paddleId">): StoredHold {
    const stored: StoredHold = {
      eventId: "event-1",
      eventSlug: "riverside",
      kind: "paypal",
      status: "pending_approval",
      amountCents: 500_00,
      paypalOrderId: null,
      originalAuthorizationId: null,
      currentAuthorizationId: null,
      authorizedAt: null,
      honorUntil: null,
      expiresAt: null,
      replacedByHoldId: null,
      lastError: null,
      payerEmail: null,
      ...hold,
    };
    this.holds.set(stored.id, stored);
    return stored;
  }

  get(holdId: string): StoredHold {
    const hold = this.holds.get(holdId);
    if (!hold) throw new Error(`no hold ${holdId}`);
    return hold;
  }

  async findHold(holdId: string): Promise<HoldRecord | null> {
    const hold = this.holds.get(holdId);
    return hold ? { ...hold } : null;
  }

  async markAuthorized(holdId: string, authorization: HoldAuthorization): Promise<MarkAuthorizedResult> {
    this.beforeMarkAuthorized?.();
    const hold = this.holds.get(holdId);
    if (!hold) return { kind: "not_pending", status: null };
    if (hold.status !== "pending_approval") {
      const status = hold.status;
      if (status === "canceled" || status === "denied" || status === "failed") {
        Object.assign(hold, {
          status: "replaced" satisfies HoldStatus,
          replacedByHoldId: null,
          amountCents: authorization.amountCents,
          originalAuthorizationId: authorization.authorizationId,
          currentAuthorizationId: authorization.authorizationId,
        });
      }
      return { kind: "not_pending", status };
    }
    const current = [...this.holds.values()].find(
      (other) => other.paddleId === hold.paddleId && other.status === "authorized" && other.id !== holdId,
    );
    const refusal = holdSwapRefusal({
      eventStatus: this.eventStatus,
      amountCents: authorization.amountCents,
      currentHoldCents: current?.amountCents ?? null,
      committedCents: this.committedCents.get(hold.paddleId) ?? 0,
    });
    if (current && !refusal) {
      current.status = "replaced";
      current.replacedByHoldId = holdId;
    }
    Object.assign(hold, {
      status: (refusal ? "replaced" : "authorized") satisfies HoldStatus,
      replacedByHoldId: refusal ? (current?.id ?? null) : null,
      amountCents: authorization.amountCents,
      originalAuthorizationId: authorization.authorizationId,
      currentAuthorizationId: authorization.authorizationId,
      authorizedAt: authorization.authorizedAt,
      honorUntil: authorization.honorUntil,
      expiresAt: authorization.expiresAt,
      lastError: null,
      payerEmail: refusal ? hold.payerEmail : (authorization.payer.email ?? null),
    });
    if (refusal) return { kind: "refused", refusal };
    return {
      kind: "authorized",
      replaced: current
        ? { id: current.id, kind: current.kind, originalAuthorizationId: current.originalAuthorizationId }
        : null,
    };
  }

  async markApprovalFailed(holdId: string, status: "denied" | "failed", error: PaypalErrorRecord): Promise<boolean> {
    const hold = this.holds.get(holdId);
    if (hold?.status !== "pending_approval") return false;
    hold.status = status;
    hold.lastError = error;
    return true;
  }

  async markCanceled(holdId: string): Promise<boolean> {
    const hold = this.holds.get(holdId);
    if (hold?.status !== "pending_approval") return false;
    hold.status = "canceled";
    return true;
  }

  async markReplacedVoided(holdId: string): Promise<void> {
    const hold = this.holds.get(holdId);
    if (hold?.status === "replaced") hold.status = "voided";
  }

  async recordPaypalError(holdId: string, error: PaypalErrorRecord): Promise<void> {
    const hold = this.holds.get(holdId);
    if (hold) hold.lastError = error;
  }
}
