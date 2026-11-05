/** Dollar formatting and parsing for Glim's text. Amounts are integer cents throughout. */

export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

/** "$380", "$1,000", "$12.50": whole dollars drop their cents, as on every approved screen. */
export function formatUsd(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(Math.round(cents));
  const dollars = Math.trunc(absolute / 100);
  const remainder = absolute % 100;
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = remainder === 0 ? "" : `.${String(remainder).padStart(2, "0")}`;
  return `${sign}$${grouped}${fraction}`;
}

/**
 * A dollar figure in Glim's text, with its position in the original text. `cents` is NaN for a
 * number that reads as money but matches no amount ("1,0000", "$3.505"), so nothing vouches for it.
 */
export interface MoneyMention {
  start: number;
  end: number;
  cents: number;
}

// Every pattern below runs on folded text (see foldForMatching).

/** A number as written; comma groups are checked when it is parsed. */
const NUMBER = /\d+(?:,\d+)*(?:\.\d+)?/g;
const THOUSANDS_SUFFIX = /^\s?k(?![a-z])/i;
/** "$", "US$", "U.S. $", "USD": a sign before the number. */
const CURRENCY_SIGN = /(?:\bU\.?S\.?\s*\$|\$|\bUSD\b)\s*/gi;
/** "400$", "900 dollars", "900 US dollars", "900 USD", "40 bucks"; a "$" that starts the next figure is not one. */
const CURRENCY_AFTER = /^\s*(?:\$(?!\s*\d)|(?:U\.?S\.?\s*)?dollars?\b|USD\b|bucks\b)/i;

// A bare number (no sign, no currency word) of two or more digits is read as dollars too: "the
// cabin to 640" names an amount just as "$640" does. These are the numbers in Glim's replies
// that are not amounts.
/** "9:30 PM", "9:30", "10pm". */
const CLOCK_TIME = /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[ap]\.?m\.?(?![a-z]))?|\b\d{1,2}\s?[ap]\.?m\.?(?![a-z])/gi;
/** "Lot 07", "Lots 07 and 12", "paddle 142". */
const LOT_OR_PADDLE_NUMBERS =
  /\b(?:lots?|paddles?)\s?#?\d{1,4}(?!\d)(?:(?:\s?[,&]\s?|\s(?:and|or)\s|,\s(?:and|or)\s)#?\d{1,2}(?!\d|[.,]\d))*/gi;
/** "12 bids", "in 19 min", "64%", "21st": a count or an ordinal, not an amount. */
const COUNTED =
  /^\s?(?:%|(?:percent|bids?|lots?|items?|guests?|bidders?|paddles?|people|raises?|times|mins?|minutes?|secs?|seconds?|hrs?|hours?|days?|weeks?|nights?|st|nd|rd|th)\b)/i;

const SMALL_NUMBER_WORDS = "a|one|two|three|four|five|six|seven|eight|nine";
const AMOUNT_NUMBER_WORDS =
  "ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|" +
  "twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion";
const NUMBER_WORD = `${AMOUNT_NUMBER_WORDS}|${SMALL_NUMBER_WORDS}`;
const SPELLED_NUMBER = new RegExp(String.raw`\b(?:${NUMBER_WORD})\b(?:[\s-]+(?:and[\s-]+)?(?:${NUMBER_WORD})\b)*`, "gi");
const AMOUNT_WORD = new RegExp(String.raw`\b(?:${AMOUNT_NUMBER_WORDS})\b`, "i");
const CURRENCY_WORD_AFTER = /^[\s-]+(?:(?:U\.?S\.?\s*)?dollars?|bucks|grand|USD)\b/i;
const CLOCK_WORD_AFTER = /^\s?(?:o['’]clock\b|[ap]\.?m\.?(?![a-z]))/i;

/**
 * Every dollar figure written with digits, in order: a number with a dollar sign or a currency
 * word ("$380", "$ 380", "US$380", "400$", "380 US dollars", "$1.2k"), and any bare number of two
 * or more digits that is not a clock time, a lot or paddle number or a count ("640" in "the cabin
 * to 640"), since a guest reads that as an amount as well.
 */
export function findMoneyMentions(text: string): MoneyMention[] {
  const folded = foldForMatching(text);
  const signStarts = new Map<number, number>();
  for (const sign of folded.text.matchAll(CURRENCY_SIGN)) signStarts.set(sign.index + sign[0].length, sign.index);
  const notAmounts = [...spans(folded.text, CLOCK_TIME), ...spans(folded.text, LOT_OR_PADDLE_NUMBERS)];

  const mentions: MoneyMention[] = [];
  for (const number of folded.text.matchAll(NUMBER)) {
    const start = number.index;
    let end = start + number[0].length;
    let cents = numberCents(number[0]);
    const thousands = THOUSANDS_SUFFIX.exec(folded.text.slice(end));
    if (thousands) {
      cents *= 1000;
      end += thousands[0].length;
    }
    const rest = folded.text.slice(end);
    const signStart = signStarts.get(start);
    const currencyAfter = CURRENCY_AFTER.exec(rest);
    if (signStart !== undefined || currencyAfter) {
      mentions.push({ ...folded.source(signStart ?? start, end + (currencyAfter?.[0].length ?? 0)), cents });
      continue;
    }
    const digits = number[0].replace(/\D/g, "").length;
    const isAmount =
      (digits >= 2 || thousands !== null) &&
      !COUNTED.test(rest) &&
      !notAmounts.some((span) => span.start <= start && end <= span.end);
    if (isAmount) mentions.push({ ...folded.source(start, end), cents });
  }
  return mentions;
}

/**
 * Where the text first names an amount in words, which no allowed set can vouch for, or -1: a
 * number word before a currency word ("five hundred dollars", "two grand"), or a number from ten
 * up that is not a count or a clock time ("at nine hundred").
 */
export function spelledOutAmountIndex(text: string): number {
  const folded = foldForMatching(text);
  for (const phrase of folded.text.matchAll(SPELLED_NUMBER)) {
    const rest = folded.text.slice(phrase.index + phrase[0].length);
    const isAmount =
      CURRENCY_WORD_AFTER.test(rest) ||
      (AMOUNT_WORD.test(phrase[0]) && !COUNTED.test(rest) && !CLOCK_WORD_AFTER.test(rest));
    if (isAmount) return folded.source(phrase.index, phrase.index + phrase[0].length).start;
  }
  return -1;
}

/** Cents for "380", "1,000" or "12.5"; NaN when the commas do not group thousands or the cents run past two digits. */
function numberCents(written: string): number {
  const [whole = "", fraction = ""] = written.split(".");
  const [head = "", ...groups] = whole.split(",");
  const grouped = groups.length === 0 || (head.length <= 3 && groups.every((group) => group.length === 3));
  if (!grouped || fraction.length > 2) return Number.NaN;
  return Number(head + groups.join("")) * 100 + Number(fraction.padEnd(2, "0"));
}

interface Span {
  start: number;
  end: number;
}

function spans(text: string, pattern: RegExp): Span[] {
  return [...text.matchAll(pattern)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
}

interface FoldedText {
  text: string;
  /** The range of the original text that a range of the folded text came from. */
  source(start: number, end: number): Span;
}

const FORMAT_CHARACTER = /\p{Cf}/u;
const DECIMAL_DIGIT = /\p{Nd}/u;
const NON_ASCII_DIGITS = /(?![0-9])\p{Nd}/gu;

/**
 * The text as a guest reads it, for matching. Compatibility forms fold to their plain ones (NFKC:
 * a fullwidth "＄９００" is "$900"), digits of every script become ASCII digits, and invisible
 * format characters drop out, so "$9​00" is "$900" too. Folding goes one character at a time,
 * which keeps a map from each folded character back to the original.
 */
function foldForMatching(text: string): FoldedText {
  let folded = "";
  const sourceStart: number[] = [];
  const sourceEnd: number[] = [];
  let index = 0;
  for (const character of text) {
    const end = index + character.length;
    const replacement = FORMAT_CHARACTER.test(character)
      ? ""
      : character.normalize("NFKC").replace(NON_ASCII_DIGITS, (digit) => String(digitValue(digit)));
    for (let offset = 0; offset < replacement.length; offset += 1) {
      sourceStart.push(index);
      sourceEnd.push(end);
    }
    folded += replacement;
    index = end;
  }
  return {
    text: folded,
    source: (start, end) => ({
      start: sourceStart[start] ?? text.length,
      end: end > start ? (sourceEnd[end - 1] ?? text.length) : (sourceStart[start] ?? text.length),
    }),
  };
}

/** Unicode encodes every script's decimal digits as contiguous runs of ten, zero first. */
function digitValue(digit: string): number {
  const codePoint = digit.codePointAt(0) ?? 0;
  let zero = codePoint;
  while (zero > 0 && DECIMAL_DIGIT.test(String.fromCodePoint(zero - 1))) zero -= 1;
  return (codePoint - zero) % 10;
}
