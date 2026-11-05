import type { LotPhoto } from "@/server/queries/types";

import { cn } from "../cn";
import { isDrawingKey } from "../drawings/drawings";
import { LotIllustration } from "../drawings/LotIllustration";
import { HeartIcon, ShareIcon } from "../icons";
import { PendingButton } from "../PendingButton";

interface LotGalleryProps {
  lotNumber: number;
  photos: LotPhoto[];
  isFavorite: boolean;
}

const circleButton = "flex size-40 cursor-pointer items-center justify-center rounded-full bg-white/95 text-ink";

/** 05's photo hero with the heart and share buttons, and the thumbnail row under it. */
export function LotGallery({ lotNumber, photos, isFavorite }: LotGalleryProps) {
  const [cover] = photos;
  const coverDrawing = cover?.drawing && isDrawingKey(cover.drawing) ? cover.drawing : null;

  return (
    <div>
      <div className="relative flex h-560 items-center justify-center rounded-24 bg-stone-tile">
        <div className="absolute top-18 right-18 flex gap-8">
          <PendingButton
            action="toggleFavorite"
            details={{ lot: lotNumber }}
            aria-label="Save to my lots"
            aria-pressed={isFavorite}
            className={circleButton}
          >
            <HeartIcon size={18} filled={isFavorite} />
          </PendingButton>
          <PendingButton
            action="shareLot"
            details={{ lot: lotNumber }}
            aria-label="Share this lot"
            className={circleButton}
          >
            <ShareIcon size={18} />
          </PendingButton>
        </div>
        {coverDrawing && (
          <>
            <LotIllustration drawing={coverDrawing} variant="hero" />
            <p className="absolute bottom-18 left-22 font-mono text-12 text-ink2">PHOTO 1 / {photos.length}</p>
          </>
        )}
      </div>

      {photos.length > 1 && (
        <div className="mt-12 grid grid-cols-4 gap-12">
          {photos.map((photo, index) => (
            <div
              key={index}
              className={cn(
                "flex h-92 items-center justify-center rounded-16 bg-stone",
                index === 0 && "outline-[1.5px] outline-ink outline-offset-[-1.5px]",
              )}
            >
              {photo.drawing && isDrawingKey(photo.drawing) && (
                <LotIllustration drawing={photo.drawing} variant="thumb" />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
