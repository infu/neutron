/**
 * JSON.parse keeps the last duplicate member. Reject duplicates first so every
 * implementation sees one unambiguous signed/digest-bound record.
 */
export function assertNoDuplicateJsonObjectKeys(text: string): void {
  let index = 0;

  const skipWhitespace = (): void => {
    while (/\s/u.test(text[index] ?? "")) index += 1;
  };

  const parseStringToken = (): string => {
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index]!;
      if (character === "\\") {
        index += 2;
        continue;
      }
      index += 1;
      if (character === '"') {
        return JSON.parse(text.slice(start, index)) as string;
      }
    }
    throw new Error("record contains an unterminated JSON string");
  };

  const parseValue = (): void => {
    skipWhitespace();
    const character = text[index];
    if (character === "{") {
      parseObject();
      return;
    }
    if (character === "[") {
      parseArray();
      return;
    }
    if (character === '"') {
      parseStringToken();
      return;
    }
    while (
      index < text.length &&
      !/[\s,\]}]/u.test(text[index] ?? "")
    ) {
      index += 1;
    }
  };

  const parseObject = (): void => {
    index += 1;
    skipWhitespace();
    const keys = new Set<string>();
    if (text[index] === "}") {
      index += 1;
      return;
    }
    while (index < text.length) {
      skipWhitespace();
      const key = parseStringToken();
      if (keys.has(key)) {
        throw new Error(`record contains duplicate JSON field ${key}`);
      }
      keys.add(key);
      skipWhitespace();
      index += 1; // JSON.parse already proved this is a colon.
      parseValue();
      skipWhitespace();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      index += 1; // JSON.parse already proved this is a comma.
    }
  };

  const parseArray = (): void => {
    index += 1;
    skipWhitespace();
    if (text[index] === "]") {
      index += 1;
      return;
    }
    while (index < text.length) {
      parseValue();
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      index += 1; // JSON.parse already proved this is a comma.
    }
  };

  parseValue();
}
