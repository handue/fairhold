/**
 * Called every 15 minutes by the Render cron job with `Authorization: Bearer $CRON_SECRET`:
 * demo cleanup, reauthorization of aging holds, expiry, and a heartbeat.
 */
export async function POST(): Promise<Response> {
  return Response.json({ ok: false, error: "not_implemented" }, { status: 501 });
}
