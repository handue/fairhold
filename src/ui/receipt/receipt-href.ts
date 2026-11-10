import type { GuestLinks } from "../routes";

function withPaddle(path: string, links: GuestLinks): string {
  return links.paddle === null ? path : `${path}?paddle=${links.paddle}`;
}

/** Screen 11, the receipt; after the close, My paddle opens it (design/27). */
export function receiptHref(links: GuestLinks): string {
  return withPaddle(`/e/${encodeURIComponent(links.slug)}/receipt`, links);
}

/** 25b, the receipt as a printable US Letter page. */
export function receiptPdfHref(links: GuestLinks): string {
  return withPaddle(`/e/${encodeURIComponent(links.slug)}/receipt/pdf`, links);
}
