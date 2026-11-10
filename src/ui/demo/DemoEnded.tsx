import { cn } from "../cn";
import { StartDemoForm } from "../entry/EntryForms";
import { FairholdNav } from "../entry/FairholdNav";
import { MESSAGE_COLUMN, MESSAGE_TITLE, MESSAGE_TOP } from "../entry/message-column";

import { OpenLockIcon } from "./icons";

/**
 * design/16c, for a demo gala that ended, was reset or was deleted: the gala is gone, so the page is
 * Fairhold's own. What happened, what happened to the money, and the one action. Below 1024 the
 * column takes the width less the gutters and starts higher; on a phone the card and the button
 * fill it.
 */
export function DemoEnded() {
  return (
    <>
      <FairholdNav />
      <main className={cn("mx-auto flex w-880 flex-col items-center pt-230 text-center tabular-nums", MESSAGE_COLUMN, MESSAGE_TOP)}>
        <p className="font-mono text-11.5 leading-16 tracking-caps text-muted uppercase">Link expired</p>
        <h1 className={cn("mt-8 text-34 leading-40 font-semibold tracking-title", MESSAGE_TITLE)}>This demo gala has ended</h1>

        <div className="mt-32 flex w-480 items-center gap-14 rounded-24 bg-surface py-20 pr-24 pl-22 text-left max-md:mt-24 max-md:w-full max-md:py-16 max-md:pr-16 max-md:pl-16">
          <span className="flex size-48 flex-none items-center justify-center rounded-full bg-white">
            <OpenLockIcon size={18} />
          </span>
          <div>
            <b className="block text-16 leading-22 font-semibold">Any open holds were released</b>
            <span className="mt-2 block text-13 leading-18 text-muted">
              It ran in the PayPal sandbox, so no real money moved.
            </span>
          </div>
        </div>

        <div className="mt-24 max-md:w-full">
          <StartDemoForm label="Start a new demo gala" meta="Private 25-minute gala · 24 lots · simulated guests" />
        </div>
      </main>
    </>
  );
}

/**
 * 16c over an event page whose gala has ended. The layout renders the page anyway (it cannot hold
 * it back without awaiting), so this covers the viewport and hides everything else in the body.
 */
export function DemoEndedOverlay() {
  return (
    <div data-demo-ended="" className="fixed inset-0 z-[100] overflow-y-auto bg-white">
      <style>{"body:has(> [data-demo-ended]) > :not([data-demo-ended]) { display: none !important; }"}</style>
      <DemoEnded />
    </div>
  );
}
