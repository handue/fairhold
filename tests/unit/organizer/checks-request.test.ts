/**
 * The rail's "Checking…" (design/24): asking PayPal before charging. The hosted site once read
 * "Checking…" long after the checks request had answered. Two ways it could, both shut here: an
 * answer dropped because the effect that sent it was cleaned up mid-request, which left "checking"
 * set for good, and a failed request, which left the undecided checks reading "Checking…".
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { SettlementChecks } from "@/server/settlement/types";
import {
  checksRequestStatus,
  NO_CHECKS_REQUEST,
  reduceChecksRequest,
  type ChecksRequestEvent,
  type ChecksRequestState,
} from "@/ui/organizer/checks-request";
import { checksHeading } from "@/ui/organizer/ledger-model";

const undecided: SettlementChecks = {
  passed: null,
  ranAt: null,
  checks: [{ key: "holds_valid", passed: null, count: 1, problems: [] }],
};
const answer = (passed: boolean): SettlementChecks => ({
  passed,
  ranAt: 1,
  checks: [{ key: "holds_valid", passed, count: 1, problems: [] }],
});

const run = (events: ChecksRequestEvent[]) => events.reduce(reduceChecksRequest, NO_CHECKS_REQUEST);
/** What the rail's heading reads with this state over the server's undecided view. */
const heading = (state: ChecksRequestState) => checksHeading("ready", state.checks ?? undecided, checksRequestStatus(state)).text;

describe("asking PayPal before charging", () => {
  it("reads Checking… while asking, and the answer once it comes", () => {
    const asking = run([{ type: "sent", id: 1 }]);
    expect(checksRequestStatus(asking)).toBe("asking");
    expect(heading(asking)).toBe("Checking…");

    const answered = reduceChecksRequest(asking, { type: "answered", id: 1, checks: answer(true) });
    expect(checksRequestStatus(answered)).toBe("idle");
    expect(heading(answered)).toBe("All passed");
  });

  it("leaves Checking… on an answer that arrives after the page stopped waiting for it", () => {
    // The old screen cleaned its effect up when a re-read moved the phase or the checks on, and its
    // answer was then thrown away with "checking" still true. Every answer is dispatched now.
    const state = run([
      { type: "sent", id: 1 },
      { type: "answered", id: 1, checks: answer(true) },
    ]);
    expect(checksRequestStatus(state)).toBe("idle");
    expect(heading(state)).not.toBe("Checking…");
  });

  it("does not stay on Checking… when the request fails: it says the checks have not run", () => {
    const state = run([
      { type: "sent", id: 1 },
      { type: "failed", id: 1, error: "We couldn’t reach Fairhold. Check your connection and try again." },
    ]);
    expect(checksRequestStatus(state)).toBe("failed");
    expect(heading(state)).toBe("Not checked yet");
    expect(state.error).toMatch(/couldn’t reach/);
  });

  it("keeps only the latest answer: an older one neither ends the newer ask nor replaces its result", () => {
    const state = run([
      { type: "sent", id: 1 },
      { type: "sent", id: 2 },
      { type: "answered", id: 1, checks: answer(false) },
    ]);
    expect(checksRequestStatus(state)).toBe("asking");
    expect(state.checks).toBeNull();

    const done = reduceChecksRequest(state, { type: "answered", id: 2, checks: answer(true) });
    expect(done.checks?.passed).toBe(true);
    expect(reduceChecksRequest(done, { type: "failed", id: 1, error: "late" })).toBe(done);
  });

  it("a Check again after a failure asks afresh and clears the error", () => {
    const state = run([
      { type: "sent", id: 1 },
      { type: "failed", id: 1, error: "x" },
      { type: "sent", id: 2 },
    ]);
    expect(state).toMatchObject({ waiting: true, failed: false, error: null });
  });

  it("never reads Checking… once the latest request has answered, in any order of events", () => {
    const event = fc.oneof(
      fc.record({ type: fc.constant("answered" as const), id: fc.integer({ min: 1, max: 4 }), passed: fc.boolean() }),
      fc.record({ type: fc.constant("failed" as const), id: fc.integer({ min: 1, max: 4 }) }),
    );
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4 }), fc.array(event, { maxLength: 12 }), fc.boolean(), (sent, answers, failLast) => {
        let state = NO_CHECKS_REQUEST;
        for (let id = 1; id <= sent; id += 1) state = reduceChecksRequest(state, { type: "sent", id });
        for (const item of answers) {
          state = reduceChecksRequest(
            state,
            item.type === "answered" ? { type: "answered", id: item.id, checks: answer(item.passed) } : { type: "failed", id: item.id, error: "x" },
          );
        }
        const last: ChecksRequestEvent = failLast ? { type: "failed", id: sent, error: "x" } : { type: "answered", id: sent, checks: answer(true) };
        state = reduceChecksRequest(state, last);
        expect(checksRequestStatus(state)).not.toBe("asking");
        expect(heading(state)).not.toBe("Checking…");
      }),
    );
  });
});
