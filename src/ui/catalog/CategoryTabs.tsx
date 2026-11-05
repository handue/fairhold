import Link from "next/link";

import { LOT_CATEGORIES, type LotCategory } from "@/server/queries/types";

import { CATEGORY_LABELS } from "../categories";
import { cn } from "../cn";
import { catalogHref, type GuestLinks } from "../routes";

interface CategoryTabsProps {
  links: GuestLinks;
  selected: LotCategory | null;
  lotCount: number;
}

/** The catalog's category filter; the selected segment is ink. */
export function CategoryTabs({ links, selected, lotCount }: CategoryTabsProps) {
  const tabs: Array<{ category: LotCategory | null; label: string }> = [
    { category: null, label: "All" },
    ...LOT_CATEGORIES.map((category) => ({ category, label: CATEGORY_LABELS[category] })),
  ];

  return (
    <nav aria-label="Categories" className="flex gap-2 rounded-full bg-surface p-4">
      {tabs.map(({ category, label }) => {
        const isSelected = category === selected;
        return (
          <Link
            key={label}
            href={catalogHref(links, category)}
            scroll={false}
            aria-current={isSelected ? "page" : undefined}
            className={cn(
              "flex h-32 items-center gap-8 rounded-full px-16 text-14 font-medium",
              isSelected ? "bg-ink text-white" : "text-ink2",
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
