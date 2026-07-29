/** Parse a shell-like argument string without invoking a shell. */
export function parseExtraArgs(input: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;
  let started = false;

  for (const character of input) {
    if (escaping) {
      current += character;
      escaping = false;
      started = true;
    } else if (character === "\\" && quote !== "'") {
      escaping = true;
      started = true;
    } else if (quote !== undefined) {
      if (character === quote) quote = undefined;
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) {
        result.push(current);
        current = "";
        started = false;
      }
    } else {
      current += character;
      started = true;
    }
  }
  if (escaping || quote !== undefined) {
    throw new Error("extra-args contains an unterminated quote or escape");
  }
  if (started) result.push(current);
  return result;
}
