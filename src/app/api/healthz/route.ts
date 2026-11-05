import { connection } from "next/server";

import { getPool } from "@/server/db/client";

const NO_STORE = { "Cache-Control": "no-store" };

/** Render's health check: the process is up and can reach Postgres. */
export async function GET(): Promise<Response> {
  // Without this, Cache Components would prerender the handler at build time.
  await connection();
  try {
    await getPool().query("select 1");
    return Response.json({ ok: true }, { headers: NO_STORE });
  } catch (error) {
    console.error("[healthz] database check failed:", error);
    return Response.json({ ok: false }, { status: 503, headers: NO_STORE });
  }
}
