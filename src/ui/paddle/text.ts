/**
 * The approved feed never leaves a line's last words alone on a line ("your&nbsp;limit&nbsp;for&nbsp;this&nbsp;lot."):
 * the last five words keep together.
 */
export function keepLastWords(line: string, count = 5): string {
  const words = line.split(" ");
  if (words.length <= count) return line;
  return `${words.slice(0, -count).join(" ")} ${words.slice(-count).join("\u00a0")}`;
}
