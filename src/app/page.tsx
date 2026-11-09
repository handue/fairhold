import { FirstNameForm } from "@/ui/entry/FirstNameForm";

/** Stands in for design/16, plain and with no layout of its own, until that image is approved. */
export default function HomePage() {
  return (
    <main className="mx-auto max-w-1344 px-48 pt-24 pb-48">
      <h1 className="text-30 leading-40 font-semibold tracking-title">Fairhold</h1>
      <p className="mt-8 text-14 text-muted">
        Charity silent auctions: put bidding power on hold with PayPal, bid, and pay only for what you win.
      </p>
      <FirstNameForm endpoint="/api/demo" submitLabel="Start a demo gala" sendTimeZone />
      <p className="mt-12 text-14 text-muted">A private 25-minute gala with simulated guests. PayPal sandbox, no real money.</p>
    </main>
  );
}
