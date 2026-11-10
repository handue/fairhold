import { connection } from "next/server";

import { getServerEnv } from "@/server/lib/env";

import { CopyButton } from "../demo/CopyButton";

/**
 * 16 and 16b's PayPal sandbox buyer: a public sandbox test account for judges, from
 * DEMO_BUYER_1_EMAIL and DEMO_BUYER_1_PASSWORD. The email shows and copies; the password only
 * copies. Read per request, so a locked account can be swapped in Render without a rebuild.
 * Render it inside a <Suspense> boundary; without both values it renders nothing.
 */
export async function SandboxBuyer() {
  await connection();
  const env = getServerEnv();
  const email = env.DEMO_BUYER_1_EMAIL;
  const password = env.DEMO_BUYER_1_PASSWORD;
  if (!email || !password) return null;
  return <SandboxBuyerCard email={email} password={password} />;
}

/** On a phone the card fills the width, its two lines stack, and the rows grow to the 40px buttons. */
export function SandboxBuyerCard({ email, password }: { email: string; password: string }) {
  return (
    <section
      aria-label="PayPal sandbox buyer"
      className="mt-40 w-480 rounded-20 border border-line py-16 pr-16 pl-20 text-left max-md:mt-32 max-md:w-full max-md:pl-16"
    >
      <div className="flex h-16 items-baseline justify-between max-md:h-auto max-md:flex-col max-md:gap-4">
        <span className="font-mono text-11 leading-16 tracking-caps text-muted uppercase">PayPal sandbox buyer</span>
        <span className="text-12.5 leading-16 text-muted">Use it in the PayPal window</span>
      </div>
      <div className="mt-12 grid h-32 grid-cols-[72px_minmax(0,1fr)_auto] items-center gap-x-12 max-md:h-40 max-md:grid-cols-[64px_minmax(0,1fr)_auto]">
        <span className="text-13 text-muted">Email</span>
        <span className="overflow-hidden font-mono text-12.5 whitespace-nowrap text-ink max-desk:text-ellipsis">{email}</span>
        <CopyButton value={email} label="Copy the sandbox buyer’s email" />
      </div>
      <div className="mt-4 grid h-32 grid-cols-[72px_minmax(0,1fr)_auto] items-center gap-x-12 max-md:h-40 max-md:grid-cols-[64px_minmax(0,1fr)_auto]">
        <span className="text-13 text-muted">Password</span>
        <span aria-label="Password, hidden" className="overflow-hidden text-15 tracking-[.08em] whitespace-nowrap text-ink">
          ••••••••••
        </span>
        <CopyButton value={password} label="Copy the sandbox buyer’s password" />
      </div>
    </section>
  );
}
