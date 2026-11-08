/**
 * Sends 07's golden sentence through Glim against Jamie's approved state and prints the plan.
 * Live claude-opus-5-5 when GLIM_MODE=live and ANTHROPIC_API_KEY is set, otherwise the recorded
 * fixture. Either way the model only states intent; the allocator and validator set the maxima.
 * Exits 1 unless the plan is Chef's Table $380 and Spa Day $120.
 *
 * With --autopilot [scenario] it runs one autopilot decision instead (docs/planning/glim-autopilot.md
 * §4): golden-move by default, twice, so the second call shows the cached system prompt. The
 * scenarios are tests/fixtures/glim/autopilot-golden.ts; --record writes the live reply to
 * tests/fixtures/glim/recorded/autopilot-<scenario>.json for keyless runs.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

import { decideAutopilot } from "@/server/glim/autopilot/decide";
import { createLiveGlimModel, type GlimMessage, type GlimModel } from "@/server/glim/client";
import { DEFAULT_DAILY_TOKEN_BUDGET, DEFAULT_RECORDINGS_DIR, GLIM_EFFORT, GLIM_MODEL } from "@/server/glim/config";
import { formatUsd } from "@/server/glim/money";
import { createRecordedGlimModel } from "@/server/glim/recorded";
import { runGlimTurn } from "@/server/glim/turn";

import { AUTOPILOT_SCENARIOS, type AutopilotScenario } from "../tests/fixtures/glim/autopilot-golden";
import { createGoldenState, GOLDEN_PLAN, GOLDEN_SENTENCE } from "../tests/fixtures/glim/golden-state";
import { loadLocalEnv } from "./lib/load-local-env";

loadLocalEnv();

const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
const live = process.env.GLIM_MODE === "live" && Boolean(apiKey);
const model = live && apiKey ? createLiveGlimModel({ apiKey }) : createRecordedGlimModel({ dir: DEFAULT_RECORDINGS_DIR });
const args = process.argv.slice(2);

if (args.includes("--autopilot")) {
  await autopilotSpike();
} else {
  await chatSpike();
}

async function autopilotSpike(): Promise<void> {
  const name = (args.find((arg) => !arg.startsWith("--")) ?? "golden-move") as AutopilotScenario;
  const scenario = AUTOPILOT_SCENARIOS[name];
  if (!scenario) {
    console.error(`No autopilot scenario ${name}; try one of ${Object.keys(AUTOPILOT_SCENARIOS).join(", ")}.`);
    process.exitCode = 1;
    return;
  }
  let last: GlimMessage | null = null;
  const capturing: GlimModel = {
    mode: model.mode,
    async respond(request, hooks) {
      last = await model.respond(request, hooks);
      return last;
    },
  };
  console.log(
    live ? `glim:spike --autopilot ${name} · live ${GLIM_MODEL}, effort ${GLIM_EFFORT}` : `glim:spike --autopilot ${name} · recorded fixture`,
  );
  const calls = name === "golden-move" ? 2 : 1;
  let result: Awaited<ReturnType<typeof decideAutopilot>> | null = null;
  for (let call = 1; call <= calls; call += 1) {
    last = null;
    result = await decideAutopilot({ context: scenario(), model: capturing, modelAllowed: { ok: true } });
    const message = last as GlimMessage | null;
    const usage = message?.usage;
    console.log(
      `Call ${call}: decided by ${result.decidedBy} · ${result.outcome} · ${result.latencyMs ?? 0} ms · ${result.tokensUsed} tokens · cache_read_input_tokens ${usage?.cache_read_input_tokens ?? 0} · cache_creation_input_tokens ${usage?.cache_creation_input_tokens ?? 0}${result.error ? ` · ${result.error}` : ""}`,
    );
    if (result.modelDecision) console.log(`  Decision: ${JSON.stringify(result.modelDecision)}`);
    console.log(`  Why (filtered): ${result.modelWhy ?? "(template)"}`);
    if (call === 1 && args.includes("--record") && live && message) {
      const file = path.join(DEFAULT_RECORDINGS_DIR, `autopilot-${name}.json`);
      const recording = {
        name: `autopilot-${name}`,
        description: `Recorded live from ${message.model} on ${new Date().toISOString().slice(0, 10)} (npm run glim:spike -- --autopilot ${name} --record).`,
        fixtureKey: result.fixtureKey,
        responses: [
          {
            content: message.content.flatMap((block) => (block.type === "text" ? [{ type: "text", text: block.text }] : [])),
            stop_reason: message.stop_reason,
            // A replay spends nothing, so it must not count toward the daily token budget.
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        ],
      };
      writeFileSync(file, `${JSON.stringify(recording, null, 2)}\n`);
      console.log(`  Recorded ${path.relative(process.cwd(), file)}`);
    }
  }
  if (!result) return;
  const context = scenario();
  for (const lot of result.change?.change.after ?? []) {
    const before = result.change?.change.before.find((entry) => entry.lotId === lot.lotId)?.maxCents;
    console.log(`  ${lot.shortTitle.padEnd(14)} ${before === undefined ? "new" : formatUsd(before)} -> ${formatUsd(lot.maxCents)}`);
  }
  if (result.raise) console.log(`  Raise prepared: ${formatUsd(result.raise.amountCents)} (${formatUsd(result.raise.bounds.minCents)} to ${formatUsd(result.raise.bounds.maxCents)})`);
  if (name !== "golden-move") return;
  const wine = result.change?.change.after.find((lot) => lot.lotNumber === 9);
  const wineLot = context.state.lots.find((lot) => lot.number === 9);
  if (result.decidedBy === "model" && wine?.maxCents === 38_000 && wineLot) {
    console.log(`OK: moved to Wine Tasting, up to ${formatUsd(wine.maxCents)}, bid ${formatUsd(wineLot.nextMinimumCents)}`);
  } else {
    console.error("Unexpected decision: the golden beat must move the money to Wine Tasting, up to $380, decided by the model.");
    process.exitCode = 1;
  }
}

async function chatSpike(): Promise<void> {

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
}
