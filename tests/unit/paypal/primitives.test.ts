import { describe, expect, it } from "vitest";

import { PaypalError, paypalErrorFromException, paypalErrorFromResponse } from "@/server/paypal/errors";
import { assertRequestId, MAX_REQUEST_ID_LENGTH, nameBasedUuid, paypalRequestId } from "@/server/paypal/idempotency";
import { centsToPaypalValue, formatUsd, paypalValueToCents } from "@/server/paypal/money";

describe("money", () => {
  it("converts integer cents to PayPal's decimal strings and back", () => {
    expect(centsToPaypalValue(320_00)).toBe("320.00");
    expect(centsToPaypalValue(5)).toBe("0.05");
    expect(centsToPaypalValue(1_234_56)).toBe("1234.56");
    expect(paypalValueToCents("320.00")).toBe(320_00);
    expect(paypalValueToCents("320")).toBe(320_00);
    expect(paypalValueToCents("0.5")).toBe(50);
    // Parsed as text: no float rounding, ever.
    expect(paypalValueToCents("1.15")).toBe(115);
  });

  it("refuses anything that is not a whole number of cents", () => {
    expect(() => centsToPaypalValue(1.5)).toThrow(RangeError);
    expect(() => centsToPaypalValue(-100)).toThrow(RangeError);
    expect(() => paypalValueToCents("1.234")).toThrow(RangeError);
    expect(() => paypalValueToCents("-1.00")).toThrow(RangeError);
    expect(() => paypalValueToCents("1e3")).toThrow(RangeError);
  });

  it("formats dollars for plain text", () => {
    expect(formatUsd(500_00)).toBe("$500");
    expect(formatUsd(1_250_50)).toBe("$1,250.50");
  });
});

describe("paypalRequestId", () => {
  it("is an RFC 9562 version 5 UUID", () => {
    // The standard example: uuid5(NAMESPACE_DNS, "www.example.com").
    expect(nameBasedUuid("www.example.com", "6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(
      "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    );
  });

  it("derives the same id for the same operation on the same subject, and differs otherwise", () => {
    const id = paypalRequestId("capture", "item-1");
    expect(id).toBe(paypalRequestId("capture", "item-1"));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id.length).toBeLessThanOrEqual(MAX_REQUEST_ID_LENGTH);
    expect(paypalRequestId("void", "item-1")).not.toBe(id);
    expect(paypalRequestId("capture", "item-2")).not.toBe(id);
    expect(paypalRequestId("capture", "item-1", 2)).not.toBe(id);
    expect(paypalRequestId("capture", "item-1", 1)).toBe(id);
  });

  it("refuses ids PayPal would not accept", () => {
    expect(() => paypalRequestId("capture", "")).toThrow(RangeError);
    expect(() => paypalRequestId("capture", "item-1", 0)).toThrow(RangeError);
    expect(() => assertRequestId("x".repeat(MAX_REQUEST_ID_LENGTH + 1))).toThrow(RangeError);
    expect(() => assertRequestId("has space")).toThrow(RangeError);
  });
});

describe("PayPal error mapping", () => {
  it("takes the issue from details and the debug id from the body", () => {
    const error = paypalErrorFromResponse("capture", {
      status: 422,
      headers: { "paypal-debug-id": "header-id" },
      body: JSON.stringify({
        name: "UNPROCESSABLE_ENTITY",
        message: "The requested action could not be performed.",
        debug_id: "body-id",
        details: [{ issue: "DUPLICATE_INVOICE_ID", description: "Payment for this invoice was already captured." }],
      }),
    });

    expect(error).toBeInstanceOf(PaypalError);
    expect(error).toMatchObject({
      operation: "capture",
      code: "DUPLICATE_INVOICE_ID",
      paypalName: "UNPROCESSABLE_ENTITY",
      httpStatus: 422,
      debugId: "body-id",
      retryable: false,
    });
    expect(error.is("DUPLICATE_INVOICE_ID")).toBe(true);
    expect(error.toRecord()).toEqual({ operation: "capture", code: "DUPLICATE_INVOICE_ID", httpStatus: 422, debugId: "body-id" });
  });

  it("maps OAuth errors and bodiless responses", () => {
    expect(
      paypalErrorFromResponse("authenticate", {
        status: 401,
        headers: {},
        body: { error: "invalid_client", error_description: "Client Authentication failed" },
      }).code,
    ).toBe("AUTHENTICATION_FAILURE");
    expect(paypalErrorFromResponse("getAuthorization", { status: 404, headers: {}, body: "" }).code).toBe("RESOURCE_NOT_FOUND");
    expect(paypalErrorFromResponse("void", { status: 502, headers: {}, body: "<html>" })).toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      retryable: true,
    });
    expect(paypalErrorFromResponse("void", { status: 429, headers: {}, body: "" }).retryable).toBe(true);
  });

  it("classifies failures without a response", () => {
    const timeout = Object.assign(new Error("timeout of 30000ms exceeded"), { code: "ECONNABORTED" });
    expect(paypalErrorFromException("capture", timeout)).toMatchObject({ code: "TIMEOUT", retryable: true });
    const fetchFailure = new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) });
    expect(paypalErrorFromException("verifyWebhookSignature", fetchFailure)).toMatchObject({ code: "NETWORK_ERROR", retryable: true });
    expect(paypalErrorFromException("void", new Error("boom"))).toMatchObject({ code: "UNKNOWN", retryable: false });
  });
});
