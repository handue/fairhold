/**
 * The amount guard: Glim may only repeat dollar figures that code produced, meaning the latest
 * state snapshot or the plan validated this turn. A reply with any other figure (including one
 * copied from a lot title, which never counts) is replaced with a template, so a made-up or
 * injected number never reaches the guest. A figure is anything a guest would read as an amount
 * (findMoneyMentions in money.ts): a number with a dollar sign or currency word in any common
 * shape, fullwidth or other look-alike digits included, a bare number that is not a time, a lot
 * or paddle number or a count, and any amount spelled out in words, which nothing can vouch for.
 */
import { findMoneyMentions, spelledOutAmountIndex } from "./money";

export interface AmountCheck {
  ok: boolean;
  unexpectedCents: number[];
  spelledOut: boolean;
}

export function checkReplyAmounts(text: string, allowed: ReadonlySet<number>): AmountCheck {
  const unexpectedCents = findMoneyMentions(text)
    .map((mention) => mention.cents)
    .filter((cents) => !allowed.has(cents));
  const spelledOut = spelledOutAmountIndex(text) >= 0;
  return { ok: unexpectedCents.length === 0 && !spelledOut, unexpectedCents, spelledOut };
}

export interface GuardedReply {
  text: string;
  replaced: boolean;
  check: AmountCheck;
}

export function guardReply(text: string, allowed: ReadonlySet<number>, template: string): GuardedReply {
  const check = checkReplyAmounts(text, allowed);
  return check.ok ? { text, replaced: false, check } : { text: template, replaced: true, check };
}

/**
 * Enough characters to finish any realistic figure and the words after it that decide whether it
 * is one: "$1,250.00 dollars", "640 US dollars", "19 minutes".
 */
const LOOKAHEAD = 24;

export interface ReplyStreamGuard {
  push(delta: string): void;
  /** Everything received so far. */
  readonly text: string;
  /** How much of text has been emitted. */
  readonly emittedLength: number;
  /** True once a figure the snapshot cannot vouch for appeared; nothing more is emitted. */
  readonly holding: boolean;
}

/**
 * Streams a reply while it is generated, but never ahead of the guard: the last few characters
 * wait in case they become a figure, and the stream pauses at the first figure the snapshot does
 * not contain. Plan amounts are only known once the tool call is validated, so a paused reply is
 * decided by guardReply at the end.
 */
export function createReplyStreamGuard(
  allowed: ReadonlySet<number>,
  emit: (text: string) => void,
): ReplyStreamGuard {
  let text = "";
  let emitted = 0;
  let holding = false;

  const advance = () => {
    const stableEnd = text.length - LOOKAHEAD;
    if (holding || stableEnd <= emitted) return;
    let safeEnd = stableEnd;
    for (const mention of findMoneyMentions(text)) {
      if (mention.end <= emitted) continue;
      if (mention.start >= stableEnd) break;
      const complete = mention.end <= stableEnd;
      if (complete && allowed.has(mention.cents)) continue;
      // Unverified, or still being written: emit only up to where it starts.
      safeEnd = mention.start;
      holding = complete;
      break;
    }
    // Searched in the whole text, like the figures, so one that ends in the tail still counts.
    const spelled = spelledOutAmountIndex(text);
    if (spelled >= 0 && spelled < safeEnd) {
      safeEnd = spelled;
      holding = true;
    }
    if (safeEnd > emitted) {
      emit(text.slice(emitted, safeEnd));
      emitted = safeEnd;
    }
  };

  return {
    push(delta: string) {
      text += delta;
      advance();
    },
    get text() {
      return text;
    },
    get emittedLength() {
      return emitted;
    },
    get holding() {
      return holding;
    },
  };
}
