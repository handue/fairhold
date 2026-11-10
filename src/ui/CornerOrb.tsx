import { cn } from "./cn";
import { GlimCornerBubble, GlimCornerButton } from "./glim/GlimCorner";
import { Orb } from "./Orb";

export interface OrbBubble {
  title: string;
  body: string;
  /**
   * On narrow screens: "title" keeps only the title on a phone (below 768), so the bubble is no taller
   * than the orb (a hint, such as 09's); "none" leaves the orb on its own below 1024, on a tablet too
   * (an invitation the page already makes in its own Glim row, or news the page says itself, as 11's
   * receipt does). Left out, the bubble keeps its sentence everywhere.
   */
  phone?: "title" | "none";
}

/**
 * The invitation every guest page shows until the guest talks to Glim. Below 1024 the orb alone
 * stands for it: 08's band, 05's "Let Glim bid on this lot" and 10's "Talk to Glim" make the same
 * offer in the page, and on a phone or an upright tablet the bubble would rest on a lot's price or
 * photo, or on 10's rows, at the fold.
 */
export const GLIM_INVITATION: OrbBubble = {
  title: "Want me to bid for you?",
  body: "Tell me your budget. I’ll spread it across the lots you like.",
  phone: "none",
};

/**
 * Glim resting in the page corner with a speech bubble, which steps aside for the open panel (07); the orb opens the chat.
 *
 * On a phone (below 768) the orb is 56 and sits 16px in from the right and the bottom, and the bubble
 * never reaches past the left gutter. Below 1024 the invitation leaves the orb on its own; on a phone a
 * hint (09's) keeps only its question, so it is no taller than the orb. The corner then takes 72px from
 * the bottom (88 with a gap above it). The env(safe-area-inset-*) terms here and on the other pinned
 * parts resolve to 0 today: iOS reports the insets only with viewport-fit=cover, which the viewport
 * leaves out. They take effect if cover is added (landscape phones would then need side insets too).
 *
 * `placement="page-end"` moves the corner into the page below 1440, at its end and right-aligned under
 * it, as the organizer's corner does, on pages whose one primary action a resting corner would cover on
 * a laptop's first screen: 05's bid card ("Raise bidding power", "Let Glim bid on this lot"), 09's Hold
 * button, and 11's Download receipt and Email me a copy. At 1440 it is the approved corner.
 */
export function CornerOrb({
  bubble,
  placement = "corner",
}: {
  bubble?: OrbBubble;
  placement?: "corner" | "page-end";
}) {
  return (
    <div
      className={cn(
        "fixed right-32 bottom-28 z-40 flex items-end gap-12 max-md:right-16 max-md:bottom-[calc(16px+env(safe-area-inset-bottom))]",
        placement === "page-end" &&
          "max-desk:static max-desk:mx-auto max-desk:mt-24 max-desk:max-w-1344 max-desk:justify-end max-desk:px-32 max-desk:pb-[calc(32px+env(safe-area-inset-bottom))] max-md:px-16 max-md:pb-[calc(24px+env(safe-area-inset-bottom))]",
      )}
    >
      {bubble && (
        <GlimCornerBubble invitation={bubble === GLIM_INVITATION}>
          <div
            className={cn(
              "max-w-230 rounded-18 rounded-br-4 border border-line bg-white px-14 py-12 shadow-bubble max-md:max-w-[min(230px,calc(100vw-100px))]",
              bubble.phone === "none" && "max-lg:hidden",
            )}
          >
            <p className="text-13.5 font-semibold">{bubble.title}</p>
            <p className={cn("mt-2 text-12.5 leading-[1.4] text-muted", bubble.phone === "title" && "max-md:hidden")}>{bubble.body}</p>
          </div>
        </GlimCornerBubble>
      )}
      <GlimCornerButton>
        {/* 68's own drawing at 56 on a phone: Orb's sizes are a closed set, so it scales rather than redraws. */}
        <Orb size={68} className="max-md:origin-top-left max-md:scale-[.8235]" />
      </GlimCornerButton>
    </div>
  );
}
