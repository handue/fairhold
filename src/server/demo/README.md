Owner area: demo. Demo gala cloning, the seeded Riverside template, the director bots, demo controls and the 6-hour cleanup.

## Modules

- `template.ts`: the event settings and the 24 approved lots (13's intake table), with short titles.
- `roster.ts`: the 85 simulated guests and Jamie (paddle 142), with holds that add up to 12.
- `story.ts`: the gala's evening, bid by bid, 7:00 to 9:30 PM. `replay.ts` replays it under the engine's
  rules (open lot, next minimum, hold invariant, Glim limits answering by the minimum raise) and throws
  on any script that breaks them.
- `schedule.ts`: lot close times on the story's evening and in a 25-minute demo.
- `demoPlan.ts`, `fixturePlan.ts`: the rows of a demo gala or of the fixture, before any database work.
- `persist.ts`: writes those rows with direct inserts. `createDemoEvent.ts` is the public entry point.

## Fixture moments

`createFixtureEvent({ moment })` and `npm run db:seed -- --moment=<name>` recreate `riverside-shelter-gala`
as one approved screen shows it. Times are the story's real instants (Saturday, November 7, 2026, PST), so
the app's clock must be frozen at `FIXTURE_MOMENTS[moment]` to render the approved countdowns.

| moment | instant | screens |
| --- | --- | --- |
| `catalog` (default) | 8:58:00 PM | 08 Lots, 05 Lot 07 |
| `paddle` | 9:15:40 PM | 10 My paddle, 14 Projector, 07's event card |
| `closed` | 9:30:00 PM | 12 Control room, before charging |

## Figures that cannot all match

- 08's $6,840 includes Jamie's $320 on Lot 07. A demo opens with Lot 07 at $300 after 11 bids, so it opens
  at $6,820, and the creator's first bid ($320, the 12th) brings it to 08's $6,840.
- 08 and 05 show 8:58:00 PM; 10 and 14 show 9:15:40 PM. One fixture cannot show both, hence the moments.
- 14 shows Glim's opening bid for paddle 163 on Lot 14 at $300, though the next minimum was $295 and Glim
  bids the minimum. Seeded at $300.
- Close times read rounded to the nearest minute: Lot 07 closes at 9:16:42 ("Won at 9:17 PM" on 11),
  Lot 05 at 9:07:30 and Lot 03 at 9:05:55 (9:08 and 9:06 in 14's activity).
- 12 names Lot 23 "Custom Pet Portrait" and Lot 09 by its full title in "Lots won"; 13's Glim bubble says
  "Pet Portrait". Short titles follow Glim's copy.
- Rows past 12's first page come from its brief and were adjusted: the brief's Diego A. won the watercolor
  at $310, which cannot follow 14's $300 with a $20 raise, so 163 (Diego A.) wins it at $300; Chris D. (109)
  leads Family Portrait on 14 and nobody bids after, so he wins it, on a $250 hold.
- Sheet A (not yet approved) shows Lot 22 closing at 9:10 PM; 14 has 16 lots closing at 9:30, which must
  include Lot 22.
