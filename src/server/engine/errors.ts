export type EngineErrorCode =
  | "invalid_input"
  | "paddle_not_found"
  | "lot_not_found"
  | "lot_not_in_event"
  | "proxy_runaway";

/**
 * A programming or authorization error (unknown ids, a lot from another event, malformed
 * amounts). Business-rule refusals are not errors; they come back as Outcome values.
 */
export class EngineError extends Error {
  override name = "EngineError";

  constructor(
    readonly code: EngineErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Largest value a Postgres integer column holds; every stored amount fits in one. */
const MAX_CENTS = 2_147_483_647;

export function assertCents(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_CENTS) {
    throw new EngineError("invalid_input", `${name} must be a positive whole number of cents`);
  }
}
