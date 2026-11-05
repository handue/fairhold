Owner area: design system and the guest pages' UI. Ported from the approved mockups (05 rendered with lime #DAF66E as in 06a-lime-soft.png, 07, 08, 10), value for value.

## Tokens (theme.css)

- Numbers are pixels: one spacing unit is 1px, and font sizes and radii are named by their pixel size, so `h-68 px-48 text-11.5 rounded-20` reads like the mockup CSS. Tailwind's default palette, type scale, radii and shadows are cleared; only brand values exist.
- Colors: `lime`, `lime-edge`, `ink`, `ink2`, `muted`, `line`, `surface`, `white`, plus the warm stage greys `stone`, `stone-deep`, `closed`, `panel` and `on-ink-muted` (secondary text on ink). Lime is a fill under ink text or a mark on ink, never text or lines on white.
- Letter spacing: `tracking-caps` (.09em eyebrows), `tracking-label` (.08em), `tracking-status` (.07em), `tracking-display/title/heading/snug` (-.04 to -.01em).
- Utilities: `bg-stone-tile` (lot tiles), `bg-orb` (Glim's body), `non-scaling-stroke` (lot drawings).
- The base line height is `normal`, as in the mockups (Tailwind's preflight would make it 1.5).
- Mono amounts go through `<Money>`, which tightens the thousands comma as every approved screen does.

## Components

`PaddleMark` (brand, winning, outbid, closed), `Orb` (68, 38, 32, 26, 22, 18; `glow="soft"` for 05's agent link), `StatusPill`, `Button` / `buttonClass` (lime, ink, outline, quiet, ghost at 30/36/40/48/56px), `EventNav` (brand, status pill, links, bidding power and paddle pills), `GlimBand`, `CornerOrb`, `Eyebrow`, `Money`, the line icons, and `drawings/` (`LotIllustration` plus every lot drawing in the approved HTML; `RIVERSIDE_LOT_DRAWINGS` maps template lots to them and the seed stores those keys).

Screens: `catalog/CatalogScreen` (08) and `lot/LotDetailScreen` (05), fed by `src/server/queries`.

Countdowns and "2 min ago" run on the server's clock through `ServerClockProvider`. Controls whose server side lands later render in their final form and log through `logPendingAction` (search for it to find what is left to wire).

## Fixture and visual checks

`__fixtures__/riverside.ts` is the approved Jamie state at 8:58 PM. `UI_FIXTURE=riverside npm run dev` renders the guest pages from it without a database; `FREEZE_CLOCK_AT=<instant>` freezes the clock for a seeded database instead. `tests/e2e/fidelity.spec.ts` captures the pages at a native 2x for comparison with the approved PNGs (`FIDELITY_DIR=docs/status`).
