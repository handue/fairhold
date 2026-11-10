"use client";

import { useState, type ReactNode } from "react";

import { buttonClass } from "../Button";
import { cn } from "../cn";
import { ChevronDownIcon } from "../icons";

interface CatalogGridProps {
  /** The tiles shown at first: two rows, so every lot on screen is readable above Glim's corner. */
  firstTiles: ReactNode;
  /**
   * The ninth lot, if there is one. Where the grid is three across (1024 to 1279) it joins the first
   * eight, so the first screen ends in a full row of three rather than two and an empty cell.
   */
  rowFiller: ReactNode;
  /** Every lot after the ninth. */
  moreTiles: ReactNode;
  /** The lots after the first eight, the ninth among them. */
  moreCount: number;
}

const showMoreLabel = (count: number) => `Show ${count} more ${count === 1 ? "lot" : "lots"}`;

export function CatalogGrid({ firstTiles, rowFiller, moreTiles, moreCount }: CatalogGridProps) {
  const [showAll, setShowAll] = useState(false);
  // From 1024 to 1279 the ninth lot is already shown, so the button counts one fewer, and with no more
  // after it there is no button there.
  const threeAcross = "hidden max-xl:inline max-lg:hidden";
  const otherwise = "max-xl:hidden max-lg:inline";

  return (
    <>
      {/* Four across from 1280, three on a small laptop, two on a tablet or a wide phone, one on a phone. */}
      <div className="mt-24 grid grid-cols-4 gap-x-24 gap-y-32 max-xl:grid-cols-3 max-lg:grid-cols-2 max-md:gap-x-16 max-md:gap-y-28 max-sm:grid-cols-1 max-sm:gap-y-24">
        {firstTiles}
        {rowFiller && <div className={showAll ? "contents" : "hidden max-xl:contents max-lg:hidden"}>{rowFiller}</div>}
        {showAll && moreTiles}
      </div>
      {!showAll && moreCount > 0 && (
        <div className={cn("mt-24 flex justify-center", Boolean(rowFiller) && moreCount === 1 && "max-xl:hidden max-lg:flex")}>
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className={buttonClass({ variant: "quiet", size: 40, className: "max-md:h-48 max-md:w-full max-md:justify-center" })}
          >
            {rowFiller ? (
              <>
                <span className={otherwise}>{showMoreLabel(moreCount)}</span>
                <span className={threeAcross}>{showMoreLabel(moreCount - 1)}</span>
              </>
            ) : (
              showMoreLabel(moreCount)
            )}
            <ChevronDownIcon size={14} />
          </button>
        </div>
      )}
    </>
  );
}
