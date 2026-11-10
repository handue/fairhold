"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";

import { LOT_CATEGORIES, type LotCategory } from "@/server/queries/types";

import { CATEGORY_LABELS } from "../categories";
import { cn } from "../cn";
import { catalogHref, type GuestLinks } from "../routes";

interface CategoryTabsProps {
  links: GuestLinks;
  selected: LotCategory | null;
  lotCount: number;
}

/**
 * The catalog's category filter; the selected segment is ink. Below 1280 it takes its own row under the
 * title, and on a phone it becomes a row of chips that scrolls sideways, edge to edge.
 */
export function CategoryTabs({ links, selected, lotCount }: CategoryTabsProps) {
  const tabs: Array<{ category: LotCategory | null; label: string }> = [
    { category: null, label: "All" },
    ...LOT_CATEGORIES.map((category) => ({ category, label: CATEGORY_LABELS[category] })),
  ];
  const row = useRef<HTMLElement>(null);

  // Where the chips scroll (a phone), a selected chip past the edge is brought into view. Elsewhere the
  // row doesn't scroll, and this does nothing.
  useEffect(() => {
    const nav = row.current;
    const chip = nav?.querySelector<HTMLElement>("[aria-current=page]");
    if (!nav || !chip || nav.scrollWidth <= nav.clientWidth) return;
    const padding = parseFloat(getComputedStyle(nav).paddingLeft) || 0;
    const past = chip.getBoundingClientRect().right - (nav.getBoundingClientRect().right - padding);
    if (past > 0) nav.scrollLeft += past;
  }, [selected]);

  return (
    <nav
      ref={row}
      aria-label="Categories"
      className="flex gap-2 rounded-full bg-surface p-4 max-xl:col-span-2 max-xl:row-start-2 max-xl:justify-self-start max-md:col-span-1 max-md:row-start-3 max-md:-mx-16 max-md:justify-self-stretch max-md:gap-8 max-md:overflow-x-auto max-md:rounded-none max-md:bg-transparent max-md:px-16 max-md:py-0 max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden"
    >
      {tabs.map(({ category, label }) => {
        const isSelected = category === selected;
        return (
          <Link
            key={label}
            href={catalogHref(links, category)}
            scroll={false}
            aria-current={isSelected ? "page" : undefined}
            className={cn(
              "flex h-32 items-center gap-8 rounded-full px-16 text-14 font-medium max-md:h-40 max-md:flex-none",
              isSelected ? "bg-ink text-white" : "text-ink2 max-md:bg-surface",
            )}
          >
            {label}
            {category === null && <span className="font-mono text-12 text-on-ink-muted">{lotCount}</span>}
          </Link>
        );
      })}
    </nav>
  );
}
