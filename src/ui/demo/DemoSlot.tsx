import { resolveViewer } from "@/server/queries/viewer";

import { DemoChrome } from "./DemoChrome";
import { DemoEndedOverlay } from "./DemoEnded";
import { readDemoGala, readGuideProgress } from "./demo-state";
import { DemoGalaFlag } from "./SandboxMarker";

/**
 * The demo gala's place in the event layout, beside the page inside a <Suspense> boundary like the
 * Glim slot. A gala that ended or is gone gets design/16c over the page. A live demo gala gets the
 * Sandbox demo markers shown in its navs, the role menu for its creator, and the demo guide.
 */
export async function DemoSlot({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const gala = await readDemoGala(slug);
  if (gala.kind !== "event") return <DemoEndedOverlay />;
  if (!gala.isDemo) return null;

  const { session } = await resolveViewer(slug, null);
  const creator =
    session?.isOrganizer && session.paddleId && session.paddleNumber !== null
      ? {
          paddleId: session.paddleId,
          paddleNumber: session.paddleNumber,
          progress: await readGuideProgress({ paddleId: session.paddleId, status: gala.status }),
        }
      : null;

  return (
    <>
      <DemoGalaFlag />
      <DemoChrome slug={slug} timeZone={gala.timeZone} organizer={creator} />
    </>
  );
}
