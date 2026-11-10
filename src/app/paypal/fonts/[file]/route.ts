/**
 * Geist for the PayPal window's pages (src/server/paypal/window-page.ts), which write their own
 * HTML and so cannot use the app's font loader. The same files the root layout loads, from the
 * geist package, which `npm start` runs beside.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

const FILES: Record<string, () => string> = {
  "geist-sans.woff2": () => path.join(process.cwd(), "node_modules/geist/dist/fonts/geist-sans/Geist-Variable.woff2"),
  "geist-mono.woff2": () => path.join(process.cwd(), "node_modules/geist/dist/fonts/geist-mono/GeistMono-Variable.woff2"),
};

export async function GET(_request: Request, { params }: RouteContext<"/paypal/fonts/[file]">): Promise<Response> {
  const { file } = await params;
  const source = Object.hasOwn(FILES, file) ? FILES[file] : undefined;
  if (!source) return new Response("Not found", { status: 404 });
  try {
    const bytes = await readFile(source());
    return new Response(new Uint8Array(bytes), {
      headers: { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" },
    });
  } catch (error) {
    // The pages fall back to the system font.
    console.error("[paypal/fonts] could not read", file, error);
    return new Response("Not found", { status: 404 });
  }
}
