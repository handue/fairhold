import { inspect } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PaypalError } from "@/server/paypal/errors";
import { paypalRequestId } from "@/server/paypal/idempotency";
import type { CaptureRequest, CreateAuthorizeOrderRequest } from "@/server/paypal/payments";
import { PaypalSandboxClient } from "@/server/paypal/sandbox-client";
import { SandboxPayments } from "@/server/paypal/sandbox-payments";

import {
  authorizationBody,
  bodyOf,
  empty,
  FakePaypal,
  json,
  paypalError,
  TOKEN_LIFETIME_SECONDS,
} from "./fake-paypal";

const API = "https://api-m.sandbox.paypal.com";

const orderRequest: CreateAuthorizeOrderRequest = {
  holdId: "hold-1",
  amountCents: 500_00,
  description: "Bidding power for Riverside Shelter Gala",
  softDescriptor: "RIVERSIDEGALA",
  returnUrl: "https://fairhold.example/paypal/return?hold=hold-1",
  cancelUrl: "https://fairhold.example/paypal/cancel?hold=hold-1",
  idempotencyKey: paypalRequestId("create-order", "hold-1"),
};

const captureRequest: CaptureRequest = {
  authorizationId: "AUTH1",
  amountCents: 320_00,
  invoiceId: "FH-event-1-142",
  softDescriptor: "RIVERSIDEGALA",
  noteToPayer: "Thank you for supporting Riverside Shelter.",
  idempotencyKey: paypalRequestId("capture", "item-1"),
};

function setup() {
  const paypal = new FakePaypal();
  const client = new PaypalSandboxClient({ clientId: "test-client", clientSecret: "test-secret", http: paypal.http });
  return { paypal, client, payments: new SandboxPayments(client) };
}

function createdOrderResponse() {
  return json(200, {
    id: "ORDER1",
    status: "PAYER_ACTION_REQUIRED",
    links: [
      { href: `${API}/v2/checkout/orders/ORDER1`, rel: "self", method: "GET" },
      { href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1", rel: "payer-action", method: "GET" },
    ],
  });
}

async function caught(promise: Promise<unknown>): Promise<PaypalError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PaypalError);
    return error as PaypalError;
  }
  throw new Error("expected a PaypalError");
}

describe("SandboxPayments request shapes", () => {
  it("creates an AUTHORIZE order for one whole-dollar purchase unit and returns the payer-action URL", async () => {
    const { paypal, payments } = setup();
    paypal.on("POST", "/v2/checkout/orders", createdOrderResponse);

    const order = await payments.createAuthorizeOrder(orderRequest);

    expect(order).toEqual({
      orderId: "ORDER1",
      status: "PAYER_ACTION_REQUIRED",
      payerActionUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1",
      debugId: "debug-200",
    });
    const request = paypal.lastRequest("/v2/checkout/orders");
    expect(request.method).toBe("POST");
    expect(request.url).toBe(`${API}/v2/checkout/orders`);
    expect(request.headers["paypal-request-id"]).toBe(orderRequest.idempotencyKey);
    expect(request.headers.authorization).toBe("Bearer token-1");
    expect(request.headers["content-type"]).toBe("application/json");
    expect(bodyOf(request)).toEqual({
      intent: "AUTHORIZE",
      purchase_units: [
        {
          amount: { currency_code: "USD", value: "500.00" },
          description: "Bidding power for Riverside Shelter Gala",
          custom_id: "hold-1",
          soft_descriptor: "RIVERSIDEGALA",
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: "Fairhold",
            shipping_preference: "NO_SHIPPING",
            user_action: "CONTINUE",
            return_url: orderRequest.returnUrl,
            cancel_url: orderRequest.cancelUrl,
          },
        },
      },
    });
  });

  it("refuses holds PayPal would reject or truncate before any request is sent", async () => {
    const { paypal, payments } = setup();
    await expect(payments.createAuthorizeOrder({ ...orderRequest, amountCents: 500_50 })).rejects.toThrow(/whole dollars/);
    await expect(payments.createAuthorizeOrder({ ...orderRequest, amountCents: 0 })).rejects.toThrow(RangeError);
    await expect(
      payments.createAuthorizeOrder({ ...orderRequest, softDescriptor: "RIVERSIDE SHELTER GALA 2026" }),
    ).rejects.toThrow(/softDescriptor/);
    await expect(payments.createAuthorizeOrder({ ...orderRequest, description: "x".repeat(128) })).rejects.toThrow(
      /description/,
    );
    await expect(payments.createAuthorizeOrder({ ...orderRequest, idempotencyKey: "k".repeat(39) })).rejects.toThrow(
      /PayPal-Request-Id/,
    );
    await expect(payments.createAuthorizeOrder({ ...orderRequest, returnUrl: "/paypal/return" })).rejects.toThrow(
      /returnUrl/,
    );
    expect(paypal.requests).toHaveLength(0);
  });

  it("authorizes an approved order and reads the authorization, expiry and payer", async () => {
    const { paypal, payments } = setup();
    const response = {
      id: "ORDER1",
      status: "COMPLETED",
      payment_source: {
        paypal: { email_address: "buyer-1@example.com", account_id: "PAYER1", name: { given_name: "Jamie", surname: "K" } },
      },
      purchase_units: [{ reference_id: "default", payments: { authorizations: [authorizationBody("AUTH1", "CREATED", "500.00")] } }],
    };
    paypal.on("POST", "/v2/checkout/orders/ORDER1/authorize", () => json(201, response));

    const authorized = await payments.authorizeOrder({
      orderId: "ORDER1",
      idempotencyKey: paypalRequestId("authorize-order", "hold-1"),
    });

    expect(authorized.authorization).toEqual({
      authorizationId: "AUTH1",
      status: "CREATED",
      amountCents: 500_00,
      createdAt: new Date("2026-11-04T21:00:00Z"),
      expiresAt: new Date("2026-12-03T21:00:00Z"),
      customId: "hold-1",
    });
    expect(authorized.payer).toEqual({ payerId: "PAYER1", email: "buyer-1@example.com", givenName: "Jamie", surname: "K" });
    expect(authorized.raw).toEqual(response);
    const request = paypal.lastRequest("/v2/checkout/orders/ORDER1/authorize");
    expect(request.headers["paypal-request-id"]).toBe(paypalRequestId("authorize-order", "hold-1"));
    expect(request.headers.prefer).toBe("return=representation");
  });

  it("captures the won total with final_capture and the settlement fields", async () => {
    const { paypal, payments } = setup();
    paypal.on("POST", "/v2/payments/authorizations/AUTH1/capture", () =>
      json(201, {
        id: "CAPTURE1",
        status: "COMPLETED",
        amount: { currency_code: "USD", value: "320.00" },
        final_capture: true,
        invoice_id: "FH-event-1-142",
        create_time: "2026-11-04T22:00:00Z",
      }),
    );

    const capture = await payments.capture(captureRequest);

    expect(capture).toMatchObject({
      captureId: "CAPTURE1",
      status: "COMPLETED",
      amountCents: 320_00,
      finalCapture: true,
      invoiceId: "FH-event-1-142",
      createdAt: new Date("2026-11-04T22:00:00Z"),
      debugId: "debug-201",
    });
    const request = paypal.lastRequest("/v2/payments/authorizations/AUTH1/capture");
    expect(request.headers["paypal-request-id"]).toBe(captureRequest.idempotencyKey);
    expect(request.headers.prefer).toBe("return=representation");
    expect(request.headers["paypal-mock-response"]).toBeUndefined();
    expect(bodyOf(request)).toEqual({
      amount: { currency_code: "USD", value: "320.00" },
      invoice_id: "FH-event-1-142",
      final_capture: true,
      note_to_payer: "Thank you for supporting Riverside Shelter.",
      soft_descriptor: "RIVERSIDEGALA",
    });
  });

  it("sends PayPal-Mock-Response for sandbox negative testing", async () => {
    const { paypal, payments } = setup();
    paypal.on("POST", "/v2/payments/authorizations/AUTH1/capture", () =>
      paypalError(422, "UNPROCESSABLE_ENTITY", "INSTRUMENT_DECLINED", "debug-mock"),
    );

    await caught(payments.capture({ ...captureRequest, mockIssue: "INSTRUMENT_DECLINED" }));

    const request = paypal.lastRequest("/v2/payments/authorizations/AUTH1/capture");
    expect(request.headers["paypal-mock-response"]).toBe('{"mock_application_codes":"INSTRUMENT_DECLINED"}');
  });

  it("voids an authorization by id, as JSON, with or without a response body", async () => {
    const { paypal, payments } = setup();
    paypal.on("POST", "/v2/payments/authorizations/AUTH1/void", () => empty(204));
    const key = paypalRequestId("void", "hold-1");

    await expect(payments.void({ authorizationId: "AUTH1", idempotencyKey: key })).resolves.toEqual({
      authorizationId: "AUTH1",
      status: "VOIDED",
      debugId: "debug-204",
    });
    const request = paypal.lastRequest("/v2/payments/authorizations/AUTH1/void");
    expect(request.headers["paypal-request-id"]).toBe(key);
    // Axios would label a bodiless POST as a form post; PayPal documents void as JSON.
    expect(request.headers["content-type"]).toBe("application/json");

    paypal.on("POST", "/v2/payments/authorizations/AUTH1/void", () => json(200, authorizationBody("AUTH1", "VOIDED", "500.00")));
    await expect(payments.void({ authorizationId: "AUTH1", idempotencyKey: key })).resolves.toMatchObject({
      status: "VOIDED",
    });
  });

  it("reauthorizes on the original id and returns the new authorization", async () => {
    const { paypal, payments } = setup();
    paypal.on("POST", "/v2/payments/authorizations/ORIGINAL1/reauthorize", () =>
      json(201, authorizationBody("RENEWED1", "CREATED", "500.00", { create_time: "2026-11-08T21:00:00Z" })),
    );

    const renewed = await payments.reauthorize({
      authorizationId: "ORIGINAL1",
      amountCents: 500_00,
      idempotencyKey: paypalRequestId("reauthorize", "hold-1"),
    });

    expect(renewed).toMatchObject({ authorizationId: "RENEWED1", status: "CREATED", amountCents: 500_00 });
    const request = paypal.lastRequest("/v2/payments/authorizations/ORIGINAL1/reauthorize");
    expect(request.headers["paypal-request-id"]).toBe(paypalRequestId("reauthorize", "hold-1"));
    expect(bodyOf(request)).toEqual({ amount: { currency_code: "USD", value: "500.00" } });
  });

  it("reads an authorization back", async () => {
    const { paypal, payments } = setup();
    paypal.on("GET", "/v2/payments/authorizations/AUTH1", () => json(200, authorizationBody("AUTH1", "PARTIALLY_CAPTURED", "500.00")));

    await expect(payments.getAuthorization("AUTH1")).resolves.toMatchObject({
      authorizationId: "AUTH1",
      status: "PARTIALLY_CAPTURED",
      amountCents: 500_00,
    });
    expect(paypal.lastRequest("/v2/payments/authorizations/AUTH1").method).toBe("GET");
  });

  it("puts a PayPal-Request-Id on every payments POST", async () => {
    const { paypal, payments } = setup();
    paypal
      .on("POST", "/v2/checkout/orders", createdOrderResponse)
      .on("POST", "/v2/payments/authorizations/AUTH1/void", () => empty(204))
      .on("POST", "/v2/payments/authorizations/AUTH1/capture", () =>
        json(201, { id: "C", status: "COMPLETED", amount: { currency_code: "USD", value: "320.00" } }),
      );

    await payments.createAuthorizeOrder(orderRequest);
    await payments.capture(captureRequest);
    await payments.void({ authorizationId: "AUTH1", idempotencyKey: paypalRequestId("void", "hold-1") });

    const posts = paypal.apiRequests().filter((request) => request.method === "POST");
    expect(posts).toHaveLength(3);
    for (const post of posts) expect(post.headers["paypal-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("SandboxPayments errors", () => {
  it.each([
    ["capture", 422, "UNPROCESSABLE_ENTITY", "INSTRUMENT_DECLINED", false],
    ["capture", 422, "UNPROCESSABLE_ENTITY", "AUTHORIZATION_EXPIRED", false],
    ["capture", 409, "RESOURCE_CONFLICT", "PREVIOUS_REQUEST_IN_PROGRESS", true],
    ["void", 422, "UNPROCESSABLE_ENTITY", "CANNOT_BE_VOIDED", false],
    ["void", 422, "UNPROCESSABLE_ENTITY", "PREVIOUSLY_VOIDED", false],
    ["reauthorize", 422, "UNPROCESSABLE_ENTITY", "REAUTHORIZATION_NOT_SUPPORTED", false],
    ["reauthorize", 422, "UNPROCESSABLE_ENTITY", "REAUTHORIZATION_TOO_SOON", false],
  ] as const)("maps %s %i %s/%s to a typed error with its debug_id", async (operation, status, name, issue, retryable) => {
    const { paypal, payments } = setup();
    const path = `/v2/payments/authorizations/AUTH1/${operation}`;
    paypal.on("POST", path, () => paypalError(status, name, issue, "debug-abc123"));
    const call = {
      capture: () => payments.capture(captureRequest),
      void: () => payments.void({ authorizationId: "AUTH1", idempotencyKey: paypalRequestId("void", "hold-1") }),
      reauthorize: () =>
        payments.reauthorize({ authorizationId: "AUTH1", amountCents: 500_00, idempotencyKey: paypalRequestId("reauthorize", "hold-1") }),
    }[operation];

    const error = await caught(call());

    expect(error).toMatchObject({ operation, code: issue, paypalName: name, httpStatus: status, debugId: "debug-abc123", retryable });
    expect(error.message).toContain(issue);
    expect(error.message).toContain("debug-abc123");
  });

  it("reads the error body even for statuses the SDK does not declare", async () => {
    const { paypal, payments } = setup();
    // The SDK declares no 409 for authorize, so it only keeps the raw body.
    paypal.on("POST", "/v2/checkout/orders/ORDER1/authorize", () =>
      paypalError(409, "RESOURCE_CONFLICT", "PREVIOUS_REQUEST_IN_PROGRESS", "debug-409"),
    );

    const error = await caught(payments.authorizeOrder({ orderId: "ORDER1", idempotencyKey: paypalRequestId("authorize-order", "h") }));

    expect(error).toMatchObject({ operation: "authorizeOrder", code: "PREVIOUS_REQUEST_IN_PROGRESS", debugId: "debug-409", retryable: true });
  });

  it("falls back to the debug id header and marks 5xx retryable", async () => {
    const { paypal, payments } = setup();
    paypal.on("GET", "/v2/payments/authorizations/AUTH1", () => ({ status: 503, headers: { "paypal-debug-id": "debug-header" }, body: "" }));

    const error = await caught(payments.getAuthorization("AUTH1"));

    expect(error).toMatchObject({ code: "INTERNAL_SERVER_ERROR", httpStatus: 503, debugId: "debug-header", retryable: true });
  });

  it("treats a dropped connection as retryable: the same request id cannot apply twice", async () => {
    const { paypal, payments } = setup();
    paypal.on("POST", "/v2/payments/authorizations/AUTH1/capture", () => {
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    });

    const error = await caught(payments.capture(captureRequest));

    expect(error).toMatchObject({ operation: "capture", code: "NETWORK_ERROR", retryable: true, httpStatus: undefined });
  });

  it("reports a response it cannot read as UNEXPECTED_RESPONSE", async () => {
    const { paypal, payments } = setup();
    paypal.on("POST", "/v2/checkout/orders", () => json(201, { id: "ORDER1", status: "PAYER_ACTION_REQUIRED", links: [] }));

    const error = await caught(payments.createAuthorizeOrder(orderRequest));

    expect(error).toMatchObject({ code: "UNEXPECTED_RESPONSE", retryable: false });
  });
});

describe("PaypalSandboxClient token", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-04T20:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function withAuthorization(paypal: FakePaypal) {
    paypal.on("GET", "/v2/payments/authorizations/AUTH1", () => json(200, authorizationBody("AUTH1", "CREATED", "500.00")));
  }

  it("requests one client-credentials token and reuses it until shortly before it expires", async () => {
    const { paypal, payments } = setup();
    withAuthorization(paypal);

    await payments.getAuthorization("AUTH1");
    await payments.getAuthorization("AUTH1");
    expect(paypal.tokensIssued).toBe(1);

    const tokenRequest = paypal.lastRequest("/v1/oauth2/token");
    expect(tokenRequest.headers.authorization).toBe(`Basic ${Buffer.from("test-client:test-secret").toString("base64")}`);
    expect(tokenRequest.body).toBe("grant_type=client_credentials");

    vi.setSystemTime(Date.now() + (TOKEN_LIFETIME_SECONDS - 180) * 1000);
    await payments.getAuthorization("AUTH1");
    expect(paypal.tokensIssued).toBe(1);

    vi.setSystemTime(Date.now() + 150 * 1000);
    await payments.getAuthorization("AUTH1");
    expect(paypal.tokensIssued).toBe(2);
    expect(paypal.lastRequest("/v2/payments/authorizations/AUTH1").headers.authorization).toBe("Bearer token-2");
  });

  it("shares one token request between concurrent calls", async () => {
    const { paypal, payments } = setup();
    withAuthorization(paypal);

    await Promise.all([payments.getAuthorization("AUTH1"), payments.getAuthorization("AUTH1"), payments.getAuthorization("AUTH1")]);

    expect(paypal.tokensIssued).toBe(1);
  });

  it("recovers after a failed token request instead of failing every later call", async () => {
    const { paypal, payments } = setup();
    withAuthorization(paypal);
    paypal.on("POST", "/v1/oauth2/token", () =>
      json(401, { error: "invalid_client", error_description: "Client Authentication failed" }),
    );

    const error = await caught(payments.getAuthorization("AUTH1"));
    expect(error).toMatchObject({ operation: "authenticate", code: "AUTHENTICATION_FAILURE", httpStatus: 401 });

    paypal.on("POST", "/v1/oauth2/token", () => json(200, { access_token: "token-fresh", token_type: "Bearer", expires_in: 32400 }));
    await expect(payments.getAuthorization("AUTH1")).resolves.toMatchObject({ authorizationId: "AUTH1" });
    expect(paypal.lastRequest("/v2/payments/authorizations/AUTH1").headers.authorization).toBe("Bearer token-fresh");
  });

  it("drops a token PayPal rejects with 401", async () => {
    const { paypal, payments } = setup();
    paypal.on("GET", "/v2/payments/authorizations/AUTH1", () => paypalError(401, "AUTHENTICATION_FAILURE", null, "debug-401"));
    await caught(payments.getAuthorization("AUTH1"));

    withAuthorization(paypal);
    await payments.getAuthorization("AUTH1");

    expect(paypal.tokensIssued).toBe(2);
  });

  it("keeps no credentials in its errors, however deeply they are printed", async () => {
    const { paypal, payments } = setup();
    paypal.on("GET", "/v2/payments/authorizations/AUTH1", () => paypalError(401, "AUTHENTICATION_FAILURE", null, "debug-401"));
    const rejectedToken = await caught(payments.getAuthorization("AUTH1"));
    paypal.on("POST", "/v1/oauth2/token", () =>
      json(401, { error: "invalid_client", error_description: "Client Authentication failed" }),
    );
    const failedTokenRequest = await caught(payments.getAuthorization("AUTH1"));

    const basic = Buffer.from("test-client:test-secret").toString("base64");
    for (const error of [rejectedToken, failedTokenRequest]) {
      const printed = inspect(error, { depth: Infinity });
      expect(printed).not.toContain("token-1");
      expect(printed).not.toContain(basic);
      expect(printed).not.toContain("test-secret");
    }
    expect(rejectedToken).toMatchObject({ code: "AUTHENTICATION_FAILURE", debugId: "debug-401" });
    expect(failedTokenRequest).toMatchObject({ operation: "authenticate", code: "AUTHENTICATION_FAILURE" });
  });
});
