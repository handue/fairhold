/**
 * Sends 07's golden sentence through Glim against Jamie's approved state and prints the plan.
 * Live claude-opus-5-5 when GLIM_MODE=live and ANTHROPIC_API_KEY is set, otherwise the recorded
 * fixture. Either way the model only states intent; the allocator and validator set the maxima.
 * Exits 1 unless the plan is Chef's Table $380 and Spa Day $120.
 */
import { createLiveGlimModel } from "@/server/glim/client";
import { DEFAULT_DAILY_TOKEN_BUDGET, DEFAULT_RECORDINGS_DIR, GLIM_EFFORT, GLIM_MODEL } from "@/server/glim/config";
import { formatUsd } from "@/server/glim/money";
import { createRecordedGlimModel } from "@/server/glim/recorded";
import { runGlimTurn } from "@/server/glim/turn";

import { createGoldenState, GOLDEN_PLAN, GOLDEN_SENTENCE } from "../tests/fixtures/glim/golden-state";
import { loadLocalEnv } from "./lib/load-local-env";

loadLocalEnv();

const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
const live = process.env.GLIM_MODE === "live" && Boolean(apiKey);
const model = live && apiKey ? createLiveGlimModel({ apiKey }) : createRecordedGlimModel({ dir: DEFAULT_RECORDINGS_DIR });

console.log(
  live
    ? `glim:spike · live ${GLIM_MODEL}, effort ${GLIM_EFFORT}`
    : "glim:spike · recorded fixture (set GLIM_MODE=live and ANTHROPIC_API_KEY to call the model)",
);
console.log(`Guest: ${GOLDEN_SENTENCE}`);
process.stdout.write("Glim: ");

const result = await runGlimTurn({
  state: createGoldenState(),
  transcript: [],
  guestText: GOLDEN_SENTENCE,
  usageSoFar: { paddleMessages: 0, eventMessages: 0, tokensToday: 0 },
  dailyTokenBudget: DEFAULT_DAILY_TOKEN_BUDGET,
  model,
  onEvent: (event) => {
    if (event.type === "text") process.stdout.write(event.text);
    else process.stdout.write(" [reset] ");
  },
});
console.log(result.reply ? "" : "(no text; the card speaks)");

if (result.proposal) {
  console.log(`Model intent: ${result.proposal.tool} ${JSON.stringify(result.proposal.input)}`);
}
for (const rejection of result.rejections) {
  console.log(`Rejected (${rejection.rejectReason}): ${rejection.message}`);
}

const card = result.card;
if (card?.type === "plan") {
  console.log(`Plan card (allocator + validator)${card.adjusted ? ", adjusted by the clamp" : ""}:`);
  for (const item of card.items) {
    const cap = item.capCents === null ? "" : `  (guest cap ${formatUsd(item.capCents)})`;
    console.log(`  ${item.priority}. ${item.shortTitle.padEnd(14)} ${formatUsd(item.maxCents).padStart(6)} max  · ${item.statusText}${cap}`);
  }
  console.log(
    `  Budget ${formatUsd(card.budgetCents)} · total ${formatUsd(card.totalCents)} · bidding power ${formatUsd(card.holdCents)}`,
  );
} else {
  console.log(`No plan card${result.error ? ` (${result.error})` : ""}.`);
}
console.log(`Served by ${result.model ?? "none"} · ${result.attempts} call(s) · ${result.tokensUsed} tokens · ${result.latencyMs} ms`);

const matches =
  card?.type === "plan" &&
  card.items.length === GOLDEN_PLAN.length &&
  GOLDEN_PLAN.every((expected) =>
    card.items.some((item) => item.lotNumber === expected.lotNumber && item.maxCents === expected.maxCents),
  );
if (matches) {
  console.log(`OK: ${GOLDEN_PLAN.map((item) => `${item.shortTitle} ${formatUsd(item.maxCents)}`).join(" and ")}`);
} else {
  console.error("Unexpected plan: the golden sentence must give Chef's Table $380 and Spa Day $120.");
  process.exitCode = 1;
}
