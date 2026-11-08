Owner area: API plumbing shared by every route handler. Import from `@/server/api`.

```ts
import { z } from "zod";

import { ApiError, enforceRateLimit, jsonOk, postRoute, readJson, requirePaddle } from "@/server/api";

const body = z.object({ amountCents: z.number().int().positive() });

export const POST = postRoute<RouteContext<"/api/events/[slug]/lots/[number]/bid">>(async (request, { params }) => {
  const { slug, number } = await params;
  const session = await requirePaddle(slug, request);
  const { amountCents } = await readJson(request, body);
  // ...call the engine; refusals are values, so answer them with new ApiError(409, refusal.reason, ...).
  return jsonOk({ ok: true });
});
```

- **Error envelope:** every failure answers `{"error":{"code","message","details"}}`. Throw `ApiError(status, code, message, details?, headers?)` anywhere; `apiRoute` and `postRoute` turn it into the response. Anything else is logged (and stored in `error_log` in production) and answers a 500 that says nothing about the cause. Every answer is `Cache-Control: no-store`. The browser side is `src/ui/api.ts`.
- **`postRoute`** is `apiRoute` plus `assertSameOrigin`: use it for every route that changes something. With Cache Components a GET handler can prerender at build time, so a GET that reads no request data starts with `await connection()`.
- **Guards:** `requireSession`, `requirePaddle` and `requireOrganizer` take `(slug, request)`.
- **Rate limits:** `takeRateLimit` and `enforceRateLimit` count in Postgres (`rate_limits`). `clientRateLimitKey(request, scope)` is the per-client key: a keyed hash, null on a developer's own machine. Pass a transaction's client as the last argument to give the count back on rollback. The sweep calls `pruneRateLimits`.
- **`publicOrigin(request)`** is the origin for absolute URLs such as PayPal's `return_url`.
