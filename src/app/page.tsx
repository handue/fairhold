import { Suspense } from "react";

import { StartDemoForm } from "@/ui/entry/EntryForms";
import { FairholdNav } from "@/ui/entry/FairholdNav";
import { HomeShowcase } from "@/ui/entry/HomeShowcase";
import { SandboxBuyer } from "@/ui/entry/SandboxBuyer";

/**
 * design/16: the promise and the one action on the left, the product on the right.
 *
 * Below 1440 the title scales with the screen so each sentence keeps its one line: on laptops it
 * leaves the product its column (up to the board's 544px); below 1024 the product goes under the
 * promise and the action, and on a phone the button fills the width.
 */
export default function HomePage() {
  return (
    <>
      <FairholdNav />
      <div className="mx-auto max-w-1344 px-48 pt-148 pb-48 max-desk:px-32 max-desk:pt-112 max-lg:pt-64 max-md:px-16 max-md:pt-32 max-md:pb-32">
        <div className="grid grid-cols-[minmax(0,1fr)_544px] gap-x-64 max-desk:grid-cols-[auto_minmax(0,544px)] max-desk:justify-between max-desk:gap-x-48 max-lg:grid-cols-1 max-lg:gap-y-48 max-md:gap-y-40">
          <main className="max-lg:min-w-0">
            <p className="font-mono text-11.5 leading-16 tracking-caps text-muted uppercase">Charity silent auctions</p>
            <h1 className="mt-16 text-[52px] leading-58 font-semibold tracking-heading max-desk:text-[length:clamp(40px,calc(2.885vw_+_10.46px),52px)] max-desk:leading-[1.12] max-lg:text-[52px] max-lg:leading-58 max-md:mt-12 max-md:text-[length:clamp(22px,calc((100vw_-_32px)/12.4),40px)] max-md:leading-[1.15]">
              <span className="block whitespace-nowrap">Put bidding power on hold.</span>
              <span className="block whitespace-nowrap">Pay only for what you win.</span>
            </h1>
            <p className="mt-20 text-16 leading-24 text-ink2 max-md:mt-16">
              <span className="block whitespace-nowrap max-md:inline max-md:whitespace-normal">
                Guests approve <b className="font-medium text-ink">a hold with PayPal, not a charge,</b> then bid on lots
              </span>{" "}
              <span className="block whitespace-nowrap max-md:inline max-md:whitespace-normal">
                or let Glim, a bidding agent, bid for them within their limits.
              </span>
            </p>

            <div className="mt-40 max-md:mt-32">
              <StartDemoForm
                label="Start a demo gala"
                meta="Private 25-minute gala · 24 lots · simulated guests · PayPal sandbox, no real money"
              />
            </div>

            <Suspense fallback={null}>
              <SandboxBuyer />
            </Suspense>
          </main>

          <HomeShowcase />
        </div>
      </div>
    </>
  );
}
