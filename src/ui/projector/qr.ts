import QRCode from "qrcode";

/**
 * A QR code as one SVG path: 14's 4-module quiet zone, one unit per module. Level L, as 14 draws it:
 * a screen is never torn or smudged, and fewer modules read from further back.
 */
export interface QrPath {
  /** Modules across, quiet zone included: the viewBox's side. */
  size: number;
  d: string;
}

const QUIET_ZONE = 4;

/** The path of `text`'s QR code, a run of dark modules per rectangle, as mockups/14 draws it. */
export function qrPath(text: string): QrPath {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: "L" });
  const { size, data } = modules;
  const parts: string[] = [];
  for (let row = 0; row < size; row += 1) {
    let column = 0;
    while (column < size) {
      if (!data[row * size + column]) {
        column += 1;
        continue;
      }
      const start = column;
      while (column < size && data[row * size + column]) column += 1;
      const length = column - start;
      parts.push(`M${start + QUIET_ZONE} ${row + QUIET_ZONE}h${length}v1h-${length}z`);
    }
  }
  return { size: size + QUIET_ZONE * 2, d: parts.join("") };
}
