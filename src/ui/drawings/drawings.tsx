import type { ReactNode } from "react";

/**
 * The lot drawings of the approved screens, copied path for path. Tile art lives on the shared
 * 120x90 grid (08, 10, 11, 13, 14); the lot page (05) adds a hero cloche on a 190x150 grid and
 * four thumbnail icons on their own grids.
 *
 * Lots without a drawing yet (ten of the 24) need new artwork, which waits for design approval.
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
} satisfies Record<string, Drawing>;

export type DrawingKey = keyof typeof DRAWINGS;

export function isDrawingKey(key: string): key is DrawingKey {
  return Object.hasOwn(DRAWINGS, key);
}
