/**
 * The ids simulated payments make up (PAYMENTS_MODE=simulated, see simulated-payments.ts): "SIM", a
 * letter for the kind (Order, Authorization, Capture, Reauthorization) and 13 hex digits, 17
 * characters as PayPal's are. A page shows "Simulated" in their place, so a keyless run never puts
 * a made-up id under a PayPal label. Pure, so client components can use it.
 */
const SIMULATED_ID = /^SIM[OACR][0-9A-F]{13}$/;

export function isSimulatedId(id: string): boolean {
  return SIMULATED_ID.test(id);
}

/** PayPal's own id, or null when there is none or simulated payments made it up. */
export function paypalIdOrNull(id: string | null | undefined): string | null {
  return id && !isSimulatedId(id) ? id : null;
}
