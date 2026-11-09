/**
 * Opening Glim from anywhere: any client code calls openGlim(), and the 07 panel, which lives in the
 * event layout's Glim slot, listens with onGlimOpen(). A window event, so a button never needs a
 * prop, a context or an import from the panel. With no panel listening, it does nothing.
 *
 *   openGlim();                                      // the orb, "Let Glim bid for me"
 *   openGlim({ lotNumber: 7 });                      // "Let Glim watch", "Let the agent bid on this lot"
 *   openGlim({ prefill: "Raise my budget" });        // starts the input with this text, unsent
 *
 * The panel, once:
 *
 *   useEffect(() => onGlimOpen((detail) => { setOpen(true); setContextLot(detail.lotNumber ?? null); }), []);
 */
export const GLIM_OPEN_EVENT = "glim:open";

export interface GlimOpenDetail {
  /** The lot the guest opened Glim from; Glim proposes a limit for it, and nothing changes until they confirm. */
  lotNumber?: number;
  /** Text to put in the message input, unsent. */
  prefill?: string;
}

export function openGlim(detail: GlimOpenDetail = {}): void {
  window.dispatchEvent(new CustomEvent<GlimOpenDetail>(GLIM_OPEN_EVENT, { detail }));
}

/** Calls `listener` on every openGlim(); returns the function that stops it, for an effect's cleanup. */
export function onGlimOpen(listener: (detail: GlimOpenDetail) => void): () => void {
  const handle = (event: Event) => listener((event as CustomEvent<GlimOpenDetail>).detail);
  window.addEventListener(GLIM_OPEN_EVENT, handle);
  return () => window.removeEventListener(GLIM_OPEN_EVENT, handle);
}
