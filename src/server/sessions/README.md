Owner area: sessions. A browser's identity in one event, with no passwords: an httpOnly, SameSite=Lax cookie (`fh_s_<slug>`, Secure in production) holds a random token, and `sessions.token_hash` holds its HMAC under `SESSION_SECRET`.

- `index.ts`: `createSession`, `attachSessionCookie`, `getSession`, `requireSession`, `requirePaddle`, `requireOrganizer`. The guards throw an `ApiError` (401 `not_joined`, 403 `organizer_only`), and `@/server/api` re-exports them.
- `join.ts`: `joinEvent` hands out the next paddle number under an advisory lock of its own, so numbers never race and joining never touches a lock the engine takes.
- `takesGuests` (`join.ts`): in production only a demo gala takes guests. A seeded event has no organizer and the sweep only retires demos, so nothing could charge or release a hold on it. `joinEvent` and `createHold` answer 403 `event_view_only`.
- `cookie.ts`: the token and the cookie, with no database or framework.

One browser holds one cookie per event, so joining another gala does not cost a guest their paddle in the first. Organizer rights live on the session row, so they cover its event only. Pages read the session through `resolveViewer` (`src/server/queries/viewer.ts`).
