/**
 * The payments this process uses, chosen from the environment. Instances live on globalThis
 * because Next.js gives each route its own module copies: one token cache and one simulation per
 * process, whichever route created them.
 */
import { getServerEnv } from "@/server/lib/env";

import type { HoldKind, Payments } from "./payments";
import { PaypalSandboxClient } from "./sandbox-client";
import { SandboxPayments } from "./sandbox-payments";
import { getSimulatedPayments } from "./simulated-payments";

interface SandboxRuntime {
  client: PaypalSandboxClient;
  payments: SandboxPayments;
}

const processGlobal = globalThis as typeof globalThis & { __fairholdPaypalSandbox?: SandboxRuntime };

/**
 * The payments holding the authorization of a hold of this kind. A simulated hold always settles
 * in simulation; a PayPal hold uses the sandbox, or the simulation in keyless mode
 * (PAYMENTS_MODE=simulated).
 */
export function getPayments(kind: HoldKind): Payments {
  if (kind === "paypal" && getServerEnv().PAYMENTS_MODE === "sandbox") {
    const runtime = sandboxRuntime();
    // The env schema already requires both credentials in sandbox mode.
    if (!runtime) throw new Error("PAYMENTS_MODE=sandbox needs PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET");
    return runtime.payments;
  }
  return getSimulatedPayments();
}

/** The sandbox connection, or null when no PayPal credentials are configured. */
export function getSandboxClient(): PaypalSandboxClient | null {
  return sandboxRuntime()?.client ?? null;
}

function sandboxRuntime(): SandboxRuntime | null {
  if (processGlobal.__fairholdPaypalSandbox) return processGlobal.__fairholdPaypalSandbox;
  const env = getServerEnv();
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) return null;
  const client = new PaypalSandboxClient({
    clientId: env.PAYPAL_CLIENT_ID,
    clientSecret: env.PAYPAL_CLIENT_SECRET,
  });
  processGlobal.__fairholdPaypalSandbox = { client, payments: new SandboxPayments(client) };
  return processGlobal.__fairholdPaypalSandbox;
}
