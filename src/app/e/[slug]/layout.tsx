import { Suspense } from "react";

import { DemoSlot } from "@/ui/demo/DemoSlot";
import { GlimSlot } from "@/ui/event/GlimSlot";
import { LiveProviders } from "@/ui/event/LiveProviders";

/**
 * Around every page of an event: the live providers (src/ui/event/LiveProviders.tsx), the Glim
 * panel (src/ui/event/GlimSlot.tsx) and the demo gala's slot (src/ui/demo/DemoSlot.tsx: 16c for a
 * gala that ended, the Sandbox demo marker, the role menu and the demo guide). Each track fills in
 * its own file, so this one stays as it is. It awaits nothing, so each page's own static shell
 * still prerenders.
 */
export default function EventLayout({ children, params }: LayoutProps<"/e/[slug]">) {
  return (
    <LiveProviders>
      {children}
      <Suspense fallback={null}>
        <GlimSlot params={params} />
      </Suspense>
      <Suspense fallback={null}>
        <DemoSlot params={params} />
      </Suspense>
    </LiveProviders>
  );
}
