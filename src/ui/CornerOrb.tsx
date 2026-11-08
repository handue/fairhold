import { GlimCornerBubble, GlimCornerButton } from "./glim/GlimCorner";
import { Orb } from "./Orb";

export interface OrbBubble {
  title: string;
  body: string;
}

/** The invitation every guest page shows until the guest talks to Glim. */
export const GLIM_INVITATION: OrbBubble = {
  title: "Want me to bid for you?",
  body: "Tell me your budget. I’ll spread it across the lots you like.",
};

/** Glim resting in the page corner with a speech bubble, which steps aside for the open panel (07); the orb opens the chat. */
export function CornerOrb({ bubble }: { bubble?: OrbBubble }) {
  return (
    <div className="fixed right-32 bottom-28 z-40 flex items-end gap-12">
      {bubble && (
        <GlimCornerBubble invitation={bubble === GLIM_INVITATION}>
          <div className="max-w-230 rounded-18 rounded-br-4 border border-line bg-white px-14 py-12 shadow-bubble">
            <p className="text-13.5 font-semibold">{bubble.title}</p>
            <p className="mt-2 text-12.5 leading-[1.4] text-muted">{bubble.body}</p>
          </div>
        </GlimCornerBubble>
      )}
      <GlimCornerButton>
        <Orb size={68} />
      </GlimCornerButton>
    </div>
  );
}
