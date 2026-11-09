import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, expectTypeOf, it } from "vitest";

import * as schema from "@/server/db/schema";
import type { EventLogEntry } from "@/server/sse/notify";
import { EVENT_LOG_TYPES as NOTIFY_TYPES } from "@/server/sse/notify";
import {
  canSeeStreamRow,
  EVENT_LOG_TYPES,
  isAfterPosition,
  parseStreamPosition,
  STREAM_CONTROL_EVENTS,
  STREAM_EVENT_NAMES,
  type StreamEvent,
  type StreamEventOf,
  type StreamPayloads,
} from "@/server/sse/types";

describe("the stream's names", () => {
  it("are the event_log types, plus the control frames", () => {
    expect([...EVENT_LOG_TYPES]).toEqual(schema.eventLogType.enumValues);
    expect(NOTIFY_TYPES).toBe(EVENT_LOG_TYPES);
    expect(STREAM_EVENT_NAMES).toEqual([...schema.eventLogType.enumValues, "hello", "heartbeat", "resync"]);
    expect(new Set(STREAM_EVENT_NAMES).size).toBe(EVENT_LOG_TYPES.length + STREAM_CONTROL_EVENTS.length);
  });
});

describe("the stream's payloads", () => {
  it("fit event_log's JSON column", () => {
    expectTypeOf<StreamPayloads["bid"]>().toExtend<EventLogEntry["payload"]>();
    expectTypeOf<StreamPayloads["lot_closed"]>().toExtend<EventLogEntry["payload"]>();
    expectTypeOf<StreamPayloads["event_status"]>().toExtend<EventLogEntry["payload"]>();
    expectTypeOf<StreamPayloads["hold"]>().toExtend<EventLogEntry["payload"]>();
    expectTypeOf<StreamPayloads["glim"]>().toExtend<EventLogEntry["payload"]>();
    expectTypeOf<StreamPayloads["settlement"]>().toExtend<EventLogEntry["payload"]>();
  });

  it("narrow from the event's type", () => {
    expectTypeOf<Extract<StreamEvent, { type: "hold" }>>().toEqualTypeOf<StreamEventOf<"hold">>();
    expectTypeOf<StreamEventOf<"hold">["payload"]["holdId"]>().toBeString();
  });
});

describe("canSeeStreamRow", () => {
  const guest = { paddleId: "me", isOrganizer: false };
  const organizer = { paddleId: "org", isOrganizer: true };
  const visitor = { paddleId: null, isOrganizer: false };

  it("sends public rows to everyone", () => {
    for (const viewer of [guest, organizer, visitor]) {
      for (const type of EVENT_LOG_TYPES) expect(canSeeStreamRow({ type, paddleId: null }, viewer)).toBe(true);
    }
  });

  it("sends a paddle's rows to that paddle", () => {
    for (const type of EVENT_LOG_TYPES) {
      expect(canSeeStreamRow({ type, paddleId: "me" }, guest)).toBe(true);
      expect(canSeeStreamRow({ type, paddleId: "other" }, guest)).toBe(false);
      expect(canSeeStreamRow({ type, paddleId: "other" }, visitor)).toBe(false);
    }
  });

  it("shows an organizer every paddle's holds and settlement items, and nothing else of theirs", () => {
    const seen = EVENT_LOG_TYPES.filter((type) => canSeeStreamRow({ type, paddleId: "other" }, organizer));
    expect(seen).toEqual(["hold", "settlement"]);
  });
});

describe("the contract's source", () => {
  it("imports only types, so a client component can import it", () => {
    const source = readFileSync(path.join(process.cwd(), "src/server/sse/types.ts"), "utf8");
    const imports = source.split("\n").filter((line) => /^import\s/.test(line));
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((line) => line.startsWith("import type "))).toBe(true);
  });
});

describe("stream positions", () => {
  it("compare as numbers, whatever their length", () => {
    expect(isAfterPosition("10", "9")).toBe(true);
    expect(isAfterPosition("9", "10")).toBe(false);
    expect(isAfterPosition("10", "10")).toBe(false);
    expect(isAfterPosition("9007199254740993", "9007199254740992")).toBe(true);
  });

  it("parse from a header or a URL, or not at all", () => {
    expect(parseStreamPosition("4817")).toBe("4817");
    expect(parseStreamPosition("007")).toBe("7");
    expect(parseStreamPosition("0")).toBe("0");
    expect(parseStreamPosition("9223372036854775807")).toBe("9223372036854775807");
    for (const bad of [null, undefined, "", "-1", "1e3", "12a", " 12", "1".repeat(20), "1;drop table", "9223372036854775808", "9999999999999999999"]) {
      expect(parseStreamPosition(bad)).toBeNull();
    }
  });
});
