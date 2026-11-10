"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** 25b's sheet: US Letter at 96 dpi. */
const SHEET_WIDTH = 816;

/**
 * On a screen narrower than the sheet, 25b's page shows the whole sheet scaled down to the stage's
 * width (receipt-pdf.css applies `--fit` below 848px, screen only), so the preview never scrolls
 * sideways. Printing always uses the sheet at full size.
 */
export function FitSheet({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = box.current;
    const stage = element?.parentElement;
    if (!element || !stage) return;
    const fit = () => {
      const style = getComputedStyle(stage);
      const room = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      element.style.setProperty("--fit", String(Math.min(1, room / SHEET_WIDTH)));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={box} className="fh-pdf-fit">
      {children}
    </div>
  );
}
