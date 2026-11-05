"use client";

import { useState, type ReactNode } from "react";

import { buttonClass } from "../Button";
import { ChevronDownIcon } from "../icons";

interface CatalogGridProps {
  /** The tiles shown at first: two rows, so every lot on screen is readable above Glim's corner. */
  firstTiles: ReactNode;
  moreTiles: ReactNode;
  moreCount: number;
}

export function CatalogGrid({ firstTiles, moreTiles, moreCount }: CatalogGridProps) {
  const [showAll, setShowAll] = useState(false);

  return (
    <>
      <div className="mt-24 grid grid-cols-4 gap-x-24 gap-y-32">
        {firstTiles}
        {showAll && moreTiles}
      </div>
      {!showAll && moreCount > 0 && (
        <div className="mt-24 flex justify-center">
          <button type="button" onClick={() => setShowAll(true)} className={buttonClass({ variant: "quiet", size: 40 })}>
            {`Show ${moreCount} more ${moreCount === 1 ? "lot" : "lots"}`}
            <ChevronDownIcon size={14} />
          </button>
        </div>
      )}
    </>
  );
}
