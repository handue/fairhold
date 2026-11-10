import { cn } from "../cn";

/**
 * "Sandbox demo": 08's live pill in 11's closed grey with no dot, a label rather than a state.
 *
 * - `platform`: 16 and 16c, the 26px pill at the right of Fairhold's own nav.
 * - `nav`: 18, 20px high on the event nav's rule, under the event pill with their left edges shared,
 *   so nothing in the nav moves. Place it inside the event pill's `relative` wrapper. Below 1024,
 *   where the pill sits under the gala's name, the marker sits beside the pill instead.
 *
 * On event pages the screens draw the nav, and only the layout knows whether the event is a demo
 * gala. So `whenDemo` keeps the marker hidden until the layout's demo slot marks the page as one
 * (`data-demo-gala`, src/ui/demo/DemoSlot.tsx): the seeded event, drawn as approved, has no marker.
 */
export function SandboxMarker({ variant, whenDemo = false }: { variant: "platform" | "nav"; whenDemo?: boolean }) {
  return (
    <span
      className={cn(
        "items-center rounded-full bg-closed px-11 font-mono text-11 font-semibold tracking-status whitespace-nowrap text-ink2 uppercase",
        variant === "platform" ? "h-26" : "pointer-events-none absolute top-37 left-0 h-20 max-lg:static",
        whenDemo ? "hidden [body:has([data-demo-gala])_&]:inline-flex" : "inline-flex",
      )}
    >
      Sandbox demo
    </span>
  );
}

/** Put once on a page of a demo gala; it shows every `whenDemo` marker on the page. */
export function DemoGalaFlag() {
  return <span data-demo-gala="" hidden />;
}
