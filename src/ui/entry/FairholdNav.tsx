import { SandboxMarker } from "../demo/SandboxMarker";
import { PaddleMark } from "../PaddleMark";

/**
 * Fairhold's own nav, on 16 and 16c: 08's bar and brand lockup named Fairhold (15's lockup), with
 * no event pill, links or paddle, and the Sandbox demo label on the right. Below 1440 the gutters
 * follow the event navs (the 1344 column's edge, 32px by 1344; 16 on a phone, where the bar is 56px).
 */
export function FairholdNav() {
  return (
    <header className="flex h-68 items-center border-b border-line px-48 max-desk:px-[max(32px,calc(50%-640px))] max-md:h-56 max-md:px-16">
      {/* A full load: from 16c over a gala that is gone, nothing of the old page may stay behind. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- see above */}
      <a href="/" className="flex items-center gap-10 text-16 font-semibold max-md:h-44">
        <PaddleMark tone="brand" size={24} />
        Fairhold
      </a>
      <div className="ml-auto flex items-center gap-12">
        <SandboxMarker variant="platform" />
      </div>
    </header>
  );
}
