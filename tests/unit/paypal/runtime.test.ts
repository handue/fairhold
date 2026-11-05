import { describe, expect, it } from "vitest";

import { getPayments } from "@/server/paypal/runtime";
import { getSimulatedPayments } from "@/server/paypal/simulated-payments";

// vitest.config.ts runs every test keyless, with PAYMENTS_MODE=simulated.
describe("getPayments in keyless mode", () => {
  it("settles PayPal holds in the one process-wide simulation, like simulated ones", () => {
    expect(getPayments("paypal").mode).toBe("simulated");
    expect(getPayments("paypal")).toBe(getSimulatedPayments());
    expect(getPayments("simulated")).toBe(getSimulatedPayments());
  });
});
