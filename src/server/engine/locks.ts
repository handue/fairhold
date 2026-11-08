/**
 * Postgres advisory-lock keys, in the two-int4 form (namespace, key). Namespaces in use:
 * 0x4648_0001 engine tick leadership (here), 0x4648_0002 event_log ordering (sse/notify.ts),
 * 0x4648_0003 paddle numbers (sessions/join.ts), 0x4648_0004 demo starts (demo/start.ts),
 * 0x4648_0005 Glim turns (chat/lock.ts), 0x4648_0006 the sweep (director/sweep.ts).
 */
export const ENGINE_TICK_LOCK = { namespace: 0x4648_0001, key: 1 } as const;
