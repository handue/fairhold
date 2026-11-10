"use client";

import { useState } from "react";

import type { LotPhoto } from "@/server/queries/types";

import { ApiClientError, apiPost } from "../api";
import { cn } from "../cn";
import { isDrawingKey } from "../drawings/drawings";
import { LotIllustration } from "../drawings/LotIllustration";
import { HeartIcon, ShareIcon } from "../icons";
import { useLiveStream } from "../live/LiveStream";
import { joinHref } from "../routes";

interface LotGalleryProps {
  slug: string;
  lotNumber: number;
  title: string;
  photos: LotPhoto[];
  isFavorite: boolean;
}

const circleButton = "flex size-40 cursor-pointer items-center justify-center rounded-full bg-white/95 text-ink max-md:size-44";
const photoLabel = "absolute bottom-18 left-22 font-mono text-12 text-ink2 max-md:bottom-14 max-md:left-16";

const COPIED_MS = 2_000;

/**
 * The heart answers at once, and the stream confirms it. `baseline` is what the page showed when the
 * guest tapped: once the page's own value moves off it, the stream has spoken and the tap is done.
 */
function useFavorite(slug: string, lotNumber: number, isFavorite: boolean) {
  const stream = useLiveStream();
  const [tapped, setTapped] = useState<{ value: boolean; baseline: boolean } | null>(null);
  const shown = tapped && tapped.baseline === isFavorite ? tapped.value : isFavorite;

  async function toggle() {
    const next = !shown;
    setTapped({ value: next, baseline: isFavorite });
    try {
      await apiPost(`/api/events/${encodeURIComponent(slug)}/lots/${lotNumber}/favorite`, { favorite: next });
      stream.pollNow();
    } catch (failure) {
      setTapped(null);
      if (failure instanceof ApiClientError && failure.code === "not_joined") {
        window.location.assign(joinHref(slug, window.location.pathname));
      }
    }
  }
  return { shown, toggle };
}

/** The Web Share sheet where there is one, otherwise the link on the clipboard. */
function useShare(title: string) {
  const [copied, setCopied] = useState(false);

  async function share() {
    // The page's own address, without a test viewer's ?paddle=.
    const url = `${window.location.origin}${window.location.pathname}`;
    if (typeof navigator.share === "function") {
      await navigator.share({ title, url }).catch(() => {}); // The guest closed the sheet.
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      // No clipboard in this browser or context; the address bar still has the link.
    }
  }
  return { copied, share };
}

/** 05's photo hero with the heart and share buttons, and the thumbnail row under it. */
export function LotGallery({ slug, lotNumber, title, photos, isFavorite }: LotGalleryProps) {
  const [cover] = photos;
  const coverDrawing = cover?.drawing && isDrawingKey(cover.drawing) ? cover.drawing : null;
  const favorite = useFavorite(slug, lotNumber, isFavorite);
  const { copied, share } = useShare(title);

  return (
    <div>
      {/* Below 1280 the photo keeps the approved 716 by 560 shape as it narrows; a phone's is wider and lower. */}
      <div className="relative flex h-560 items-center justify-center rounded-24 bg-stone-tile max-xl:aspect-[716/560] max-xl:h-auto max-md:aspect-[3/2] max-md:rounded-20">
        <div className="absolute top-18 right-18 flex gap-8 max-md:top-12 max-md:right-12">
          <button
            type="button"
            onClick={favorite.toggle}
            aria-label="Save to my lots"
            aria-pressed={favorite.shown}
            className={circleButton}
          >
            <HeartIcon size={18} filled={favorite.shown} />
          </button>
          <button type="button" onClick={share} aria-label="Share this lot" className={circleButton}>
            <ShareIcon size={18} />
          </button>
        </div>
        {coverDrawing && (
          <LotIllustration drawing={coverDrawing} variant="hero" className="max-lg:h-auto max-lg:max-h-[54%] max-lg:w-auto" />
        )}
        {copied ? (
          <p role="status" className={photoLabel}>
            LINK COPIED
          </p>
        ) : (
          coverDrawing && (
            <p className={photoLabel}>PHOTO 1 / {photos.length}</p>
          )
        )}
      </div>

      {photos.length > 1 && (
        <div className="mt-12 grid grid-cols-4 gap-12 max-md:mt-8 max-md:gap-8">
          {photos.map((photo, index) => (
            <div
              key={index}
              className={cn(
                "flex h-92 items-center justify-center rounded-16 bg-stone max-lg:h-72 max-md:h-56 max-md:rounded-12",
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
