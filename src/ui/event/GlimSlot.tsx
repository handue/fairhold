import { hasTalkedToGlim } from "@/server/chat/view";
import { resolveViewer } from "@/server/queries/viewer";
import { GlimPanel } from "@/ui/glim/GlimPanel";

/**
 * The 07 Glim panel's place in the shared layout, next to the page and inside a <Suspense> boundary,
 * so it can read the session without holding the page back. Only a session with a paddle gets it:
 * every chat route is session-bound. It opens on onGlimOpen (src/ui/glim-events.ts). The layout also
 * wraps the projector and the organizer's pages, where the chat must not appear, so the panel's client
 * side checks the pathname.
 */
export interface GlimSlotProps {
  params: Promise<{ slug: string }>;
}

export async function GlimSlot({ params }: GlimSlotProps) {
  const { slug } = await params;
  const { session } = await resolveViewer(slug, null);
  if (!session?.paddleId) return null;
  return <GlimPanel key={slug} slug={slug} talked={await hasTalkedToGlim(session.paddleId)} />;
}
