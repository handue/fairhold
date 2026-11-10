import type { PowerView } from "@/server/holds/view";
import type { ViewerSummary } from "@/server/queries/types";

import { CornerOrb, type OrbBubble } from "../CornerOrb";
import { EventNav } from "../EventNav";
import { formatClockTime } from "../format";
import type { GuestLinks } from "../routes";

import { PowerPanel } from "./PowerPanel";

/** 09's resting bubble; the no-break space keeps its second line as approved. */
const NOT_SURE_BUBBLE: OrbBubble = {
  title: "Not sure how much?",
  body: "Tell me which lots you like. I’ll suggest an amount.",
};

interface PowerScreenProps {
  view: PowerView & { viewer: ViewerSummary };
  links: GuestLinks;
  returnHref: string;
  initialCents: number | null;
}

/** Screen 09: bidding power, set for the first time or raised. */
export function PowerScreen({ view, links, returnHref, initialCents }: PowerScreenProps) {
  const { event, viewer, limits, currentHoldCents, committedCents, biddingEnded, exampleLot } = view;
  return (
    <>
      <EventNav event={event} viewer={viewer} links={links} active="paddle" />
      <PowerPanel
        slug={event.slug}
        limits={limits}
        currentHoldCents={currentHoldCents}
        committedCents={committedCents}
        biddingEnded={biddingEnded}
        exampleLot={exampleLot}
        closesLabel={formatClockTime(event.closesAt, event.timeZone)}
        returnHref={returnHref}
        initialCents={initialCents}
      />
      {/* Once bidding has closed there is no amount to suggest. */}
      <CornerOrb bubble={biddingEnded ? undefined : NOT_SURE_BUBBLE} />
    </>
  );
}
