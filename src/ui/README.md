Owner area: design system and the guest pages' UI. Ported from the approved mockups (05 rendered with lime #DAF66E as in 06a-lime-soft.png, 07, 08, 10), value for value.

## Tokens (theme.css)

- Numbers are pixels: one spacing unit is 1px, and font sizes and radii are named by their pixel size, so `h-68 px-48 text-11.5 rounded-20` reads like the mockup CSS. Tailwind's default palette, type scale, radii and shadows are cleared; only brand values exist.
- Colors: `lime`, `lime-edge`, `ink`, `ink2`, `muted`, `line`, `surface`, `white`, plus the warm stage greys `stone`, `stone-deep`, `closed`, `panel` and `on-ink-muted` (secondary text on ink). Lime is a fill under ink text or a mark on ink, never text or lines on white.
- Letter spacing: `tracking-caps` (.09em eyebrows), `tracking-label` (.08em), `tracking-status` (.07em), `tracking-display/title/heading/snug` (-.04 to -.01em).
- Utilities: `bg-stone-tile` (lot tiles), `bg-orb` (Glim's body), `non-scaling-stroke` (lot drawings).
- The base line height is `normal`, as in the mockups (Tailwind's preflight would make it 1.5).
- Mono amounts go through `<Money>`, which tightens the thousands comma as every approved screen does.

## Components

`PaddleMark` (brand, winning, outbid, closed), `Orb` (68, 38, 32, 26, 22, 18; `glow="soft"` for 05's agent link), `StatusPill`, `Button` / `buttonClass` (lime, ink, outline, quiet, ghost at 30/36/40/48/56px), `EventNav` (brand, status pill, links, bidding power and paddle pills; design/27: Lots and My paddle, which opens 11 once bidding has closed), `GlimBand`, `CornerOrb`, `Eyebrow`, `Money`, the line icons, and `drawings/` (`LotIllustration` plus every lot drawing in the approved HTML; `RIVERSIDE_LOT_DRAWINGS` maps template lots to them and the seed stores those keys).

Screens: `catalog/CatalogScreen` (08, with `NotSetBand` for design/20 state 1) and `lot/LotDetailScreen` (05; `lot/bid-card-state.ts` picks design/19's nine card states); `power/` (09 and the PayPal window hook, its own README); `glim/` (07, the panel and its cards, with `CornerOrb` and `event/GlimSlot`; `AutopilotCards.tsx` is design/21's V2 and V3, `marks.tsx` the header's pause, play and spinner marks); `paddle/` (10), `receipt/` (11 and the 25b PDF page) and `projector/` (14), each with its own README; `organizer/` (12 and Insights, its own README). `live/` is the browser's side of the stream (its own README). All approved boards in design/ (16 to 29) are built; docs/status/day3.md lists what each one covers and the states still plain.

Countdowns and "2 min ago" run on the server's clock through `ServerClockProvider`. Every control on these screens is wired; a state with no image renders plain, with approved components, and docs/status/day3.md lists them.

## Contracts

- `api.ts`: the browser's fetch wrapper. `apiGet`, `apiPost` and `apiFetch` return the JSON or throw `ApiClientError` with the server's `code`, `message` and `details`.
- `glim-events.ts`: `openGlim({ lotNumber?, prefill?, edit? })` opens the chat from anywhere (`edit` opens the running plan's editor, from 10's "Edit plan"), and the panel listens with `onGlimOpen`. `GlimOpenButton` is the same for a server component.
- `event/LiveProviders.tsx` and `event/GlimSlot.tsx`: what the shared layout (`src/app/e/[slug]/layout.tsx`) renders around every page of an event. The live layer and the Glim panel each fill in their own file.
- `entry/`: design/16 (home), 16b (join) and Fairhold's own nav. Both forms post to Server Actions (`entry/actions.ts`, work in `entry/enter.ts`), so a press before hydration, or with scripts off, is a plain form post answered with the session cookie and a redirect; a hydrated form loads the answer in full. The PayPal sandbox buyer card reads `DEMO_BUYER_1_EMAIL` and `DEMO_BUYER_1_PASSWORD` per request and shows nothing without both; the password only copies.
- `demo/`: what a demo gala adds, through the event layout's `DemoSlot`. design/16c over a gala that ended, was reset or is gone; the Sandbox demo marker in the navs (shown by the slot's `data-demo-gala` flag, so the seeded event keeps its approved look); the creator's role menu with the demo controls on POST /api/events/[slug]/demo/[action] (`RoleMenu`, fed by `demo-store.ts`); and the five-step demo guide on 08 (design/18 with design/21's V5).
- `event/EventFooter.tsx`: "Riverside Shelter Gala · runs on Fairhold", as 16b draws it (only 16b uses it so far).
- `receipt/receipt-href.ts`: the one way to 11 and 25b, used by the nav, 08's band after the close, and 10.
- Spinners: `power/icons.tsx`'s `SpinnerIcon` is design/20's mark; `glim/marks.tsx` (`SpinnerMark`, 10px in the header), `organizer/Spinner.tsx` (its own `ledger-spin` animation) and `paddle/icons.tsx` draw the same ring at their own sizes.

## Fixture and visual checks

`__fixtures__/riverside.ts` is the approved Jamie state at 8:58 PM. `UI_FIXTURE=riverside npm run dev` renders the guest pages from it without a database; `FREEZE_CLOCK_AT=<instant>` freezes the clock for a seeded database instead. `tests/e2e/fidelity.spec.ts` captures the pages at a native 2x for comparison with the approved PNGs (`FIDELITY_DIR=docs/status`).
