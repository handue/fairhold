import { Suspense } from "react";

import { GlimSlot } from "@/ui/event/GlimSlot";
import { LiveProviders } from "@/ui/event/LiveProviders";

/**
 * Around every page of an event: the live providers (src/ui/event/LiveProviders.tsx) and the Glim
 * panel (src/ui/event/GlimSlot.tsx). Each track fills in its own file, so this one stays as it is.
 * It awaits nothing, so each page's own static shell still prerenders.
 */
export default function EventLayout({ children, params }: LayoutProps<"/e/[slug]">) {
  return (
    <LiveProviders>
      {children}
      <Suspense fallback={null}>
        <GlimSlot params={params} />
      </Suspense>
    </LiveProviders>
  );
}
