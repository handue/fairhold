/**
 * The demo controls of design/18, as plain data: the route each one calls and the line it leaves
 * when it worked. Refusals keep the route's own sentence (POST /api/events/[slug]/demo/[action]).
 */
import { formatClockTime, formatLotNumber } from "../format";

export const DEMO_CONTROLS = ["close-next-lot", "close-bidding", "add-time", "invite", "reset"] as const;
export type DemoControl = (typeof DEMO_CONTROLS)[number];

export const DEMO_CONTROL_LABELS: Record<DemoControl, string> = {
  "close-next-lot": "Close next lot",
  "close-bidding": "Close bidding now",
  "add-time": "Add 10 minutes",
  invite: "Invite a guest",
  reset: "Reset demo",
};

export function demoControlPath(slug: string, control: DemoControl): string {
  return `/api/events/${encodeURIComponent(slug)}/demo/${control}`;
}

/** The answers the route gives, by control. */
export interface DemoControlAnswers {
  "close-next-lot": { lotNumber: number; shortTitle: string; openLots: number };
  "close-bidding": { closedLots: number; eventClosed: boolean };
  "add-time": { closesAt: string };
  invite: { href: string; url: string };
  reset: { href: string };
}

export type DemoControlDone = {
  [Control in Exclude<DemoControl, "invite" | "reset">]: { control: Control; answer: DemoControlAnswers[Control] };
}[Exclude<DemoControl, "invite" | "reset">];

/** What a finished control says, in plain lines: their result states are not drawn. */
export function controlDoneLine(done: DemoControlDone, timeZone: string): string {
  switch (done.control) {
    case "close-next-lot": {
      const { lotNumber, shortTitle, openLots } = done.answer;
      const left = openLots === 0 ? "No lots are open now." : `${openLots} ${openLots === 1 ? "lot is" : "lots are"} still open.`;
      return `Lot ${formatLotNumber(lotNumber)}, ${shortTitle}, is closed. ${left}`;
    }
    case "close-bidding":
      return "Bidding is closed. Charge winners from the control room.";
    case "add-time":
      return `Bidding now closes at ${formatClockTime(Date.parse(done.answer.closesAt), timeZone)}.`;
  }
}
