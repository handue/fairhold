import { Orb } from "@/ui/Orb";

/** Glim in the corner, as on 08. Organizers have no chat, so the orb only shows its bubble. */
export function OrganizerCorner({ bubble }: { bubble: { title: string; body: string } | null }) {
  return (
    <div className="fixed right-32 bottom-28 z-40 flex items-end gap-12">
      {bubble && (
        <div className="max-w-230 rounded-18 rounded-br-4 border border-line bg-white px-14 py-12 shadow-bubble">
          <p className="text-13.5 font-semibold">{bubble.title}</p>
          <p className="mt-2 text-12.5 leading-[1.4] text-muted">{bubble.body}</p>
        </div>
      )}
      <Orb size={68} />
    </div>
  );
}
