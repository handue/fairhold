/**
 * Event cards as one engine tick task. Register it ahead of the autopilot's, so a fact's card ("Someone
 * bid $400, over your $380 limit.") always precedes what Glim did about it.
 */
import type { TickTask } from "@/server/engine/tick";

import { syncEventCards } from "./event-card-sync";

export function createEventCardTickTask(): TickTask {
  return { name: "glimEventCards", run: () => syncEventCards() };
}
