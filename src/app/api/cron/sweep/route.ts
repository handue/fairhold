import { createHash, timingSafeEqual } from "node:crypto";

import { ApiError, apiRoute, jsonOk } from "@/server/api";
import { runSweep } from "@/server/director/sweep";
import { getServerEnv } from "@/server/lib/env";

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Digests first, so the comparison takes the same time whatever was sent. */
function assertCronBearer(request: Request): void {
  const sent = request.headers.get("authorization") ?? "";
  if (!timingSafeEqual(digest(sent), digest(`Bearer ${getServerEnv().CRON_SECRET}`))) {
    throw new ApiError(401, "unauthorized", "This endpoint is for the sweep job.");
  }
}

/**
 * Called every 15 minutes by the Render cron job with `Authorization: Bearer $CRON_SECRET`: holds
 * past their expiry, retried voids of replaced holds, the 6-hour demo cleanup (voiding real holds
 * first) and a heartbeat. Answers 200 with the report; a PayPal failure stays in the report and is
 * retried next time. Answers 500 sweep_failed when a step could not run at all.
 */
export const POST = apiRoute(async (request) => {
  assertCronBearer(request);
  const report = await runSweep();
  if (report.errors.length > 0) throw new ApiError(500, "sweep_failed", "A step of the sweep failed.", report);
  return jsonOk(report);
});
