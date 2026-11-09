import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { publicOrigin } from "@/server/api/origin";
import { getProjectorSeed } from "@/server/queries/projector";
import { ProjectorScreen } from "@/ui/projector/ProjectorScreen";
import { qrPath } from "@/ui/projector/qr";

type Props = PageProps<"/e/[slug]/projector">;

export const metadata: Metadata = { title: "Projector" };

/** Screen 14: what the room sees on the big screen. Public: no session, paddle numbers and no names. */
export default function ProjectorPage(props: Props) {
  return (
    <Suspense fallback={<div className="fixed inset-0 bg-ink" />}>
      <Projector {...props} />
    </Suspense>
  );
}

async function Projector({ params }: Props) {
  const { slug } = await params;
  const seed = await getProjectorSeed(slug);
  if (!seed) notFound();

  // The QR code opens the gala (whose page sends a visitor to join); the band names the site.
  const requestHeaders = await headers();
  const origin = publicOrigin(new Request(`http://${requestHeaders.get("host") ?? "localhost"}/`, { headers: requestHeaders }));
  const joinUrl = `${origin}/e/${encodeURIComponent(slug)}`;
  return <ProjectorScreen seed={seed} host={new URL(origin).host} qr={qrPath(joinUrl)} joinUrl={joinUrl} />;
}
