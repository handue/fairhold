import { cn } from "../cn";
import { PaddleMark } from "../PaddleMark";

/**
 * 15's event footer, as drawn on 16b: the event runs on the platform. "Riverside Shelter Gala ·
 * runs on Fairhold", in 12.5px muted type with the brand mark and the platform's name in ink.
 */
export function EventFooter({ eventName, className }: { eventName: string; className?: string }) {
  return (
    <p
      className={cn(
        "flex h-18 items-center justify-center gap-6 text-12.5 leading-18 whitespace-nowrap text-muted",
        className,
      )}
    >
      {eventName} · runs on
      <PaddleMark tone="brand" size={14} className="flex-none" />
      <b className="font-semibold text-ink">Fairhold</b>
    </p>
  );
}
