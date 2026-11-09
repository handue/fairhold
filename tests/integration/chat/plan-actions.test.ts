/** Skip, Pause, Resume and Edit through their routes, on Postgres. */
import { describe, expect, it } from "vitest";

import { skipPlanLot } from "@/server/chat/actions";
import type { AutopilotChange } from "@/server/glim/autopilot/types";
import { applyAutopilotChange } from "@/server/plans/apply";
import { pausePlan, resumePlan } from "@/server/plans/pause";

import { GOLDEN_SENTENCE } from "../../fixtures/glim/golden-state";
import { getTestDatabase } from "../../helpers/database";
import { expireLot } from "../engine/support/fixtures";
import { bid, rows } from "../plans/support";

import {
  clickEdit,
  clickPause,
  clickResume,
  clickSkip,
  clickStartBidding,
  createChatGala,
  eventLines,
  lastPlanCard,
  readView,
  sendMessage,
  type ChatGala,
} from "./support";

const { pool } = getTestDatabase();

async function runningGala(): Promise<ChatGala> {
  const gala = await createChatGala(pool);
  const card = lastPlanCard((await sendMessage(gala, GOLDEN_SENTENCE)).view);
  await clickStartBidding(gala, card.planId);
  return gala;
}

const activeLimits = (paddleId: string) =>
  rows<{ lot_id: string; paused: boolean }>(
    pool,
    "select lot_id, paused_at is not null as paused from bid_limits where paddle_id = $1 and owner = 'glim' and active order by max_cents",
    [paddleId],
  );

describe("Skip", () => {
  it("ends Glim's limit at once; the bid stands, and the guest is told", async () => {
    const gala = await runningGala();
    const clicked = await clickSkip(gala, "12");
    expect(clicked.status).toBe(200);
    expect(await activeLimits(gala.jamie)).toEqual([{ lot_id: gala.lots.chef, paused: false }]);
    expect(await rows(pool, "select amount_cents from bids where lot_id = $1 and paddle_id = $2", [gala.lots.spa, gala.jamie])).toEqual([{ amount_cents: 9_000 }]);
    expect(eventLines(clicked.view).at(-1)).toBe("I stopped bidding on Spa Day. Your $90 bid stands.");
    expect(clicked.view?.quickReplies.map((reply) => reply.label)).toEqual(["Raise my budget", "Skip Chef’s Table", "How am I doing?"]);
    expect(await rows(pool, "select i.status from glim_plan_items i join glim_plans p on p.id = i.plan_id where p.paddle_id = $1 and i.lot_id = $2 and p.status = 'active'", [gala.jamie, gala.lots.spa])).toEqual([{ status: "skipped" }]);
    // A rival's bid on the lot goes unanswered now.
    await bid(pool, gala.rival, gala.lots.spa, 9_500);
    expect(eventLines(await readView(gala)).at(-1)).toBe("I stopped bidding on Spa Day. Your $90 bid stands.");
  });

  it("is safe to click twice: nothing more is said or written", async () => {
    const gala = await runningGala();
    await clickSkip(gala, 12);
    const version = await rows(pool, "select version from glim_plans where paddle_id = $1 and status = 'active'", [gala.jamie]);
    const again = await clickSkip(gala, 12);
    expect(again.status).toBe(200);
    expect(eventLines(again.view).filter((line) => line.startsWith("I stopped bidding"))).toHaveLength(1);
    expect(await rows(pool, "select version from glim_plans where paddle_id = $1 and status = 'active'", [gala.jamie])).toEqual(version);
  });

  it("refuses a lot outside the plan, an unknown lot and a closed one", async () => {
    const gala = await runningGala();
    expect(await clickSkip(gala, 3)).toMatchObject({ status: 409, error: { code: "not_in_plan" } });
    expect(await clickSkip(gala, 99)).toMatchObject({ status: 404, error: { code: "lot_not_found" } });
    expect(await clickSkip(gala, "abc")).toMatchObject({ status: 404, error: { code: "lot_not_found" } });
    await expireLot(pool, gala.lots.spa);
    expect(await clickSkip(gala, 12)).toMatchObject({ status: 409, error: { code: "lot_closed" } });
  });

  it("refuses with no plan running", async () => {
    const gala = await createChatGala(pool);
    expect(await clickSkip(gala, 12)).toMatchObject({ status: 409, error: { code: "not_in_plan" } });
  });
});

describe("Pause and Resume", () => {
  it("stops Glim's answers until Resume, then answers what it missed", async () => {
    const gala = await runningGala();
    const paused = await clickPause(gala);
    expect(paused.status).toBe(200);
    expect(paused.view?.status).toEqual({ tone: "off", text: "Paused · $500 held with PayPal" });
    expect(lastPlanCard(paused.view).state).toBe("paused");
    expect(paused.view?.quickReplies[0]).toEqual({ kind: "resume", label: "Resume Glim" });
    expect(await activeLimits(gala.jamie)).toEqual([
      { lot_id: gala.lots.spa, paused: true },
      { lot_id: gala.lots.chef, paused: true },
    ]);
    expect(eventLines(paused.view).at(-1)).toBe("I won’t bid or change your plan until you resume. Your bids stand.");

    const placed = await bid(pool, gala.rival, gala.lots.chef, 36_000);
    expect(placed.proxyBids).toEqual([]);

    const resumed = await clickResume(gala);
    expect(resumed.status).toBe(200);
    expect(resumed.view?.status).toEqual({ tone: "on", text: "On duty · $500 held with PayPal" });
    expect(lastPlanCard(resumed.view).state).toBe("running");
    expect(await activeLimits(gala.jamie)).toEqual([
      { lot_id: gala.lots.spa, paused: false },
      { lot_id: gala.lots.chef, paused: false },
    ]);
    expect(eventLines(resumed.view).slice(-2)).toEqual([
      "I’m back on duty. Chef’s Table up to $380, Spa Day up to $120.",
      "Someone bid $360. I raised to $380, your limit for this lot.",
    ]);
  });

  it("moves the plan's status and version first, and on the paddle's channel", async () => {
    const gala = await runningGala();
    const [before] = await rows<{ id: string; version: number }>(pool, "select id, version from glim_plans where paddle_id = $1 and status = 'active'", [gala.jamie]);
    await clickPause(gala);
    const [paused] = await rows<{ status: string; version: number; paused_at: Date | null }>(pool, "select status, version, paused_at from glim_plans where id = $1", [before?.id]);
    expect(paused?.status).toBe("paused");
    expect(paused?.version).toBe((before?.version ?? 0) + 1);
    expect(paused?.paused_at).not.toBeNull();
    const channel = await rows<{ payload: Record<string, unknown> }>(
      pool,
      "select payload from event_log where paddle_id = $1 and type = 'glim' and payload->>'kind' in ('plan_status', 'limits_paused') order by id",
      [gala.jamie],
    );
    // The fence, then the limits: the order an autopilot decision in flight relies on.
    expect(channel.map((row) => row.payload.kind)).toEqual(["plan_status", "plan_status", "limits_paused"]);
    expect(channel[1]?.payload).toMatchObject({ planId: before?.id, status: "paused", version: (before?.version ?? 0) + 1 });
    expect(await rows(pool, "select kind, message from glim_actions where paddle_id = $1 and kind = 'paused'", [gala.jamie])).toEqual([
      { kind: "paused", message: "I won’t bid or change your plan until you resume. Your bids stand." },
    ]);
  });

  it("fences an autopilot decision in flight: its plan version is stale once paused", async () => {
    const gala = await runningGala();
    const [plan] = await rows<{ id: string; version: number }>(pool, "select id, version from glim_plans where paddle_id = $1 and status = 'active'", [gala.jamie]);
    await clickPause(gala);
    const change: AutopilotChange = { before: [], after: [], set: [], removeLotIds: [] } as unknown as AutopilotChange;
    const result = await applyAutopilotChange({
      runId: "00000000-0000-4000-8000-000000000001",
      paddleId: gala.jamie,
      eventId: gala.eventId,
      planId: plan?.id ?? "",
      planVersion: plan?.version ?? 0,
      change,
      describe: () => {
        throw new Error("must not be reached");
      },
      run: {} as never,
      pool,
    });
    expect(result).toEqual({ outcome: "stale", reason: "plan_paused" });
  });

  it("can be repeated, and finishes what an interrupted one left", async () => {
    const gala = await runningGala();
    await clickPause(gala);
    const again = await clickPause(gala);
    expect(again.status).toBe(200);
    expect(eventLines(again.view).filter((line) => line.startsWith("I won’t bid"))).toHaveLength(1);

    // A resume that stopped after its first step: the plan is active, its limits still paused.
    await pool.query("update glim_plans set status = 'active', paused_at = null where paddle_id = $1 and status = 'paused'", [gala.jamie]);
    const finished = await resumePlan({ paddleId: gala.jamie, pool });
    expect(finished).toMatchObject({ ok: true, changed: false });
    expect((await activeLimits(gala.jamie)).every((limit) => !limit.paused)).toBe(true);

    await pool.query("update bid_limits set paused_at = null where paddle_id = $1", [gala.jamie]);
    await pool.query("update glim_plans set status = 'paused' where paddle_id = $1 and status = 'active'", [gala.jamie]);
    const repaused = await pausePlan({ paddleId: gala.jamie, pool });
    expect(repaused).toMatchObject({ ok: true, changed: false });
    expect((await activeLimits(gala.jamie)).every((limit) => limit.paused)).toBe(true);
  });

  it("refuses with no plan, and once bidding has closed", async () => {
    const gala = await createChatGala(pool);
    expect(await clickPause(gala)).toMatchObject({ status: 409, error: { code: "no_plan" } });
    expect(await clickResume(gala)).toMatchObject({ status: 409, error: { code: "no_plan" } });
    await pool.query("update events set status = 'closed' where id = $1", [gala.eventId]);
    expect(await clickPause(gala)).toMatchObject({ status: 409, error: { code: "event_closed" } });
  });
});

describe("Edit", () => {
  it("answers with a new card, and changes nothing until Start bidding", async () => {
    const gala = await runningGala();
    const running = lastPlanCard(await readView(gala));
    const edited = await clickEdit(gala, running.planId, [
      { lotNumber: 7, maxCents: 40_000 },
      { lotNumber: 12, maxCents: 10_000 },
    ]);
    expect(edited.status).toBe(200);
    const card = lastPlanCard(edited.view);
    expect(card.state).toBe("proposed");
    expect(card.budgetCents).toBe(50_000);
    expect(card.items.map((item) => [item.lotNumber, item.maxCents])).toEqual([
      [7, 40_000],
      [12, 10_000],
    ]);
    expect(await rows(pool, "select max_cents from bid_limits where paddle_id = $1 and owner = 'glim' and active order by max_cents", [gala.jamie])).toEqual([
      { max_cents: 12_000 },
      { max_cents: 38_000 },
    ]);

    const started = await clickStartBidding(gala, card.planId);
    expect(started.status).toBe(200);
    expect(lastPlanCard(started.view).state).toBe("running");
    expect(await rows(pool, "select max_cents from bid_limits where paddle_id = $1 and owner = 'glim' and active order by max_cents", [gala.jamie])).toEqual([
      { max_cents: 10_000 },
      { max_cents: 40_000 },
    ]);
    expect(await rows(pool, "select status from glim_plans where id = $1", [running.planId])).toEqual([{ status: "superseded" }]);
    expect(started.view?.messages.filter((message) => message.card?.type === "plan").map((message) => message.card?.type === "plan" && message.card.state)).toEqual([
      "over",
      "running",
    ]);
  });

  it("drops a lot left out, and takes it off with Start bidding", async () => {
    const gala = await runningGala();
    const running = lastPlanCard(await readView(gala));
    const edited = await clickEdit(gala, running.planId, [{ lotNumber: 7, maxCents: 40_000 }]);
    await clickStartBidding(gala, lastPlanCard(edited.view).planId);
    expect(await activeLimits(gala.jamie)).toEqual([{ lot_id: gala.lots.chef, paused: false }]);
    expect(await rows(pool, "select amount_cents from bids where lot_id = $1 and paddle_id = $2", [gala.lots.spa, gala.jamie])).toEqual([{ amount_cents: 9_000 }]);
  });

  it("edits a card still waiting, keeping its budget while the new maximums fit", async () => {
    const gala = await createChatGala(pool);
    const waiting = lastPlanCard((await sendMessage(gala, GOLDEN_SENTENCE)).view);
    const edited = await clickEdit(gala, waiting.planId, [
      { lotNumber: 7, maxCents: 35_000 },
      { lotNumber: 12, maxCents: 12_000 },
    ]);
    const card = lastPlanCard(edited.view);
    expect(card.budgetCents).toBe(50_000);
    expect(card.items.map((item) => item.sharePercent)).toEqual([70, 24]);
    expect((await clickStartBidding(gala, waiting.planId)).error?.code).toBe("plan_not_proposed");
    expect((await clickStartBidding(gala, card.planId)).status).toBe(200);
  });

  it("refuses maximums past the bidding power, below the next bid or on a closed lot, naming the rule", async () => {
    const gala = await createChatGala(pool);
    const waiting = lastPlanCard((await sendMessage(gala, GOLDEN_SENTENCE)).view);
    const over = await clickEdit(gala, waiting.planId, [
      { lotNumber: 7, maxCents: 42_000 },
      { lotNumber: 12, maxCents: 10_000 },
    ]);
    expect(over.status).toBe(422);
    expect(over.error?.code).toBe("total_over_limit");
    const low = await clickEdit(gala, waiting.planId, [{ lotNumber: 12, maxCents: 8_000 }]);
    expect(low).toMatchObject({ status: 422, error: { code: "max_below_next_minimum" } });
    expect(await clickEdit(gala, "not-a-plan", [{ lotNumber: 7, maxCents: 40_000 }])).toMatchObject({ status: 404 });
    expect(lastPlanCard(await readView(gala)).planId).toBe(waiting.planId);
  });
});

describe("an actor from elsewhere", () => {
  it("finds no lot to skip outside their own event", async () => {
    const stranger = "00000000-0000-4000-8000-000000000000";
    await expect(skipPlanLot({ paddleId: stranger, eventId: stranger }, 7, pool)).rejects.toMatchObject({ status: 404, code: "lot_not_found" });
  });
});
