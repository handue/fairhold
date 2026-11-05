/**
 * The Riverside Shelter Gala as the approved screens tell it, bid by bid, from 7:00 to 9:30 PM.
 * Replaying it gives every figure the screens show: 08 and 05 at 8:58:00, 10 and 14 at
 * 9:15:40, 12 at 9:30. Figures the screens do not show (the other lots' bids, who else used
 * Glim) were chosen to add up to theirs; README.md lists the few that cannot match.
 *
 * Manual bids are written out; Glim's bids follow from the plans, because a limit answers every
 * rival by the minimum raise, exactly as the engine does.
 */
import { dollars } from "./cents";
import type { AuctionScript, BidAmount, GlimItemSpec, ReplayPaddleSpec, ScriptEvent } from "./replay";
import { JAMIE, SIMULATED_GUESTS } from "./roster";
import { storyLotClosesAt } from "./schedule";
import { SECOND, STORY_OPENS_AT, pm } from "./storyClock";
import { CREATOR_PADDLE_NUMBER, RIVERSIDE_LOTS } from "./template";

export interface StoryOptions {
  /**
   * Whether Jamie (paddle 142) takes part. Demo galas leave Jamie out, because paddle 142 is
   * the person who starts the demo; Jamie's hand bid on Lot 21 then belongs to paddle 187.
   */
  withJamie: boolean;
}

/** The paddle that places Jamie's Lot 21 bid when Jamie is not in the story. */
export const LOT_21_STAND_IN = 187;

const JAMIE_HOLD_AUTHORIZED_AT = pm("8:41:10");
// Simulated guests approve their holds just before the doors open, a few seconds apart.
const FIRST_SIMULATED_HOLD_AT = pm("6:52:00");

type ManualBid = [clock: string, paddle: number, amountDollars: number];

class StoryWriter {
  readonly events: ScriptEvent[] = [];

  bids(lot: number, rows: readonly ManualBid[]): void {
    for (const [clock, paddle, amountDollars] of rows) this.bid(lot, clock, paddle, dollars(amountDollars));
  }

  bid(lot: number, clock: string, paddle: number, amount: BidAmount, source: "bot" | "guest" = "bot"): void {
    this.events.push({ kind: "bid", at: pm(clock), lot, paddle, amount, source });
  }

  glim(paddle: number, clock: string, items: [lot: number, maxDollars: number][], openingBids = true): void {
    const specs: GlimItemSpec[] = items.map(([lot, maxDollars]) => ({ lot, maxCents: dollars(maxDollars) }));
    this.events.push({ kind: "glim_plan", at: pm(clock), paddle, items: specs, openingBids });
  }

  glimBid(paddle: number, lot: number, clock: string, amountDollars?: number): void {
    const amount = amountDollars === undefined ? undefined : dollars(amountDollars);
    this.events.push({ kind: "glim_bid", at: pm(clock), paddle, lot, ...(amount === undefined ? {} : { amount }) });
  }
}

/** The evening's events. Lots are written in number order; the replay sorts them by time. */
function writeStory({ withJamie }: StoryOptions): ScriptEvent[] {
  const s = new StoryWriter();

  // Lot 01, Name the Next Shelter Puppy. Rosa (175) outlasts Walter (131): $1,450.
  s.bids(1, [
    ["7:06:10", 103, 100], ["7:14:40", 105, 150], ["7:23:20", 103, 200], ["7:31:50", 106, 250], ["7:40:30", 105, 300],
    ["7:47:10", 106, 350],
  ]);
  s.glim(101, "7:52:00", [[1, 500]]);
  s.bids(1, [
    ["8:02:30", 102, 400], ["8:11:40", 103, 450], ["8:19:20", 102, 525], ["8:33:50", 131, 800],
    ["8:50:20", 175, 1_150],
  ]);
  s.bids(1, [["9:03:00", 131, 1_200], ["9:08:20", 175, 1_275], ["9:27:30", 131, 1_400], ["9:28:40", 175, 1_450]]);

  // Lot 02, Hot Air Balloon Ride for Two. Owen (168): $780.
  s.bids(2, [["7:08:30", 111, 250], ["7:19:10", 114, 300], ["7:30:40", 111, 350], ["7:42:20", 114, 400]]);
  s.glim(113, "7:55:00", [[2, 525]]);
  s.bids(2, [
    ["8:04:10", 108, 450], ["8:13:30", 114, 500], ["8:21:50", 108, 550], ["8:30:30", 168, 600], ["8:55:10", 122, 700],
  ]);
  s.bids(2, [["9:04:00", 168, 725], ["9:12:30", 122, 750], ["9:26:40", 168, 780]]);

  // Lot 03, Weekend Cabin Stay: $640 and 19 bids at 8:58; Elena (104) at $720 when it closes.
  s.bids(3, [
    ["7:03:20", 116, 250], ["7:10:50", 118, 270], ["7:17:30", 116, 290], ["7:24:10", 123, 310], ["7:30:40", 118, 330],
  ]);
  s.glim(125, "7:36:00", [[3, 450]]);
  s.bids(3, [["7:44:20", 123, 370], ["7:51:30", 124, 410], ["7:58:50", 177, 460]]);
  s.glim(134, "8:05:00", [[3, 560]]);
  s.bids(3, [
    ["8:12:40", 124, 500], ["8:20:10", 139, 540], ["8:27:30", 177, 580], ["8:36:40", 104, 600], ["8:52:10", 139, 640],
  ]);
  s.bids(3, [["9:00:30", 177, 680], ["9:03:10", 104, 720]]);

  // Lot 04, Riverside Theater Season Tickets. Ben (121) through Glim: $600, his limit.
  s.bids(4, [["7:04:40", 129, 200], ["7:13:10", 132, 240], ["7:21:50", 129, 260]]);
  s.glim(115, "7:28:00", [[4, 340]]);
  s.bids(4, [["7:37:30", 132, 300], ["7:46:10", 135, 340], ["7:58:40", 129, 360], ["8:09:20", 135, 400]]);
  s.glim(121, "8:20:00", [[4, 600]]);
  s.bids(4, [["8:31:40", 148, 440], ["8:46:30", 148, 480], ["9:06:00", 148, 540]]);
  // Raymond (119) turns Glim on late; Ben's and Theo's limits answer at once.
  s.glim(119, "9:20:00", [[4, 580], [15, 270]]);

  // Lot 05, Hand-thrown Pottery Set: $150 and 8 bids at 8:58; Hannah (151) at $170.
  s.bids(5, [["7:09:30", 169, 60], ["7:22:40", 173, 70], ["7:35:10", 169, 80]]);
  s.glim(144, "7:50:00", [[5, 110]]);
  s.bids(5, [["8:06:20", 173, 100], ["8:24:50", 176, 120], ["8:41:30", 137, 150]]);
  s.bids(5, [["9:01:50", 176, 160], ["9:05:30", 151, 170]]);

  // Lot 06, Sailing Afternoon on the Bay. Aisha (138) through Glim: $520.
  s.bids(6, [["7:07:20", 141, 200], ["7:18:30", 143, 220], ["7:29:40", 141, 260]]);
  s.glim(128, "7:40:00", [[6, 380]]);
  s.bids(6, [["7:52:20", 143, 300], ["8:03:40", 145, 340], ["8:15:10", 165, 380], ["8:38:20", 145, 460]]);
  s.glim(138, "9:02:00", [[6, 520]]);
  s.bids(6, [["9:23:30", 165, 500]]);

  // Lot 07, Chef's Table Dinner for Four: 088 at $300 five minutes before 8:58, then Jamie at
  // $320; at 9:14 088 bids $360 and Glim answers $380, Jamie's limit.
  s.bids(7, [
    ["7:12:10", 184, 100], ["7:26:40", 149, 120], ["7:39:20", 184, 140], ["7:51:50", 152, 160], ["8:03:30", 149, 180],
    ["8:14:10", 88, 200],
  ]);
  s.bids(7, [
    ["8:24:40", 152, 220], ["8:33:20", 154, 240], ["8:41:00", 88, 260], ["8:47:30", 154, 280], ["8:52:40", 88, 300],
  ]);
  if (withJamie) s.bid(7, "8:55:45", CREATOR_PADDLE_NUMBER, dollars(320), "guest");
  s.bids(7, [["9:14:05", 88, 360]]);

  // Lot 08, Bakery Box for a Year. Nora (156) through Glim: $300.
  s.bids(8, [["7:15:20", 159, 100], ["7:27:50", 157, 120]]);
  s.glim(136, "7:36:00", [[8, 170]]);
  s.bids(8, [["7:48:30", 159, 140], ["7:59:10", 157, 160], ["8:09:40", 162, 190], ["8:17:30", 159, 210]]);
  s.glim(156, "8:25:00", [[8, 300], [11, 120]]);
  s.bids(8, [["8:36:10", 162, 230], ["8:51:40", 157, 250], ["9:04:30", 162, 270], ["9:25:00", 157, 290]]);

  // Lot 09, Private Wine Tasting for Six: $210 and 10 bids at 8:58; sold to Marcus (133)
  // through Glim at $380 when it closes at 9:10.
  s.bids(9, [
    ["7:11:40", 166, 120], ["7:24:20", 167, 130], ["7:37:50", 166, 140], ["7:49:10", 178, 150], ["8:00:40", 167, 160],
    ["8:12:20", 178, 170], ["8:26:50", 166, 180],
  ]);
  s.glim(133, "8:40:00", [[9, 380], [10, 320]]);
  s.bids(9, [["8:50:30", 167, 200]]);
  s.bids(9, [
    ["9:00:20", 165, 230], ["9:02:40", 166, 260], ["9:05:10", 167, 300], ["9:07:20", 90, 340], ["9:09:05", 90, 370],
  ]);

  // Lot 10, Wine Club, Six Months. Marcus (133) through Glim: $320.
  s.bids(10, [["7:17:40", 187, 120], ["7:33:10", 94, 140]]);
  s.glim(146, "7:41:00", [[10, 200]]);
  s.bids(10, [["7:53:40", 187, 160], ["8:06:10", 94, 180], ["8:18:30", 96, 210], ["8:30:50", 94, 230]]);
  s.bids(10, [["8:47:00", 96, 250], ["8:54:10", 94, 270], ["9:08:30", 96, 290], ["9:26:00", 94, 310]]);

  // Lot 11, Coffee Roaster Tour. Nora (156) through Glim: $120.
  s.bids(11, [["7:20:30", 98, 40], ["7:34:50", 111, 45]]);
  s.glim(155, "7:45:00", [[11, 70]]);
  s.bids(11, [["7:57:20", 98, 55], ["8:08:40", 111, 65], ["8:19:50", 98, 80], ["8:22:10", 111, 85]]);
  s.bids(11, [["8:44:20", 98, 95], ["9:01:30", 111, 105], ["9:21:40", 98, 115]]);

  // Lot 12, Spa Day for Two: $85 and 4 bids until Glim's opening $90 for Jamie at 9:12.
  s.bids(12, [["7:25:10", 169, 40], ["7:58:30", 173, 55], ["8:22:00", 169, 70], ["8:44:50", 173, 85]]);

  // Lot 13, Massage Package. Kenji (188) through Glim: $230.
  s.bids(13, [["7:10:20", 127, 90], ["7:23:00", 132, 110]]);
  s.glim(164, "7:35:00", [[13, 160]]);
  s.bids(13, [["7:47:40", 127, 130], ["8:01:10", 132, 150], ["8:16:30", 127, 175], ["8:42:40", 132, 200]]);
  s.glim(188, "9:03:00", [[13, 230]]);
  s.bids(13, [["9:24:30", 127, 220]]);

  // Lot 14, Original Watercolor: $275 and 7 bids at 8:58; Glim's $300 for Diego (163) at 9:11.
  s.bids(14, [["7:13:40", 127, 150], ["7:26:10", 98, 170], ["7:38:50", 127, 190]]);
  s.glim(107, "7:44:00", [[14, 220]]);
  s.bids(14, [["7:56:30", 98, 230], ["8:18:40", 127, 255], ["8:45:10", 98, 275]]);
  // 14 shows $300, though Glim's usual opening bid would be the next minimum, $295.
  s.glim(163, "9:11:00", [[14, 300]], false);
  s.glimBid(163, 14, "9:11:10", 300);

  // Lot 15, Cooking Class for Four. Theo (179) through Glim: $280.
  s.bids(15, [["7:16:30", 148, 100]]);
  s.glim(174, "7:33:00", [[15, 150]]);
  s.bids(15, [["7:45:20", 122, 120], ["7:58:00", 148, 140], ["8:10:40", 122, 165], ["8:22:30", 148, 190]]);
  s.glim(179, "8:30:00", [[15, 280]]);
  s.bids(15, [["8:38:20", 122, 210], ["8:52:50", 148, 230], ["9:07:50", 122, 250]]);

  // Lot 16, Fine-Art Photo Print. Grace (112): $180.
  s.bids(16, [["7:18:50", 116, 80], ["7:32:10", 118, 100], ["7:46:20", 116, 120]]);
  s.glim(153, "8:00:00", [[16, 140], [17, 110]]);
  s.bids(16, [["8:20:30", 118, 150], ["9:05:50", 112, 160], ["9:10:10", 116, 170], ["9:14:20", 112, 180]]);

  // Lot 17, Ceramics Workshop for Two. Samuel (126): $150.
  s.bids(17, [["7:21:20", 129, 60], ["7:37:40", 141, 80], ["7:52:30", 129, 100]]);
  s.bids(17, [["8:28:40", 141, 130], ["9:09:30", 129, 140], ["9:25:20", 126, 150]]);

  // Lot 18, Family Portrait Session: $120 and 5 bids at 8:58; Chris (109) at $150 from 9:09.
  s.bids(18, [["7:28:30", 152, 60], ["7:50:10", 154, 80], ["8:07:40", 152, 90]]);
  s.glim(92, "8:15:00", [[18, 110]]);
  s.bids(18, [["8:34:20", 154, 120], ["9:02:20", 152, 130], ["9:05:40", 157, 140], ["9:09:10", 109, 150]]);

  // Lot 19, Yoga, Ten Classes. Mateo (171): $170.
  s.bids(19, [["7:30:20", 137, 60], ["7:49:00", 143, 80]]);
  s.glim(161, "8:05:00", [[19, 110]]);
  s.bids(19, [
    ["8:26:10", 137, 100], ["8:39:50", 143, 130], ["9:02:00", 171, 140], ["9:06:00", 137, 150], ["9:12:00", 143, 160],
    ["9:27:00", 171, 170],
  ]);

  // Lot 20, Dog Grooming Package. Iris (185): $175.
  s.bids(20, [["7:35:40", 149, 50], ["7:55:00", 152, 60], ["8:12:00", 149, 80]]);
  s.glim(172, "8:20:00", [[20, 100]]);
  s.bids(20, [["8:43:30", 152, 125], ["9:04:00", 185, 135], ["9:10:30", 149, 150], ["9:26:00", 185, 175]]);

  // Lot 21, Dog Walking, One Month: Jamie's $90 by hand, outbid by Priya (117) at $95.
  s.bids(21, [["7:15:50", 178, 40], ["7:40:10", 181, 50], ["8:05:30", 178, 60], ["8:28:20", 181, 75]]);
  if (withJamie) s.bid(21, "8:47:30", CREATOR_PADDLE_NUMBER, dollars(90), "guest");
  else s.bid(21, "8:47:30", LOT_21_STAND_IN, dollars(90));
  s.bids(21, [["8:49:10", 117, 95]]);

  // Lot 22, Golf Lesson with a Pro: no bids all evening.

  // Lot 23, Custom Pet Portrait. Priya (117): $260.
  s.bids(23, [["7:38:20", 165, 80], ["7:52:40", 148, 100], ["8:04:10", 165, 120]]);
  s.glim(182, "8:10:00", [[23, 160]]);
  s.bids(23, [["8:21:30", 148, 140], ["8:29:40", 165, 170]]);
  s.glim(186, "8:35:00", [[23, 210]]);
  s.bids(23, [["8:48:20", 148, 220], ["9:03:20", 117, 240], ["9:07:00", 165, 250], ["9:11:40", 117, 260]]);

  // Lot 24, Behind-the-Scenes Shelter Day. Leo (147) through Glim: $340.
  s.bids(24, [["7:19:30", 102, 50], ["7:31:00", 139, 70]]);
  s.glim(183, "7:42:00", [[24, 150]]);
  s.bids(24, [
    ["7:50:40", 102, 90], ["7:57:50", 139, 110], ["8:01:30", 102, 130], ["8:06:40", 139, 160], ["8:08:20", 102, 190],
    ["8:09:30", 139, 230],
  ]);
  s.glim(147, "8:10:00", [[24, 340]]);
  s.bids(24, [["8:20:10", 102, 250], ["8:35:30", 139, 270], ["8:49:40", 102, 290], ["9:03:40", 139, 310]]);
  s.glim(158, "9:21:00", [[24, 330], [20, 160]]);

  if (withJamie) {
    // 07: "Chef's Table up to $380, Spa Day up to $120." Jamie already leads Lot 07, and 10
    // shows the plan at 9:11 and the Spa Day bid at 9:12, so the opening bid is its own event.
    s.glim(CREATOR_PADDLE_NUMBER, "9:11:20", [[7, 380], [12, 120]], false);
    s.glimBid(CREATOR_PADDLE_NUMBER, 12, "9:12:05");
  }

  return s.events;
}

function storyPaddles({ withJamie }: StoryOptions): ReplayPaddleSpec[] {
  const simulated = SIMULATED_GUESTS.map((guest, index) => ({
    number: guest.number,
    holdCents: guest.holdCents,
    holdAuthorizedAt: new Date(FIRST_SIMULATED_HOLD_AT.getTime() + index * 5 * SECOND),
  }));
  if (!withJamie) return simulated;
  const jamie = { number: JAMIE.number, holdCents: JAMIE.holdCents, holdAuthorizedAt: JAMIE_HOLD_AUTHORIZED_AT };
  return [...simulated, jamie];
}

/** The whole evening as a replayable script, on the story's own clock. */
export function riversideStory(options: StoryOptions): AuctionScript {
  return {
    opensAt: STORY_OPENS_AT,
    lots: RIVERSIDE_LOTS.map((lot) => ({
      number: lot.number,
      startingBidCents: lot.startingBidCents,
      minRaiseCents: lot.minRaiseCents,
      closesAt: storyLotClosesAt(lot.number),
    })),
    paddles: storyPaddles(options),
    events: writeStory(options),
  };
}

/** Jamie's favorite on 05, which makes 08 offer "Let Glim watch" on Lot 12. */
export const JAMIE_FAVORITES = [{ lot: 12, at: pm("8:50:00") }] as const;
