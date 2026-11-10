"use client";

import { useEffect, useState } from "react";

import { cn } from "../cn";

/**
 * 16's Copy chip (07's quick-reply chip): 32px, white, Line edge. It reads "Copied" for a moment
 * after copying, and "Copy failed" when the browser refuses the clipboard.
 */
export function CopyButton({ value, label, className }: { value: string; label: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const back = setTimeout(() => setState("idle"), 2_000);
    return () => clearTimeout(back);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={label}
      className={cn(
        "inline-flex h-32 flex-none cursor-pointer items-center rounded-16 border border-line bg-white px-12 text-12.5 font-medium whitespace-nowrap text-ink",
        className,
      )}
    >
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}</span>
    </button>
  );
}
