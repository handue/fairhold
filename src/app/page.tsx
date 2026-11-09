import { Suspense } from "react";

import { StartDemoForm } from "@/ui/entry/EntryForms";
import { FairholdNav } from "@/ui/entry/FairholdNav";
import { HomeShowcase } from "@/ui/entry/HomeShowcase";
import { SandboxBuyer } from "@/ui/entry/SandboxBuyer";

/** design/16: the promise and the one action on the left, the product on the right. */
export default function HomePage() {
  return (
    <>
      <FairholdNav />
      <div className="mx-auto max-w-1344 px-48 pt-148 pb-48">
        <div className="grid grid-cols-[minmax(0,1fr)_544px] gap-x-64">
          <main>
            <p className="font-mono text-11.5 leading-16 tracking-caps text-muted uppercase">Charity silent auctions</p>
            <h1 className="mt-16 text-[52px] leading-58 font-semibold tracking-heading">
              <span className="block whitespace-nowrap">Put bidding power on hold.</span>
              <span className="block whitespace-nowrap">Pay only for what you win.</span>
            </h1>
            <p className="mt-20 text-16 leading-24 text-ink2">
              <span className="block whitespace-nowrap">
                Guests approve <b className="font-medium text-ink">a hold with PayPal, not a charge,</b> then bid on lots
              </span>
              <span className="block whitespace-nowrap">or let Glim, a bidding agent, bid for them within their limits.</span>
            </p>

            <div className="mt-40">
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
