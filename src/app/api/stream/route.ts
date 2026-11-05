import { connection } from "next/server";

/** Server-sent events for the public and paddle channels (owner: live updates, src/server/sse). */
export async function GET(): Promise<Response> {
  await connection();
  return Response.json({ ok: false, error: "not_implemented" }, { status: 501 });
}
