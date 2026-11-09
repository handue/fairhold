import { SandboxMarker } from "../demo/SandboxMarker";
import { PaddleMark } from "../PaddleMark";

/**
 * Fairhold's own nav, on 16 and 16c: 08's bar and brand lockup named Fairhold (15's lockup), with
 * no event pill, links or paddle, and the Sandbox demo label on the right.
 */
export function FairholdNav() {
  return (
    <header className="flex h-68 items-center border-b border-line px-48">
      {/* A full load: from 16c over a gala that is gone, nothing of the old page may stay behind. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- see above */}
      <a href="/" className="flex items-center gap-10 text-16 font-semibold">
        <PaddleMark tone="brand" size={24} />
        Fairhold
      </a>
      <div className="ml-auto flex items-center gap-12">
        <SandboxMarker variant="platform" />
      </div>
    </header>
  );
}
