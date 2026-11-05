/** Payments over the real PayPal sandbox, through @paypal/paypal-server-sdk. */
import {
  CheckoutPaymentIntent,
  PaypalExperienceUserAction,
  PaypalWalletContextShippingPreference,
  type ApiResponse,
  type LinkDescription,
  type Money,
} from "@paypal/paypal-server-sdk";

import { headerValue, PaypalError, unexpectedResponse, type PaymentsOperation } from "./errors";
import { CURRENCY, centsToPaypalValue, paypalValueToCents } from "./money";
import {
  PAYPAL_BRAND_NAME,
  type Authorization,
  type AuthorizationReadBack,
  type AuthorizedOrder,
  type AuthorizeOrderRequest,
  type Capture,
  type CaptureRequest,
  type CreateAuthorizeOrderRequest,
  type CreatedOrder,
  type Payments,
  type Reauthorization,
  type ReauthorizeRequest,
  type VoidRequest,
  type VoidResult,
} from "./payments";
import type { PaypalSandboxClient } from "./sandbox-client";
import {
  assertResourceId,
  isAuthorizationStatus,
  isCaptureStatus,
  validateAuthorizeOrder,
  validateCapture,
  validateCreateAuthorizeOrder,
  validateReauthorize,
  validateVoid,
} from "./validation";

/** Without it PayPal answers authorize, capture and reauthorize with ids and links only. */
const FULL_RESPONSE = "return=representation";

export class SandboxPayments implements Payments {
  readonly mode = "sandbox" as const;

  constructor(private readonly client: PaypalSandboxClient) {}

  async createAuthorizeOrder(request: CreateAuthorizeOrderRequest): Promise<CreatedOrder> {
    validateCreateAuthorizeOrder(request);
    const response = await this.client.call("createAuthorizeOrder", ({ orders }) =>
      orders.createOrder({
        body: {
          intent: CheckoutPaymentIntent.Authorize,
          purchaseUnits: [
            {
              amount: { currencyCode: CURRENCY, value: centsToPaypalValue(request.amountCents) },
              description: request.description,
              customId: request.holdId,
              softDescriptor: request.softDescriptor,
            },
          ],
          paymentSource: {
            paypal: {
              experienceContext: {
                brandName: PAYPAL_BRAND_NAME,
                shippingPreference: PaypalWalletContextShippingPreference.NoShipping,
                // CONTINUE, not PAY_NOW: the buyer approves a hold, and nothing is charged there.
                userAction: PaypalExperienceUserAction.Continue,
                returnUrl: request.returnUrl,
                cancelUrl: request.cancelUrl,
              },
            },
          },
        },
        paypalRequestId: request.idempotencyKey,
        paypalMockResponse: mockResponseHeader(request.mockIssue),
        prefer: "return=minimal",
      }),
    );
    const order = response.result;
    const debugId = debugIdOf(response);
    // Orders that carry payment_source.paypal answer PAYER_ACTION_REQUIRED with a payer-action link.
    const payerActionUrl = linkHref(order.links, "payer-action") ?? linkHref(order.links, "approve");
    if (!order.id || !payerActionUrl) {
      throw unexpectedResponse("createAuthorizeOrder", "no order id or payer-action link", debugId);
    }
    return { orderId: order.id, status: order.status ?? "UNKNOWN", payerActionUrl, debugId };
  }

  async authorizeOrder(request: AuthorizeOrderRequest): Promise<AuthorizedOrder> {
    validateAuthorizeOrder(request);
    const response = await this.client.call("authorizeOrder", ({ orders }) =>
      orders.authorizeOrder({
        id: request.orderId,
        paypalRequestId: request.idempotencyKey,
        paypalMockResponse: mockResponseHeader(request.mockIssue),
        prefer: FULL_RESPONSE,
      }),
    );
    const debugId = debugIdOf(response);
    if (response.statusCode === 202) {
      // Accepted but not finished; the same request id picks up the result later.
      throw new PaypalError({
        operation: "authorizeOrder",
        code: "ORDER_AUTHORIZATION_IN_PROGRESS",
        httpStatus: 202,
        debugId,
      });
    }
    const order = response.result;
    const authorization = order.purchaseUnits?.[0]?.payments?.authorizations?.[0];
    if (!authorization) throw unexpectedResponse("authorizeOrder", "no authorization in the order", debugId);
    const wallet = order.paymentSource?.paypal;
    return {
      orderId: order.id ?? request.orderId,
      authorization: toAuthorization("authorizeOrder", authorization, debugId),
      payer: {
        payerId: wallet?.accountId ?? order.payer?.payerId,
        email: wallet?.emailAddress ?? order.payer?.emailAddress,
        givenName: wallet?.name?.givenName ?? order.payer?.name?.givenName,
        surname: wallet?.name?.surname ?? order.payer?.name?.surname,
      },
      debugId,
      raw: rawBody(response),
    };
  }

  async getAuthorization(authorizationId: string): Promise<AuthorizationReadBack> {
    assertResourceId("authorizationId", authorizationId);
    const response = await this.client.call("getAuthorization", ({ payments }) =>
      payments.getAuthorizedPayment({ authorizationId }),
    );
    const debugId = debugIdOf(response);
    return { ...toAuthorization("getAuthorization", response.result, debugId), debugId, raw: rawBody(response) };
  }

  async capture(request: CaptureRequest): Promise<Capture> {
    validateCapture(request);
    const response = await this.client.call("capture", ({ payments }) =>
      payments.captureAuthorizedPayment({
        authorizationId: request.authorizationId,
        paypalRequestId: request.idempotencyKey,
        paypalMockResponse: mockResponseHeader(request.mockIssue),
        prefer: FULL_RESPONSE,
        body: {
          amount: { currencyCode: CURRENCY, value: centsToPaypalValue(request.amountCents) },
          invoiceId: request.invoiceId,
          // No later capture is ever made, and PayPal releases the uncaptured rest of the hold.
          finalCapture: true,
          noteToPayer: request.noteToPayer,
          softDescriptor: request.softDescriptor,
        },
      }),
    );
    const capture = response.result;
    const debugId = debugIdOf(response);
    if (!capture.id) throw unexpectedResponse("capture", "capture without an id", debugId);
    if (!isCaptureStatus(capture.status)) {
      throw unexpectedResponse("capture", `capture status ${String(capture.status)}`, debugId);
    }
    return {
      captureId: capture.id,
      status: capture.status,
      amountCents: usdCents("capture", capture.amount, debugId),
      finalCapture: capture.finalCapture ?? true,
      invoiceId: capture.invoiceId,
      createdAt: parseTime(capture.createTime),
      debugId,
      raw: rawBody(response),
    };
  }

  async void(request: VoidRequest): Promise<VoidResult> {
    validateVoid(request);
    const response = await this.client.call("void", ({ payments }) =>
      payments.voidPayment({
        authorizationId: request.authorizationId,
        paypalRequestId: request.idempotencyKey,
        paypalMockResponse: mockResponseHeader(request.mockIssue),
        prefer: FULL_RESPONSE,
      }),
    );
    const debugId = debugIdOf(response);
    // A 204 has no body; the 2xx itself says the authorization is voided.
    const authorization = response.result;
    if (!authorization) return { authorizationId: request.authorizationId, status: "VOIDED", debugId };
    if (!isAuthorizationStatus(authorization.status)) {
      throw unexpectedResponse("void", `authorization status ${String(authorization.status)}`, debugId);
    }
    return { authorizationId: authorization.id ?? request.authorizationId, status: authorization.status, debugId };
  }

  async reauthorize(request: ReauthorizeRequest): Promise<Reauthorization> {
    validateReauthorize(request);
    const response = await this.client.call("reauthorize", ({ payments }) =>
      payments.reauthorizePayment({
        authorizationId: request.authorizationId,
        paypalRequestId: request.idempotencyKey,
        prefer: FULL_RESPONSE,
        body: { amount: { currencyCode: CURRENCY, value: centsToPaypalValue(request.amountCents) } },
      }),
    );
    const debugId = debugIdOf(response);
    return { ...toAuthorization("reauthorize", response.result, debugId), debugId, raw: rawBody(response) };
  }
}

interface AuthorizationFields {
  id?: string;
  status?: string;
  amount?: Money;
  createTime?: string;
  expirationTime?: string;
  customId?: string;
}

function toAuthorization(
  operation: PaymentsOperation,
  source: AuthorizationFields,
  debugId: string | undefined,
): Authorization {
  if (!source.id) throw unexpectedResponse(operation, "authorization without an id", debugId);
  if (!isAuthorizationStatus(source.status)) {
    throw unexpectedResponse(operation, `authorization status ${String(source.status)}`, debugId);
  }
  return {
    authorizationId: source.id,
    status: source.status,
    amountCents: usdCents(operation, source.amount, debugId),
    createdAt: parseTime(source.createTime),
    expiresAt: parseTime(source.expirationTime),
    customId: source.customId,
  };
}

function usdCents(operation: PaymentsOperation, amount: Money | undefined, debugId: string | undefined): number {
  if (!amount) throw unexpectedResponse(operation, "no amount", debugId);
  if (amount.currencyCode !== CURRENCY) {
    throw unexpectedResponse(operation, `currency ${amount.currencyCode}`, debugId);
  }
  try {
    return paypalValueToCents(amount.value);
  } catch {
    throw unexpectedResponse(operation, `amount ${amount.value}`, debugId);
  }
}

function mockResponseHeader(issue: string | undefined): string | undefined {
  return issue === undefined ? undefined : JSON.stringify({ mock_application_codes: issue });
}

function linkHref(links: LinkDescription[] | undefined, rel: string): string | undefined {
  return links?.find((link) => link.rel === rel)?.href;
}

function debugIdOf(response: ApiResponse<unknown>): string | undefined {
  return headerValue(response.headers, "paypal-debug-id");
}

function rawBody(response: ApiResponse<unknown>): unknown {
  if (typeof response.body !== "string" || response.body.trim() === "") return null;
  try {
    return JSON.parse(response.body);
  } catch {
    return null;
  }
}

function parseTime(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? undefined : time;
}
