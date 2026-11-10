import type { ReactNode } from "react";

/**
 * The lot drawings of the approved screens, copied path for path. Tile art lives on the shared
 * 120x90 grid (08, 10, 11, 13, 14); the lot page (05) adds a hero cloche on a 190x150 grid and
 * four thumbnail icons on their own grids.
 *
 * design/29 draws all 24 lot covers on that grid: the 8 below from the approved screens, 5 from
 * 13b (the balloon, ticket, sailboat, flag and framed cat) and 11 new ones, after them.
 */
export interface DrawingArt {
  viewBox: string;
  width: number;
  height: number;
  strokeWidth: number;
  /** Keep the line weight whatever the scale (the 120x90 tile art). */
  fixedStroke: boolean;
  /** The 05 hero and two of its thumbnails were drawn with the browser's default (miter) joins. */
  roundJoins: boolean;
  paths: ReactNode;
}

export interface Drawing {
  tile?: DrawingArt;
  hero?: DrawingArt;
  thumb?: DrawingArt;
}

const tile = (paths: ReactNode): DrawingArt => ({
  viewBox: "0 0 120 90",
  width: 140,
  height: 105,
  strokeWidth: 1.5,
  fixedStroke: true,
  roundJoins: true,
  paths,
});

/** The two lines every tile drawing stands on. */
const ground = (
  <>
    <path d="M14 72H106" />
    <path d="M28 78H92" opacity=".35" />
  </>
);

export const DRAWINGS = {
  cloche: {
    tile: tile(
      <>
        <circle cx="60" cy="26.6" r="3.6" />
        <path d="M21.2 70.8c0-21.5 17.3-38.8 38.8-38.8s38.8 17.3 38.8 38.8" />
        <path d="M14 72H106" />
        <path d="M27.2 78H92.8" opacity=".35" />
        <path d="M37.9 54.1c3.6-7.2 9.6-12.5 16.7-14.9" opacity=".5" />
      </>,
    ),
    hero: {
      viewBox: "0 0 190 150",
      width: 300,
      height: 230,
      strokeWidth: 1.3,
      fixedStroke: false,
      roundJoins: false,
      paths: (
        <>
          <circle cx="95" cy="30" r="6" />
          <path d="M30 104c0-36 29-65 65-65s65 29 65 65" />
          <path d="M18 106h154" />
          <path d="M40 116h110" opacity=".35" />
          <path d="M58 76c6-12 16-21 28-25" opacity=".5" />
        </>
      ),
    },
    thumb: {
      viewBox: "0 0 190 150",
      width: 40,
      height: 32,
      strokeWidth: 5,
      fixedStroke: false,
      roundJoins: false,
      paths: (
        <>
          <path d="M30 104c0-36 29-65 65-65s65 29 65 65" />
          <path d="M18 106h154" />
        </>
      ),
    },
  },
  "wine-glass": {
    thumb: {
      viewBox: "0 0 24 32",
      width: 26,
      height: 34,
      strokeWidth: 1.6,
      fixedStroke: false,
      roundJoins: false,
      paths: (
        <>
          <path d="M5 2h14l-1 9a6 6 0 0 1-12 0z" />
          <path d="M12 17v11" />
          <path d="M7 29h10" />
        </>
      ),
    },
  },
  "chef-hat": {
    thumb: {
      viewBox: "0 0 34 30",
      width: 34,
      height: 30,
      strokeWidth: 1.6,
      fixedStroke: false,
      roundJoins: true,
      paths: (
        <>
          <path d="M9 16a6 6 0 1 1 3-10 7 7 0 0 1 11 0 6 6 0 1 1 3 10v10H9z" />
          <path d="M9 21h17" />
        </>
      ),
    },
  },
  "menu-card": {
    thumb: {
      viewBox: "0 0 34 24",
      width: 34,
      height: 24,
      strokeWidth: 1.6,
      fixedStroke: false,
      roundJoins: false,
      paths: (
        <>
          <rect x="1" y="1" width="32" height="22" rx="3" />
          {/* Only these two lines have round caps in the approved thumbnail. */}
          <path d="M7 9h12M7 14h8" strokeLinecap="round" />
        </>
      ),
    },
  },
  dog: {
    tile: tile(
      <>
        <g transform="translate(-6 0) translate(62 72) scale(1.12) translate(-62 -72)">
          <path d="M62 27C63 22.5 66 20.5 69.5 20.5C73 20.5 75.5 22.5 76.5 24.5L84 26.5C86.5 27.2 86.5 30.8 84 31.2L77.5 32.5C75.5 33 74.5 34.5 74.5 37C74.5 42 74 47 73 52L73 72" />
          <path d="M62 27C60 33 58 37 56 41C52 48 44 52 41 59C38.5 65 41 72 47 72" />
          <path d="M57 72C61.5 69 62 61.5 56 57.5" />
          <path d="M69.5 56V72" />
          <path d="M41 69.5C36 71 31 70 29 66.5" />
          <path d="M65 24C61.5 27 60.5 33 62.5 38" />
          <circle cx="72.5" cy="25.5" r="1.25" className="fill-ink" stroke="none" />
          <path d="M57.5 38.5C62 41 69 41 74.5 38.5" />
        </g>
        {ground}
      </>,
    ),
  },
  "spa-stones": {
    tile: tile(
      <>
        <g transform="translate(-5 0)">
          <ellipse cx="50" cy="64" rx="22" ry="8" />
          <ellipse cx="50" cy="49" rx="16" ry="7" />
          <ellipse cx="50" cy="36.5" rx="10.5" ry="5.5" />
          <path d="M82 72C80 58 86 46 100 40C102 54 94 66 82 72Z" />
          <path d="M82 72C86 62 92 52 100 40" opacity=".5" />
        </g>
        {ground}
      </>,
    ),
  },
  steam: {
    tile: tile(
      <>
        <path d="M44 64c-6-6 6-10 0-16s6-10 0-16" />
        <path d="M60 64c-6-6 6-10 0-16s6-10 0-16" />
        <path d="M76 64c-6-6 6-10 0-16s6-10 0-16" />
        {ground}
      </>,
    ),
  },
  "day-passes": {
    tile: tile(
      <>
        <path d="M44 44V33H92V43A4.5 4.5 0 0 0 92 52V66H80" />
        <path d="M30 44H80V53.5A4.5 4.5 0 0 0 80 62.5V72H30V62.5A4.5 4.5 0 0 0 30 53.5Z" />
        <path d="M65 48V68" strokeDasharray="3 4" opacity=".5" />
        {ground}
      </>,
    ),
  },
  cabin: {
    tile: tile(
      <>
        <g transform="translate(-3.5 0)">
          <path d="M20 48L52 22L84 48" />
          <path d="M26 43.1V72M78 43.1V72" />
          <path d="M46 72V61a6 6 0 0 1 12 0v11" />
          <circle cx="52" cy="38" r="3.5" />
          <path d="M66 33.4V26h6v12.25" />
          <path d="M69 21.5c-2.5-2.5 2.5-5 0-7.5" opacity=".5" />
          <path d="M98 72v-7" />
          <path d="M89 65L98 42L107 65Z" />
        </g>
        <path d="M12 72H108" />
        <path d="M28 78H92" opacity=".35" />
      </>,
    ),
  },
  pottery: {
    tile: tile(
      <>
        <path d="M38 24C38 28 39 30.5 39 32.5C31 35.5 25 42.5 25 52.5C25 61.5 30 67.5 34 72H48C52 67.5 57 61.5 57 52.5C57 42.5 51 35.5 43 32.5C43 30.5 44 28 44 24" />
        <path d="M35.5 24H46.5" />
        <path d="M29 46C37 49 45 49 53 46" opacity=".5" />
        <ellipse cx="79" cy="58" rx="16" ry="3.5" />
        <path d="M63 58C63 66.5 70 72 79 72C88 72 95 66.5 95 58" />
        {ground}
      </>,
    ),
  },
  wine: {
    tile: tile(
      <>
        <path d="M37 14H43V31C43 35 50 36 50 43V72H30V43C30 36 37 35 37 31Z" />
        <path d="M37 19H43" />
        <path d="M33 52H47V63H33Z" opacity=".5" />
        <path d="M67 28C66 38 68 50 77 51C86 50 88 38 87 28Z" />
        <path d="M77 51V72" />
        <path d="M67.5 38H86.5" opacity=".5" />
        <path d="M16 72H104" />
        <path d="M28 78H92" opacity=".35" />
      </>,
    ),
  },
  camera: {
    tile: tile(
      <>
        <rect x="28" y="32" width="64" height="40" rx="8" />
        <path d="M46 32L50 24H70L74 32" />
        <circle cx="60" cy="52" r="12" />
        <circle cx="60" cy="52" r="6" opacity=".5" />
        <circle cx="82" cy="40" r="1.6" />
        <path d="M34 32V29H40V32" />
        {ground}
      </>,
    ),
  },
  watercolor: {
    tile: tile(
      <>
        <rect x="30" y="20" width="60" height="52" rx="2" />
        <path d="M36 52H84" />
        <path d="M59 52A7 7 0 0 1 73 52" />
        <path d="M44 49.5V38L51.5 49Z" />
        <path d="M41 50.5H54" />
        <path d="M61 57.5H71M63.5 62H68.5" opacity=".5" />
        {ground}
      </>,
    ),
  },

  // design/29, in lot order.
  puppy: {
    tile: tile(
      <>
        <g transform="translate(-4 0)">
          <path d="M47.5 31.5C49.5 29 52.5 27.5 56 27.5C61 27.5 65 30.5 66.5 34.5L70.5 36C73 37 73 40.6 70.5 41.5L66 43C64.5 47 60.5 49.5 56 49.5C53 49.5 50 48.4 48 46.4" />
          <path d="M49 30.5C44 29.5 40.5 33.5 41 39.5C41.4 44 44 46.8 46.6 45.2C49.3 43.5 50 37 49 30.5Z" />
          <circle cx="62" cy="36.5" r="1.25" className="fill-ink" stroke="none" />
          <path d="M47 50C43 54.5 39.5 59.5 39.5 65C39.5 69 42 72 46 72" />
          <path d="M63.5 51.5C64.3 56.5 64.5 63.5 64 72" />
          <path d="M58.5 62V72" />
          <path d="M54.5 72C57.5 69 57.5 63 51.5 60" />
          <path d="M40 67C36.5 67.5 33.5 65.5 32.5 62" />
          <path d="M47 50C51.5 53.5 58.5 54 63.5 51.5" />
        </g>
        <path d="M58 53.5C65 57.5 71 54 76.5 48.5" strokeDasharray="3 4" opacity=".5" />
        <path d="M76 47L82 40.5H101V56H82Z" />
        <circle cx="81.5" cy="48.2" r="1.5" />
        <path d="M88.5 45.5C88.8 43.2 94.6 43 94.8 46C94.9 48.2 91.9 48.3 91.8 50.6" />
        <circle cx="91.8" cy="53.4" r=".9" className="fill-ink" stroke="none" />
        {ground}
      </>,
    ),
  },
  balloon: {
    tile: tile(
      <>
        <path d="M60 15C46.5 15 38 25 38 37C38 48.5 48 55 53.5 61H66.5C72 55 82 48.5 82 37C82 25 73.5 15 60 15Z" />
        <path d="M60 15C53 24 52 46 56 61M60 15C67 24 68 46 64 61" opacity=".5" />
        <path d="M54.5 61L56 65.5M65.5 61L64 65.5" />
        <rect x="55" y="65.5" width="10" height="6.5" rx="1.5" />
        {ground}
      </>,
    ),
  },
  "theater-ticket": {
    tile: tile(
      <>
        <g transform="rotate(-12 60 52)">
          <path d="M30 40H90V47A4 4 0 0 0 90 55V62H30V55A4 4 0 0 0 30 47Z" />
          <path d="M44 40V62" strokeDasharray="3 4" opacity=".6" />
          <path d="M53 48H78M53 54.5H70" opacity=".5" />
        </g>
        {ground}
      </>,
    ),
  },
  sailboat: {
    tile: tile(
      <>
        <path d="M60 16V62" />
        <path d="M57 20V57H36Z" />
        <path d="M63 28V57H80Z" />
        <path d="M33 62H87L80 72H40Z" />
        {ground}
      </>,
    ),
  },
  "bakery-box": {
    tile: tile(
      <>
        <rect x="24" y="42" width="42" height="30" rx="2" />
        <path d="M24 50H66" />
        <path d="M45 50V72" opacity=".5" />
        <path d="M45 42C41.5 34.5 33 36 36 40.3C37.8 42.8 42 42.5 45 42C48 42.5 52.2 42.8 54 40.3C57 36 48.5 34.5 45 42Z" />
        <path d="M72 72C69 63 73 52 86 52C99 52 103 63 100 72" />
        <path d="M80 56.5C82 60 82 64 81 67M88 55.5C90 59 90 63 89 66.5M95 58C96.5 61 96.5 64 95.5 67" opacity=".5" />
        {ground}
      </>,
    ),
  },
  "wine-crate": {
    tile: tile(
      <>
        <path d="M39.5 18H44.5V29C44.5 32.5 49.5 33.5 49.5 39V46H34.5V39C34.5 33.5 39.5 32.5 39.5 29Z" />
        <path d="M39.5 22.5H44.5" />
        <path d="M57.5 18H62.5V29C62.5 32.5 67.5 33.5 67.5 39V46H52.5V39C52.5 33.5 57.5 32.5 57.5 29Z" />
        <path d="M57.5 22.5H62.5" />
        <path d="M75.5 18H80.5V29C80.5 32.5 85.5 33.5 85.5 39V46H70.5V39C70.5 33.5 75.5 32.5 75.5 29Z" />
        <path d="M75.5 22.5H80.5" />
        <rect x="28" y="46" width="64" height="26" rx="2" />
        <path d="M28 59H92" opacity=".5" />
        {ground}
      </>,
    ),
  },
  coffee: {
    tile: tile(
      <>
        <path d="M34 44H70V54C70 63 63 68 52 68C41 68 34 63 34 54Z" />
        <path d="M70 47H74C80 47 80 57 74 57H69" />
        <path d="M26 68H78C76 71 72 72 68 72H36C32 72 28 71 26 68Z" />
        <path d="M46 38c-3-3 3-6 0-9s3-6 0-9M58 38c-3-3 3-6 0-9s3-6 0-9" opacity=".5" />
        <g transform="translate(0 2.25) rotate(-24 93 64)">
          <ellipse cx="93" cy="64" rx="8" ry="5.2" />
          <path d="M85.5 64C88.5 61.6 91.5 66.4 94.5 64C96 62.8 98.5 63 100.6 64" opacity=".5" />
        </g>
        {ground}
      </>,
    ),
  },
  "massage-table": {
    tile: tile(
      <>
        <rect x="18" y="42" width="84" height="6" rx="3" />
        <path d="M32 48L28 72M88 48L92 72" />
        <path d="M30 60H90" opacity=".5" />
        <circle cx="31" cy="36.5" r="5.5" />
        <circle cx="31" cy="36.5" r="2" opacity=".5" />
        <path d="M56 42V37C56 34.8 57.8 33 60 33H88C90.2 33 92 34.8 92 37V42" />
        <path d="M56 37.5H92" opacity=".5" />
        {ground}
      </>,
    ),
  },
  "cooking-pot": {
    tile: tile(
      <>
        <g transform="translate(4 0)">
          <ellipse cx="56" cy="44" rx="24" ry="4" />
          <path d="M32 44V64C32 69 35 72 40 72H72C77 72 80 69 80 64V44" />
          <path d="M32 50H26.5C23.5 50 23.5 56 26.5 56H32M80 50H85.5C88.5 50 88.5 56 85.5 56H80" />
          <path d="M63 41L80 17" />
          <path d="M45 36c-3-3 3-6 0-9s3-6 0-9M56 36c-3-3 3-6 0-9s3-6 0-9" opacity=".5" />
        </g>
        {ground}
      </>,
    ),
  },
  "photo-print": {
    tile: tile(
      <>
        <rect x="24" y="24" width="72" height="48" rx="2" />
        <rect x="33" y="32" width="54" height="32" opacity=".5" />
        <path d="M37 60L50 45L57 53L66 41L83 60" />
        <circle cx="46" cy="39.5" r="2.6" />
        {ground}
      </>,
    ),
  },
  "pottery-wheel": {
    tile: tile(
      <>
        <path d="M49.5 53C44 44 46.5 32.5 52 25H68C73.5 32.5 76 44 70.5 53" />
        <ellipse cx="60" cy="25" rx="8" ry="1.9" />
        <path d="M46.8 40.5C54 43.5 66 43.5 73.2 40.5" opacity=".5" />
        <path d="M49 51.3A24 3.6 0 1 0 71 51.3" />
        <path d="M49.5 53C54 55.2 66 55.2 70.5 53" />
        <path d="M60 58.1V63" />
        <rect x="36" y="63" width="48" height="9" rx="2" />
        <path d="M30 48C25.5 50.5 25.5 56.5 30 59M90 48C94.5 50.5 94.5 56.5 90 59" opacity=".5" />
        {ground}
      </>,
    ),
  },
  "yoga-mat": {
    tile: tile(
      <>
        <circle cx="35" cy="58" r="14" />
        <path d="M35 58.5C35 55.5 40 55.5 40 59.5C40 64.5 30.5 65 29 59C27.5 52.5 37 48 43 52.5" opacity=".5" />
        <path d="M35 44H88C93.5 44 98 50 98 58C98 66 93.5 72 88 72H35" />
        <path d="M60 44V72M78 44V72" opacity=".5" />
        <g transform="translate(0 6)">
          <path d="M60 38C54 33 54 26 60 20C66 26 66 33 60 38Z" />
          <path d="M60 38C53 38 47 34 45 27C52 27 57 31 60 38ZM60 38C67 38 73 34 75 27C68 27 63 31 60 38Z" />
        </g>
        {ground}
      </>,
    ),
  },
  grooming: {
    tile: tile(
      <>
        <rect x="30" y="38" width="26" height="34" rx="5" />
        <path d="M38 38V32H48V38" />
        <path d="M43 32V25H34.5C32.5 25 31.5 26.2 31.5 28" />
        <g className="fill-ink" stroke="none">
          <circle cx="37.6" cy="51.4" r="1.25" />
          <circle cx="41.1" cy="48.6" r="1.25" />
          <circle cx="44.9" cy="48.6" r="1.25" />
          <circle cx="48.4" cy="51.4" r="1.25" />
        </g>
        <path d="M43 52.6C45.6 52.6 47.6 54.8 47.6 56.8C47.6 58.8 45.6 59.2 43 58.4C40.4 59.2 38.4 58.8 38.4 56.8C38.4 54.8 40.4 52.6 43 52.6Z" />
        <rect x="70" y="28" width="7" height="44" rx="3" />
        <path d="M77 33H92M77 39H92M77 45H92M77 51H92M77 57H92M77 63H92" />
        <circle cx="62" cy="31" r="2.6" opacity=".5" />
        <circle cx="58" cy="21" r="1.8" opacity=".5" />
        {ground}
      </>,
    ),
  },
  "golf-flag": {
    tile: tile(
      <>
        <path d="M40 72c6.4-5.6 14.8-8.6 24-8.6s17.6 3 24 8.6" opacity=".5" />
        <path d="M64 63.4V20" />
        <path d="M64 20.5L83 27L64 33.5" />
        <circle cx="34" cy="68.5" r="3.5" />
        {ground}
      </>,
    ),
  },
  "pet-portrait": {
    tile: tile(
      <>
        <rect x="31" y="18" width="58" height="54" rx="2" />
        <circle cx="60" cy="42" r="9.5" />
        <path d="M51.8 37.2L52.5 28L58.2 32.8" />
        <path d="M61.8 32.8L67.5 28L68.2 37.2" />
        <path d="M44 72C44 61 51 55.5 60 55.5C69 55.5 76 61 76 72" />
        {ground}
      </>,
    ),
  },
  "shelter-pass": {
    tile: tile(
      <>
        <path d="M45 12L57.5 26M75 12L62.5 26" />
        <rect x="56" y="25" width="8" height="7" rx="1.5" />
        <rect x="39" y="32" width="42" height="40" rx="4" />
        <g className="fill-ink" stroke="none">
          <circle cx="54.6" cy="43.9" r="1.25" />
          <circle cx="58.1" cy="41.1" r="1.25" />
          <circle cx="61.9" cy="41.1" r="1.25" />
          <circle cx="65.4" cy="43.9" r="1.25" />
        </g>
        <path d="M60 45.1C62.6 45.1 64.6 47.3 64.6 49.3C64.6 51.3 62.6 51.7 60 50.9C57.4 51.7 55.4 51.3 55.4 49.3C55.4 47.3 57.4 45.1 60 45.1Z" />
        <path d="M49 60.5H71M53 65.5H67" opacity=".5" />
        {ground}
      </>,
    ),
  },
} satisfies Record<string, Drawing>;

export type DrawingKey = keyof typeof DRAWINGS;

export function isDrawingKey(key: string): key is DrawingKey {
  return Object.hasOwn(DRAWINGS, key);
}
