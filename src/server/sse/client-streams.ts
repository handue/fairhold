/**
 * How many open streams one client has, per process: /api/stream needs no session, so without this
 * one script could take all of the process's streams and everyone else would fall back to polling.
 * A browser needs a few, and a venue's guests behind one address who pass this still get polling.
 * Counted in memory, because a stream lives exactly as long as this process's connection does.
 */
export const MAX_STREAMS_PER_CLIENT = 20;

const processGlobal = globalThis as typeof globalThis & { __fairholdClientStreams?: Map<string, number> };

/** A function that gives the slot back, safe to call twice; null past the limit. A null key is not limited. */
export function claimClientStream(key: string | null): (() => void) | null {
  if (key === null) return () => {};
  const streams = (processGlobal.__fairholdClientStreams ??= new Map());
  const open = streams.get(key) ?? 0;
  if (open >= MAX_STREAMS_PER_CLIENT) return null;
  streams.set(key, open + 1);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (streams.get(key) ?? 1) - 1;
    if (left > 0) streams.set(key, left);
    else streams.delete(key);
  };
}
