/**
 * The words of 14 that follow the figures (design/26). Pure, so the screen and its tests agree.
 */
import type { ProjectorListNote, ProjectorPhase, ProjectorView } from "@/server/queries/projector-view";

import { formatClockTime } from "../format";
import { lotClockTime } from "../paddle/time";

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "24 lots · 86 bidders", "24 lots" before open, "23 of 24 lots sold · 86 bidders" after. */
export function roomLabel(view: Pick<ProjectorView, "phase" | "lotCount" | "soldCount" | "bidderCount">): string {
  const lots = count(view.lotCount, "lot", "lots");
  if (view.phase === "before") return lots;
  const bidders = count(view.bidderCount, "bidder", "bidders");
  if (view.phase === "after") return `${view.soldCount} of ${lots} sold · ${bidders}`;
  return `${lots} · ${bidders}`;
}

/** The right column's heading. */
export function listTitle(phase: ProjectorPhase): string {
  return phase === "before" ? "Tonight’s lots" : phase === "after" ? "Top lots" : "Closing next";
}

/** "16 more lots at 9:30 PM", "20 more lots by 9:30 PM", "Last 3 lots", "Last lot", "19 more lots sold". */
export function listNote(note: ProjectorListNote, timeZone: string): string | null {
  if (!note) return null;
  switch (note.kind) {
    case "more":
      return `${count(note.count, "more lot", "more lots")} ${note.sameTime ? "at" : "by"} ${formatClockTime(note.at, timeZone)}`;
    case "last":
      return note.count === 1 ? "Last lot" : `Last ${note.count} lots`;
    case "sold":
      return `${count(note.count, "more lot", "more lots")} sold`;
  }
}

/** The raised card's label. */
export function firstLabel(phase: ProjectorPhase): string {
  return phase === "before" ? "First to close" : phase === "after" ? "Top lot" : "Closing now";
}

/** "9:06": a lot's close to the nearest minute with no AM or PM, as 26 lists lots before bidding opens. */
export function shortClock(at: number, timeZone: string): string {
  return lotClockTime(at, timeZone).replace(/ [AP]M$/, "");
}

export interface ProjectorBubble {
  title: string;
  body: string;
}

const INVITATION: ProjectorBubble = { title: "Want me to bid for you?", body: "Scan the code and tell me your budget." };

/** Glim speaks for the gala, about the guests it bids for; before anyone uses it, it invites the room. */
export function projectorBubble(view: Pick<ProjectorView, "phase" | "glim">): ProjectorBubble | null {
  const { phase, glim } = view;
  if (phase === "before") return INVITATION;
  if (glim.guests === 0) return phase === "live" ? INVITATION : null;
  const bids = `${count(glim.bids, "bid", "bids")}${glim.withinLimits ? ", all within their limits." : "."}`;
  const guests = count(glim.guests, "guest", "guests");
  return { title: phase === "after" ? `I bid for ${guests}` : `I’m bidding for ${guests}`, body: bids };
}

/**
 * The band's two lines. Decision C6: in a demo the simulated guests hold nothing with PayPal, so the
 * first line speaks to the guest ("Your bids…") rather than claiming every bid.
 */
export function trustLines(view: Pick<ProjectorView, "phase" | "isDemo" | "pickupNote">): [string, string | null] {
  if (view.phase === "after") {
    // 26 reads the pickup note from the room's side: "your receipt", not "this receipt".
    const pickup = view.pickupNote ? view.pickupNote.replace(/^Show this receipt/, "Show your receipt") : null;
    return ["Winners pay only for the lots they won.", pickup];
  }
  return [
    view.isDemo ? "Your bids are backed by bidding power held with PayPal." : "Every bid is backed by bidding power held with PayPal.",
    "Winners pay only for the lots they win.",
  ];
}
