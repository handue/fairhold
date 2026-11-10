import { Eyebrow } from "../Eyebrow";
import { formatUsd } from "../format";

/**
 * design/20 frame 12: in raise mode the explainer's Surface panel holds the raise's two steps, as 07's
 * numbered rows on 10's thread line. The new amount follows the one chosen. On a phone it follows the
 * Hold button.
 */
export function HowTheRaiseWorks({ newHoldCents, currentHoldCents }: { newHoldCents: number; currentHoldCents: number }) {
  const steps = [
    {
      title: `A new ${formatUsd(newHoldCents)} hold is placed`,
      body: "You approve it in a PayPal window. Your bids stay as they are.",
    },
    {
      title: `Then your ${formatUsd(currentHoldCents)} hold is released`,
      body: "Nothing is charged. Some banks take a few days to remove it.",
    },
  ];
  return (
    <section aria-label="How the raise works" className="mt-24 w-480 rounded-20 bg-surface px-24 pt-20 pb-22 text-left max-lg:w-full max-lg:max-w-480 max-md:order-1 max-md:mt-32 max-md:px-20">
      <Eyebrow className="leading-16">How the raise works</Eyebrow>
      <ol className="mt-16">
        {steps.map((step, index) => {
          const last = index === steps.length - 1;
          return (
            <li key={step.title} className={last ? "relative grid grid-cols-[22px_minmax(0,1fr)] gap-x-14" : "relative grid grid-cols-[22px_minmax(0,1fr)] gap-x-14 pb-16"}>
              {!last && <i aria-hidden="true" className="absolute top-28 bottom-4 left-10.5 block w-1 bg-[rgba(11,11,12,.14)]" />}
              <span className="flex size-22 items-center justify-center rounded-full bg-white font-mono text-11 font-semibold">
                {index + 1}
              </span>
              <div>
                <b className="block text-15 leading-22 font-semibold">{step.title}</b>
                <span className="mt-2 block text-13 leading-18 text-muted">{step.body}</span>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
