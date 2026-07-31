export type MotokoSourceToken = {
  text: string;
  line: number;
};

export type MotokoSourceSyntaxFacts = {
  identifiers: readonly string[];
  hasActorReference: boolean;
  hasCallContextTransfer: boolean;
  hasSystemCapability: boolean;
  hasWithCycles: boolean;
};

export type MotokoSourceInspection = MotokoSourceSyntaxFacts & {
  tokens: readonly MotokoSourceToken[];
};

const isAsciiLetter = (character: string): boolean =>
  (character >= "A" && character <= "Z") ||
  (character >= "a" && character <= "z");

const isAsciiDigit = (character: string): boolean =>
  character >= "0" && character <= "9";

// Privileged Motoko spellings are ASCII. Treat non-ASCII code units as part of
// an identifier so a Unicode identifier cannot be split into a dangerous-looking
// ASCII suffix and cause a false positive.
const isIdentifierStart = (character: string): boolean =>
  character === "_" ||
  isAsciiLetter(character) ||
  character.charCodeAt(0) >= 0x80;

const isIdentifierContinue = (character: string): boolean =>
  isIdentifierStart(character) ||
  isAsciiDigit(character) ||
  character === "'";

const hasSequence = (
  tokens: readonly MotokoSourceToken[],
  sequence: readonly string[],
): boolean => {
  if (sequence.length === 0) return true;
  for (let start = 0; start <= tokens.length - sequence.length; start += 1) {
    if (
      sequence.every(
        (expected, offset) => tokens[start + offset]?.text === expected,
      )
    ) {
      return true;
    }
  }
  return false;
};

type ParenthesizedWithFacts = {
  hasCallContextTransfer: boolean;
  hasWithCycles: boolean;
};

const inspectParenthesizedWith = (
  tokens: readonly MotokoSourceToken[],
): ParenthesizedWithFacts => {
  const delimiters: Array<{
    token: string;
    hasWith: boolean;
    hasWithCycles: boolean;
  }> = [];
  let hasCallContextTransfer = false;
  let hasWithCycles = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const text = tokens[index]?.text;
    if (text === "(" || text === "{" || text === "[") {
      delimiters.push({ token: text, hasWith: false, hasWithCycles: false });
      continue;
    }
    if (text === "with") {
      const current = delimiters.at(-1);
      if (current?.token === "(") {
        current.hasWith = true;
        if (
          tokens[index + 1]?.text === "cycles" &&
          tokens[index + 2]?.text === "="
        ) {
          current.hasWithCycles = true;
        }
      }
      continue;
    }
    if (text !== ")" && text !== "}" && text !== "]") continue;
    const current = delimiters.pop();
    if (text === ")" && current?.token === "(") {
      if (current.hasWith) hasCallContextTransfer = true;
      if (current.hasWithCycles) hasWithCycles = true;
    }
  }
  return { hasCallContextTransfer, hasWithCycles };
};

/**
 * Extracts the small set of source facts erased by the compact Motoko AST.
 *
 * The lexer deliberately does not try to parse Motoko. Both callers run the
 * real compiler parser first. Its job is only to preserve identifiers and a
 * few punctuation-sensitive capability forms while excluding nested comments,
 * text literals, and character literals.
 */
export function inspectMotokoSource(source: string): MotokoSourceInspection {
  const tokens: MotokoSourceToken[] = [];
  let index = 0;
  let line = 1;

  const advance = (): string => {
    const character = source[index] ?? "";
    index += 1;
    if (character === "\n") line += 1;
    return character;
  };

  const skipQuoted = (quote: '"' | "'"): void => {
    advance();
    while (index < source.length) {
      const character = advance();
      if (character === "\\") {
        if (index < source.length) advance();
      } else if (character === quote) {
        return;
      }
    }
  };

  while (index < source.length) {
    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";

    if (character === "/" && next === "/") {
      advance();
      advance();
      while (index < source.length && source[index] !== "\n") advance();
      continue;
    }

    if (character === "/" && next === "*") {
      advance();
      advance();
      let depth = 1;
      while (index < source.length && depth > 0) {
        const current = source[index] ?? "";
        const following = source[index + 1] ?? "";
        if (current === "/" && following === "*") {
          advance();
          advance();
          depth += 1;
        } else if (current === "*" && following === "/") {
          advance();
          advance();
          depth -= 1;
        } else {
          advance();
        }
      }
      continue;
    }

    if (character === '"' || character === "'") {
      skipQuoted(character);
      continue;
    }

    if (isIdentifierStart(character)) {
      const tokenLine = line;
      const start = index;
      advance();
      while (
        index < source.length &&
        isIdentifierContinue(source[index] ?? "")
      ) {
        advance();
      }
      tokens.push({ text: source.slice(start, index), line: tokenLine });
      continue;
    }

    if ("(){}[]<>=.,;:".includes(character)) {
      tokens.push({ text: character, line });
    }
    advance();
  }

  const identifiers = [
    ...new Set(
      tokens
        .map(({ text }) => text)
        .filter((text) => isIdentifierStart(text[0] ?? "")),
    ),
  ];
  const parenthesizedWith = inspectParenthesizedWith(tokens);

  return {
    identifiers,
    hasActorReference:
      identifiers.includes("actor") || identifiers.includes("shared"),
    // Every parenthesized call context can inherit cycles: `(context with)`
    // and `(context with timeout = ...)`. A record extension's `with` is
    // nested under `{`, so it does not match this form.
    hasCallContextTransfer: parenthesizedWith.hasCallContextTransfer,
    hasSystemCapability:
      hasSequence(tokens, ["<", "system", ">"]) ||
      hasSequence(tokens, ["<", "system", ","]),
    hasWithCycles: parenthesizedWith.hasWithCycles,
    tokens,
  };
}
