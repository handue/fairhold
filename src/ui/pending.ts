/**
 * Marks a control whose server action lands later (placing bids, favorites, Glim's chat). It logs
 * so the click is visible during development; search for this name to find what is left to wire.
 */
export function logPendingAction(action: string, details: Record<string, unknown> = {}): void {
  console.info(`[fairhold] ${action} is not wired yet`, details);
}
