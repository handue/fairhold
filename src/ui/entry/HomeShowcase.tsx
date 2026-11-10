import { LockIcon } from "../icons";
import { Orb } from "../Orb";
import { PaddleMark } from "../PaddleMark";

/**
 * 16's right column: what a guest sees, from approved parts only, on 10's surface panel. 08's band
 * (its hold half), 15's hello with the orb at 88px, 07's plan card without its buttons, and 08's
 * winning pill beside 11's "Bid by Glim" line. Figures are the approved story's.
 *
 * The board's panel is 516px tall, as tall as the left column with the sandbox buyer card. The 52px
 * above and below keep that height when the card is not shown (no buyer in the environment), so
 * the ink band never sits on the panel's top edge.
 */
export function HomeShowcase() {
  return (
    <aside
      aria-label="How a guest bids"
      className="flex flex-col justify-center rounded-24 bg-surface px-48 py-52"
    >
      <div className="flex h-64 items-center rounded-24 bg-ink px-8 text-white">
        <div className="flex items-center gap-14">
          <span className="flex size-48 flex-none items-center justify-center rounded-full bg-white/8">
            <LockIcon size={18} />
          </span>
          <div>
            <b className="block text-15 leading-20 font-semibold">$500 held with PayPal</b>
            <span className="block text-13 leading-18 text-on-ink-muted">You’re only charged for lots you win.</span>
          </div>
        </div>
      </div>

      <div className="mt-24 flex items-center gap-16">
        {/* 15's 88px orb: the 68px orb zoomed, so its eyes and shading keep their approved proportions. */}
        <span className="flex-none [zoom:1.29412]">
          <Orb size={68} />
        </span>
        <p className="min-w-0 flex-1 rounded-[18px_18px_18px_6px] bg-white px-14 py-11 text-14 leading-[1.45] shadow-[0_1px_0_rgba(11,11,12,.04)]">
          <span className="block whitespace-nowrap">Hi, I’m Glim.</span>
          <span className="block whitespace-nowrap">I bid for you, within your limits.</span>
        </p>
      </div>

      <div className="mt-24 rounded-18 border border-line bg-white p-14">
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-11 tracking-label text-muted uppercase">My plan for you</span>
          <b className="font-mono text-15 font-semibold">$500</b>
        </div>
        <div aria-hidden="true" className="mt-10 flex h-8 gap-2 overflow-hidden rounded-4">
          <i className="block h-full w-[76%] bg-ink" />
          <i className="block h-full w-[24%] bg-lime shadow-[inset_0_0_0_1px_var(--color-lime-edge)]" />
        </div>
        <PlanItem number={1} name="Chef’s Table Dinner" status="Winning at $320" cap="$380" first />
        <PlanItem number={2} name="Spa Day for Two" status="Current bid $85" cap="$120" />
      </div>

      <div className="mt-24 flex items-center gap-12">
        <span className="inline-flex h-30 items-center gap-6 rounded-full bg-lime pr-12 pl-8 text-12.5 font-semibold whitespace-nowrap text-ink shadow-[inset_0_0_0_1px_var(--color-lime-edge)]">
          <PaddleMark tone="winning" size={16} />
          You’re winning
        </span>
        <p className="flex h-22 items-center gap-8 text-13.5 whitespace-nowrap text-ink2">
          <Orb size={22} />
          <span>Bid by Glim</span>
        </p>
      </div>
    </aside>
  );
}

function PlanItem({
  number,
  name,
  status,
  cap,
  first = false,
}: {
  number: number;
  name: string;
  status: string;
  cap: string;
  first?: boolean;
}) {
  return (
    <div className="mt-12 grid grid-cols-[22px_1fr_auto] items-center gap-10">
      <span
        className={
          first
            ? "flex size-22 items-center justify-center rounded-full bg-ink font-mono text-11 font-semibold text-white"
            : "flex size-22 items-center justify-center rounded-full bg-lime font-mono text-11 font-semibold text-ink shadow-[inset_0_0_0_1px_var(--color-lime-edge)]"
        }
      >
        {number}
      </span>
      <div>
        <div className="text-13.5 font-medium">{name}</div>
        <div className="mt-1 text-11.5 text-muted">{status}</div>
      </div>
      <div className="text-right font-mono text-13 font-medium">
        {cap}
        <small className="block text-10.5 font-normal tracking-[.04em] text-muted">MAX</small>
      </div>
    </div>
  );
}
