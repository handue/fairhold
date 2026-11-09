import Link from "next/link";

import type { CatalogLot } from "@/server/queries/types";

import { buttonClass } from "../Button";
import { CATEGORY_LABELS } from "../categories";
import { cn } from "../cn";
import { isDrawingKey } from "../drawings/drawings";
import { LotIllustration } from "../drawings/LotIllustration";
import { Eyebrow } from "../Eyebrow";
import { formatBidCount, formatClockTime, formatClosedTime, formatLotNumber, formatPaddleNumber } from "../format";
import { GlimOpenButton } from "../GlimOpenButton";
import { Money } from "../Money";
import { Orb } from "../Orb";
import { StatusPill } from "../StatusPill";

import { TileTimer } from "./TileTimer";

interface LotTileProps {
  lot: CatalogLot;
  href: string;
  timeZone: string;
  /** The paddle that bought the lot, once it closed sold; null while open or when unknown. */
  soldTo: number | null;
  /** What a won tile says under its price: "You’ll pay at 9:30 PM". */
  wonLine: string;
}

/**
 * A lot in the catalog: stone tile with its drawing, status and timer, then number, title and price.
 * A closed lot fades and says how it ended (design/20 states 4 to 6); a won one keeps full strength.
 */
export function LotTile({ lot, href, timeZone, soldTo, wonLine }: LotTileProps) {
  const isOpen = lot.status === "open";
  const faded = !isOpen && lot.viewerStatus !== "won";
  const drawing = lot.coverDrawing && isDrawingKey(lot.coverDrawing) ? lot.coverDrawing : null;

  return (
    <article className="relative">
      <div className="relative flex h-152 items-center justify-center rounded-20 bg-stone-tile">
        <TileStatus lot={lot} timeZone={timeZone} />
        {isOpen && <TileTimer closesAt={lot.closesAt} />}
        {drawing && (
          <LotIllustration drawing={drawing} variant="tile" className={cn("relative top-10", faded && "opacity-50")} />
        )}
      </div>

      <div className="pt-12">
        <Eyebrow size="sm">
          Lot {formatLotNumber(lot.number)} · {CATEGORY_LABELS[lot.category]}
        </Eyebrow>
        <h3 className={cn("mt-6 truncate text-16 leading-22 font-semibold tracking-snug", faded && "text-muted")}>
          {/* The title's link covers the whole tile; the action buttons sit above it. */}
          <Link href={href} className="after:absolute after:inset-0 after:rounded-20">
            {lot.title}
          </Link>
        </h3>
        <div className="mt-6 flex h-30 items-center justify-between">
          {!isOpen && lot.bidCount === 0 ? (
            // Nudged 2px so "No bids" sits on the prices' baseline in the tiles beside it.
            <span className="relative top-2 text-15 leading-26 font-semibold">No bids</span>
          ) : (
            <span className="flex items-baseline gap-8">
              <span className="font-mono text-20 font-medium tracking-heading tabular-nums">
                <Money cents={lot.priceCents} />
              </span>
              <span className="text-13 whitespace-nowrap text-muted">
                <PriceNote lot={lot} soldTo={soldTo} wonLine={wonLine} />
              </span>
            </span>
          )}
          <TileAction lot={lot} href={href} />
        </div>
      </div>
    </article>
  );
}

/** Beside the price: the bid count while open; once closed, who pays. */
function PriceNote({ lot, soldTo, wonLine }: Pick<LotTileProps, "lot" | "soldTo" | "wonLine">) {
  if (lot.status === "open") return formatBidCount(lot.bidCount);
  if (lot.viewerStatus === "won") return wonLine;
  if (soldTo === null) return formatBidCount(lot.bidCount);
  return (
    <>
      Sold to <span className="font-mono">Paddle {formatPaddleNumber(soldTo)}</span>
    </>
  );
}

function TileStatus({ lot, timeZone }: { lot: CatalogLot; timeZone: string }) {
  const position = "absolute top-12 left-12";
  if (lot.viewerStatus === "won") {
    return (
      <StatusPill status="winning" edge className={position}>
        Won at {formatClockTime(lot.closesAt, timeZone)}
      </StatusPill>
    );
  }
  if (lot.status === "closed") {
    // On the stone tile the grey fill would disappear, so the closed pill turns white there.
    return (
      <StatusPill status="closed" className={cn(position, "bg-white!")}>
        Closed at {formatClosedTime(lot.closesAt, timeZone)}
      </StatusPill>
    );
  }
  if (lot.viewerStatus === "winning") {
    return (
      <StatusPill status="winning" edge className={position}>
        You’re winning
      </StatusPill>
    );
  }
  if (lot.viewerStatus === "outbid") {
    return (
      <StatusPill status="outbid" className={position}>
        You’re outbid
      </StatusPill>
    );
  }
  return null;
}

/** Outbid lots offer a way back in; hearted lots offer Glim. Bids themselves happen on the lot page. */
function TileAction({ lot, href }: { lot: CatalogLot; href: string }) {
  if (lot.status !== "open") return null;
  if (lot.viewerStatus === "outbid") {
    return (
      <Link href={href} className={buttonClass({ variant: "outline", size: 30, className: "relative z-10" })}>
        Bid again
      </Link>
    );
  }
  if (lot.offerGlimWatch) {
    return (
      <GlimOpenButton
        detail={{ lotNumber: lot.number }}
        className={cn(buttonClass({ variant: "outline", size: 30, padding: "pr-13 pl-4" }), "relative z-10")}
      >
        <Orb size={22} />
        Let Glim watch
      </GlimOpenButton>
    );
  }
  return null;
}
