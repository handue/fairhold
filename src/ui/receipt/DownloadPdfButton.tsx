"use client";

import { buttonClass } from "../Button";
import { DownloadIcon } from "../paddle/icons";

/**
 * "Download PDF": the browser's print dialog, saving to PDF, with no PDF library. While it prints, the
 * page's title is the file name (fairhold-sandbox-receipt-1107-142), which Chrome and Safari offer as
 * the name to save; the title comes back afterwards.
 */
export function DownloadPdfButton({ fileName }: { fileName: string }) {
  const download = () => {
    const title = document.title;
    const restore = () => {
      document.title = title;
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    document.title = fileName;
    window.print();
  };
  return (
    <button type="button" onClick={download} className={buttonClass({ variant: "lime", size: 48, className: "justify-between" })}>
      Download PDF
      <DownloadIcon size={18} />
    </button>
  );
}
