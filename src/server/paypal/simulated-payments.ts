/**
 * Deterministic, in-process payments that follow PayPal's documented rules, for the bots, CI and
 * keyless local mode. Ids derive from the idempotency keys and time from the injected clock, and
 * a repeated request id replays the stored result as PayPal does. Approval is instant: the
 * payer-action URL is the return URL itself, so keyless mode runs the real return page without a
 * PayPal window.
 *
 * State is per process. The database stays the record of every simulated hold, so a restart only
 * forgets authorizations that nothing still needs to call.
 */
import { createHash } from "node:crypto";

import { PaypalError, type PaymentsOperation } from "./errors";
import { CURRENCY, centsToPaypalValue } from "./money";
import type {
  Authorization,
  AuthorizationReadBack,
  AuthorizationStatus,
  AuthorizedOrder,
  AuthorizeOrderRequest,
  Capture,
  CaptureRequest,
  CreateAuthorizeOrderRequest,
  CreatedOrder,
  Payer,
  Payments,
  Reauthorization,
  ReauthorizeRequest,
  VoidRequest,
  VoidResult,
} from "./payments";
import {
  assertResourceId,
  validateAuthorizeOrder,
  validateCapture,
  validateCreateAuthorizeOrder,
  validateReauthorize,
  validateVoid,
} from "./validation";

const DAY_MS = 24 * 60 * 60 * 1000;
export const HONOR_PERIOD_DAYS = 3;
export const AUTHORIZATION_VALIDITY_DAYS = 29;
/** US reauthorization limit: up to 115% of the original amount, and at most $75 more. */
const REAUTHORIZE_MAX_PERCENT = 115;
const REAUTHORIZE_MAX_INCREASE_CENTS = 75_00;
/** Keeps a long-running process from growing without bound; the oldest entries go first. */
const MAX_ENTRIES = 50_000;

export const SIMULATED_PAYER: Payer = {
  payerId: "SIMULATEDBUYER",
  email: "buyer@simulated.invalid",
  givenName: "Simulated",
  surname: "Buyer",
};

interface SimulatedOrder {
  orderId: string;
  holdId: string;
  amountCents: number;
  authorizationId: string | undefined;
}

interface SimulatedAuthorization {
  id: string;
  orderId: string;
  customId: string;
  amountCents: number;
  status: AuthorizationStatus;
  createdAt: Date;
  expiresAt: Date;
  /** Set on a reauthorization: the original authorization it renews. */
  parentId: string | undefined;
}

export interface SimulatedPaypalState {
  orders: Map<string, SimulatedOrder>;
  authorizations: Map<string, SimulatedAuthorization>;
  invoiceIds: Map<string, string>;
  /** Successful results by operation and request id, replayed for a repeated PayPal-Request-Id. */
  replays: Map<string, unknown>;
}

export function createSimulatedPaypalState(): SimulatedPaypalState {
  return { orders: new Map(), authorizations: new Map(), invoiceIds: new Map(), replays: new Map() };
}

/** HTTP statuses PayPal uses for the issues a test can ask for with mockIssue. */
const MOCK_STATUS: Readonly<Record<string, number>> = {
  PREVIOUS_REQUEST_IN_PROGRESS: 409,
  INTERNAL_SERVER_ERROR: 500,
  INVALID_RESOURCE_ID: 404,
  RESOURCE_NOT_FOUND: 404,
  AUTHENTICATION_FAILURE: 401,
};

export class SimulatedPayments implements Payments {
  readonly mode = "simulated" as const;

  constructor(
    private readonly state: SimulatedPaypalState = createSimulatedPaypalState(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createAuthorizeOrder(request: CreateAuthorizeOrderRequest): Promise<CreatedOrder> {
    validateCreateAuthorizeOrder(request);
    this.failIfMocked("createAuthorizeOrder", request.mockIssue, request.idempotencyKey);
    return this.replay("createAuthorizeOrder", request.idempotencyKey, () => {
      const orderId = simulatedId("SIMO", request.idempotencyKey);
      remember(this.state.orders, orderId, {
        orderId,
        holdId: request.holdId,
        amountCents: request.amountCents,
        authorizationId: undefined,
      });
      const payerActionUrl = new URL(request.returnUrl);
      payerActionUrl.searchParams.set("token", orderId);
      payerActionUrl.searchParams.set("PayerID", SIMULATED_PAYER.payerId ?? "");
      return {
        orderId,
        status: "PAYER_ACTION_REQUIRED",
        payerActionUrl: payerActionUrl.toString(),
        debugId: simulatedDebugId("createAuthorizeOrder", request.idempotencyKey),
      };
    });
  }

  async authorizeOrder(request: AuthorizeOrderRequest): Promise<AuthorizedOrder> {
    validateAuthorizeOrder(request);
    this.failIfMocked("authorizeOrder", request.mockIssue, request.idempotencyKey);
    return this.replay("authorizeOrder", request.idempotencyKey, () => {
      const order = this.state.orders.get(request.orderId);
      if (!order) throw refusal("authorizeOrder", "INVALID_RESOURCE_ID", request.orderId, 404);
      if (order.authorizationId) throw refusal("authorizeOrder", "ORDER_ALREADY_AUTHORIZED", request.orderId);
      const createdAt = this.now();
      const authorization: SimulatedAuthorization = {
        id: simulatedId("SIMA", order.orderId),
        orderId: order.orderId,
        customId: order.holdId,
        amountCents: order.amountCents,
        status: "CREATED",
        createdAt,
        expiresAt: new Date(createdAt.getTime() + AUTHORIZATION_VALIDITY_DAYS * DAY_MS),
        parentId: undefined,
      };
      remember(this.state.authorizations, authorization.id, authorization);
      order.authorizationId = authorization.id;
      return {
        orderId: order.orderId,
        authorization: view(authorization),
        payer: { ...SIMULATED_PAYER },
        debugId: simulatedDebugId("authorizeOrder", request.idempotencyKey),
        raw: rawOrder(order, authorization),
      };
    });
  }

  async getAuthorization(authorizationId: string): Promise<AuthorizationReadBack> {
    assertResourceId("authorizationId", authorizationId);
    const authorization = this.find("getAuthorization", authorizationId);
    return {
      ...view(authorization),
      debugId: simulatedDebugId("getAuthorization", authorizationId),
      raw: rawAuthorization(authorization),
    };
  }

  async capture(request: CaptureRequest): Promise<Capture> {
    validateCapture(request);
    this.failIfMocked("capture", request.mockIssue, request.idempotencyKey);
    return this.replay("capture", request.idempotencyKey, () => {
      const authorization = this.find("capture", request.authorizationId);
      const now = this.now();
      if (authorization.status === "VOIDED") throw refusal("capture", "AUTHORIZATION_VOIDED", authorization.id);
      if (authorization.status === "CAPTURED" || authorization.status === "PARTIALLY_CAPTURED") {
        throw refusal("capture", "AUTHORIZATION_ALREADY_CAPTURED", authorization.id);
      }
      if (authorization.status !== "CREATED") throw refusal("capture", "AUTHORIZATION_DENIED", authorization.id);
      if (now.getTime() >= authorization.expiresAt.getTime()) {
        throw refusal("capture", "AUTHORIZATION_EXPIRED", authorization.id);
      }
      if (request.amountCents > authorization.amountCents) {
        throw refusal("capture", "MAX_CAPTURE_AMOUNT_EXCEEDED", authorization.id);
      }
      if (this.state.invoiceIds.has(request.invoiceId)) {
        throw refusal("capture", "DUPLICATE_INVOICE_ID", request.invoiceId);
      }
      remember(this.state.invoiceIds, request.invoiceId, authorization.id);
      // A final capture closes the authorization and releases whatever was not captured.
      authorization.status = "CAPTURED";
      const captureId = simulatedId("SIMC", `${authorization.id}:${request.idempotencyKey}`);
      return {
        captureId,
        status: "COMPLETED",
        amountCents: request.amountCents,
        finalCapture: true,
        invoiceId: request.invoiceId,
        createdAt: now,
        debugId: simulatedDebugId("capture", request.idempotencyKey),
        raw: {
          simulated: true,
          id: captureId,
          status: "COMPLETED",
          amount: { currency_code: CURRENCY, value: centsToPaypalValue(request.amountCents) },
          final_capture: true,
          invoice_id: request.invoiceId,
          create_time: now.toISOString(),
        },
      };
    });
  }

  async void(request: VoidRequest): Promise<VoidResult> {
    validateVoid(request);
    this.failIfMocked("void", request.mockIssue, request.idempotencyKey);
    return this.replay("void", request.idempotencyKey, () => {
      const authorization = this.find("void", request.authorizationId);
      if (authorization.parentId) throw refusal("void", "CANNOT_BE_VOIDED", authorization.id);
      if (authorization.status === "VOIDED") throw refusal("void", "PREVIOUSLY_VOIDED", authorization.id);
      if (authorization.status === "CAPTURED" || authorization.status === "PARTIALLY_CAPTURED") {
        throw refusal("void", "PREVIOUSLY_CAPTURED", authorization.id);
      }
      authorization.status = "VOIDED";
      // Voiding the original also releases its reauthorizations.
      for (const child of this.state.authorizations.values()) {
        if (child.parentId === authorization.id && child.status === "CREATED") child.status = "VOIDED";
      }
      return {
        authorizationId: authorization.id,
        status: "VOIDED",
        debugId: simulatedDebugId("void", request.idempotencyKey),
      };
    });
  }

  async reauthorize(request: ReauthorizeRequest): Promise<Reauthorization> {
    validateReauthorize(request);
    return this.replay("reauthorize", request.idempotencyKey, () => {
      const original = this.find("reauthorize", request.authorizationId);
      const now = this.now();
      if (original.parentId) throw refusal("reauthorize", "REAUTHORIZATION_NOT_SUPPORTED", original.id);
      if (original.status === "VOIDED") throw refusal("reauthorize", "AUTHORIZATION_VOIDED", original.id);
      if (original.status !== "CREATED") throw refusal("reauthorize", "AUTHORIZATION_ALREADY_CAPTURED", original.id);
      if (now.getTime() < original.createdAt.getTime() + HONOR_PERIOD_DAYS * DAY_MS) {
        throw refusal("reauthorize", "REAUTHORIZATION_TOO_SOON", original.id);
      }
      if (now.getTime() >= original.expiresAt.getTime()) {
        throw refusal("reauthorize", "AUTHORIZATION_EXPIRED", original.id);
      }
      const maxCents = Math.min(
        Math.floor((original.amountCents * REAUTHORIZE_MAX_PERCENT) / 100),
        original.amountCents + REAUTHORIZE_MAX_INCREASE_CENTS,
      );
      if (request.amountCents > maxCents) {
        throw refusal("reauthorize", "AUTHORIZATION_AMOUNT_EXCEEDED", original.id);
      }
      const renewed: SimulatedAuthorization = {
        id: simulatedId("SIMR", `${original.id}:${request.idempotencyKey}`),
        orderId: original.orderId,
        customId: original.customId,
        amountCents: request.amountCents,
        status: "CREATED",
        createdAt: now,
        // The 29 days run from the original authorization; a reauthorization only renews the honor period.
        expiresAt: original.expiresAt,
        parentId: original.id,
      };
      remember(this.state.authorizations, renewed.id, renewed);
      return {
        ...view(renewed),
        debugId: simulatedDebugId("reauthorize", request.idempotencyKey),
        raw: rawAuthorization(renewed),
      };
    });
  }

  private find(operation: PaymentsOperation, authorizationId: string): SimulatedAuthorization {
    const authorization = this.state.authorizations.get(authorizationId);
    if (!authorization) throw refusal(operation, "INVALID_RESOURCE_ID", authorizationId, 404);
    return authorization;
  }

  private replay<T>(operation: PaymentsOperation, idempotencyKey: string, run: () => T): T {
    const key = `${operation}:${idempotencyKey}`;
    if (this.state.replays.has(key)) return structuredClone(this.state.replays.get(key)) as T;
    const result = run();
    remember(this.state.replays, key, structuredClone(result));
    return result;
  }

  private failIfMocked(operation: PaymentsOperation, issue: string | undefined, seed: string): void {
    if (issue === undefined) return;
    const httpStatus = MOCK_STATUS[issue] ?? 422;
    throw new PaypalError({
      operation,
      code: issue,
      paypalName: httpStatus === 422 ? "UNPROCESSABLE_ENTITY" : undefined,
      httpStatus,
      debugId: simulatedDebugId(operation, `mock:${seed}`),
    });
  }
}

const processGlobal = globalThis as typeof globalThis & { __fairholdSimulatedPayments?: SimulatedPayments };

/** The process-wide simulation, shared by every route bundle Next.js builds. */
export function getSimulatedPayments(): SimulatedPayments {
  processGlobal.__fairholdSimulatedPayments ??= new SimulatedPayments();
  return processGlobal.__fairholdSimulatedPayments;
}

function refusal(
  operation: PaymentsOperation,
  code: string,
  subject: string,
  httpStatus = 422,
): PaypalError {
  return new PaypalError({
    operation,
    code,
    paypalName: httpStatus === 404 ? "RESOURCE_NOT_FOUND" : "UNPROCESSABLE_ENTITY",
    httpStatus,
    debugId: simulatedDebugId(operation, `${code}:${subject}`),
  });
}

function view(authorization: SimulatedAuthorization): Authorization {
  return {
    authorizationId: authorization.id,
    status: authorization.status,
    amountCents: authorization.amountCents,
    createdAt: new Date(authorization.createdAt),
    expiresAt: new Date(authorization.expiresAt),
    customId: authorization.customId,
  };
}

function rawAuthorization(authorization: SimulatedAuthorization): Record<string, unknown> {
  return {
    simulated: true,
    id: authorization.id,
    status: authorization.status,
    amount: { currency_code: CURRENCY, value: centsToPaypalValue(authorization.amountCents) },
    custom_id: authorization.customId,
    create_time: authorization.createdAt.toISOString(),
    expiration_time: authorization.expiresAt.toISOString(),
  };
}

function rawOrder(order: SimulatedOrder, authorization: SimulatedAuthorization): Record<string, unknown> {
  return {
    simulated: true,
    id: order.orderId,
    status: "COMPLETED",
    purchase_units: [
      { custom_id: order.holdId, payments: { authorizations: [rawAuthorization(authorization)] } },
    ],
  };
}

/** 17 characters like PayPal's own ids, e.g. SIMA3F09C1D2B7E4A. */
function simulatedId(prefix: string, seed: string): string {
  return prefix + createHash("sha256").update(seed).digest("hex").slice(0, 17 - prefix.length).toUpperCase();
}

function simulatedDebugId(operation: string, seed: string): string {
  return `sim-${createHash("sha256").update(`${operation}:${seed}`).digest("hex").slice(0, 13)}`;
}

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value);
  if (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
}
