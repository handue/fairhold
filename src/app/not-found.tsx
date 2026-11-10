import type { Metadata } from "next";

import { cn } from "@/ui/cn";
import { StartDemoForm } from "@/ui/entry/EntryForms";
import { FairholdNav } from "@/ui/entry/FairholdNav";
import { MESSAGE_COLUMN, MESSAGE_TITLE, MESSAGE_TOP } from "@/ui/entry/message-column";

export const metadata: Metadata = { title: "Not found" };

/** Any address Fairhold does not have. No image: 16c's page, with 16's one action. */
export default function NotFound() {
  return (
    <>
      <FairholdNav />
      <main className={cn("mx-auto flex w-880 flex-col items-center pt-230 text-center", MESSAGE_COLUMN, MESSAGE_TOP)}>
        <p className="font-mono text-11.5 leading-16 tracking-caps text-muted uppercase">Not found</p>
        <h1 className={cn("mt-8 text-34 leading-40 font-semibold tracking-title", MESSAGE_TITLE)}>We could not find this page</h1>
        <div className="mt-32 max-md:mt-24 max-md:w-full">
          <StartDemoForm
            label="Start a demo gala"
            meta="Private 25-minute gala · 24 lots · simulated guests · PayPal sandbox, no real money"
          />
        </div>
      </main>
    </>
  );
}
