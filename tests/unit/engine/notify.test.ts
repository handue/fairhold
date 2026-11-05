import { describe, expect, it } from "vitest";

import { parseEventLogNotification } from "@/server/sse/notify";

describe("parseEventLogNotification", () => {
  it("reads the routing keys of a notification", () => {
    expect(
      parseEventLogNotification('{"id":"42","eventId":"e-1","paddleId":null,"type":"bid"}'),
    ).toEqual({ id: "42", eventId: "e-1", paddleId: null, type: "bid" });
    expect(parseEventLogNotification('{"id":"43","eventId":"e-1","paddleId":"p-142","type":"glim"}')?.paddleId).toBe(
      "p-142",
    );
  });

  it("rejects anything malformed instead of throwing", () => {
    for (const payload of [undefined, "", "not json", "null", "[]", '{"id":42,"eventId":"e","paddleId":null,"type":"bid"}', '{"id":"1","eventId":"e","paddleId":7,"type":"bid"}', '{"id":"1","eventId":"e","paddleId":null,"type":"refund"}']) {
      expect(parseEventLogNotification(payload)).toBeNull();
    }
  });
});
