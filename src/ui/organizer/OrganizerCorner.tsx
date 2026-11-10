import { Orb } from "@/ui/Orb";

/**
 * Glim in the corner, as on 08. Organizers have no chat, so the orb only shows its bubble. Below
 * 1440 the window is often too short for the corner to clear the rail's action, so the orb and its
 * bubble close the page instead, under the ledger, and never cover a button.
 */
export function OrganizerCorner({ bubble }: { bubble: { title: string; body: string } | null }) {
  return (
    <div className="fixed right-32 bottom-28 z-40 flex items-end gap-12 max-desk:static max-desk:mx-auto max-desk:mt-24 max-desk:max-w-1344 max-desk:justify-end max-desk:px-32 max-desk:pb-[calc(32px+env(safe-area-inset-bottom))] max-md:px-16 max-md:pb-[calc(24px+env(safe-area-inset-bottom))]">
      {bubble && (
        <div className="max-w-230 rounded-18 rounded-br-4 border border-line bg-white px-14 py-12 shadow-bubble max-desk:min-w-0">
          <p className="text-13.5 font-semibold">{bubble.title}</p>
          <p className="mt-2 text-12.5 leading-[1.4] text-muted">{bubble.body}</p>
        </div>
      )}
      <Orb size={68} />
    </div>
  );
}
