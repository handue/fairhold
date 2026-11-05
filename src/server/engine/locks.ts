/**
 * Postgres advisory-lock keys, in the two-int4 form (namespace, key). Namespaces in use:
 * 0x4648_0001 engine tick leadership (here), 0x4648_0002 event_log ordering (sse/notify.ts).
 */
export const ENGINE_TICK_LOCK = { namespace: 0x4648_0001, key: 1 } as const;
