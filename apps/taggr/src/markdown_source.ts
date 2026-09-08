// Markdown source parsing for Taggr post bodies.
//
// Kept free of React so the resident background — which has no DOM and compiles
// under the Bun project — can build plain-text previews from the same parser the
// tile renders with, and so the tokenizer can be tested directly.
//
// The inline vocabulary follows Taggr's own tokenizer in `src/backend/env/post.rs`:
// `@handle`, `#tag`, and `$token` runs of alphanumerics, `-`, and `_`, with
// all-numeric tokens discarded.

export type Block =
  | { kind: "paragraph"; lines: string[] }
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; language: string; lines: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "rule" };

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^```(.*)$/;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^>\s?(.*)$/;
const BULLET = /^[-*+]\s+(.*)$/;
const ORDERED = /^\d{1,3}[.)]\s+(.*)$/;

export const parseBlocks = (source: string): Block[] => {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;

  const flushParagraph = (buffer: string[]) => {
    if (buffer.length > 0) blocks.push({ kind: "paragraph", lines: [...buffer] });
    buffer.length = 0;
  };

  const paragraph: string[] = [];

  while (index < lines.length) {
    const line = lines[index] ?? "";

    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph(paragraph);
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index] ?? "")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      // An unterminated fence still renders as code; dropping the text would
      // lose the post's content.
      index += 1;
      blocks.push({ kind: "code", language: (fence[1] ?? "").trim(), lines: body });
      continue;
    }

    if (line.trim().length === 0) {
      flushParagraph(paragraph);
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      flushParagraph(paragraph);
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph(paragraph);
      blocks.push({
        kind: "heading",
        level: (heading[1] ?? "#").length,
        text: heading[2] ?? "",
      });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      flushParagraph(paragraph);
      const body: string[] = [];
      while (index < lines.length) {
        const quoted = QUOTE.exec(lines[index] ?? "");
        if (!quoted) break;
        body.push(quoted[1] ?? "");
        index += 1;
      }
      blocks.push({ kind: "quote", lines: body });
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      flushParagraph(paragraph);
      const isOrdered = ordered !== null && bullet === null;
      const items: string[] = [];
      while (index < lines.length) {
        const current = lines[index] ?? "";
        const match = isOrdered ? ORDERED.exec(current) : BULLET.exec(current);
        if (!match) break;
        items.push(match[1] ?? "");
        index += 1;
      }
      blocks.push({ kind: "list", ordered: isOrdered, items });
      continue;
    }

    paragraph.push(line);
    index += 1;
  }

  flushParagraph(paragraph);
  return blocks;
};

// Ordered by precedence. `code` is first so nothing inside backticks is styled.
const INLINE =
  /(`[^`\n]+`)|(!\[[^\]\n]*\]\([^)\s]+\))|(\[[^\]\n]*\]\([^)\s]+\))|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(~~[^~\n]+~~)|(\*[^*\n]+\*|_[^_\n]+_)|(https?:\/\/[^\s<>()]+)|([@#$][A-Za-z0-9_-]{1,24})/g;

const isAllDigits = (value: string): boolean => /^[0-9]+$/.test(value);

export type InlineToken =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string }
  | { kind: "image"; alt: string; src: string }
  | { kind: "link"; label: string; href: string }
  | { kind: "strong"; value: string }
  | { kind: "strike"; value: string }
  | { kind: "emphasis"; value: string }
  | { kind: "user"; handle: string }
  | { kind: "tag"; sigil: "#" | "$"; tag: string };

/**
 * Splits one line into inline tokens. Kept separate from rendering so the
 * tokenizer — the part that has to agree with Taggr's own `@`/`#`/`$` handling
 * in `src/backend/env/post.rs` — is directly testable.
 */
export const parseInline = (text: string): InlineToken[] => {
  const tokens: InlineToken[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  INLINE.lastIndex = 0;

  const pushText = (value: string) => {
    if (value.length === 0) return;
    const previous = tokens[tokens.length - 1];
    if (previous?.kind === "text") previous.value += value;
    else tokens.push({ kind: "text", value });
  };

  while ((match = INLINE.exec(text)) !== null) {
    pushText(text.slice(lastIndex, match.index));
    lastIndex = match.index + match[0].length;
    const [, code, image, link, strong, strike, emphasis, bareUrl, token] = match;

    if (code) {
      tokens.push({ kind: "code", value: code.slice(1, -1) });
    } else if (image) {
      const split = image.indexOf("](");
      tokens.push({
        kind: "image",
        alt: image.slice(2, split),
        src: image.slice(split + 2, -1),
      });
    } else if (link) {
      const split = link.indexOf("](");
      const href = link.slice(split + 2, -1);
      tokens.push({ kind: "link", label: link.slice(1, split), href });
    } else if (strong) {
      tokens.push({ kind: "strong", value: strong.slice(2, -2) });
    } else if (strike) {
      tokens.push({ kind: "strike", value: strike.slice(2, -2) });
    } else if (emphasis) {
      tokens.push({ kind: "emphasis", value: emphasis.slice(1, -1) });
    } else if (bareUrl) {
      tokens.push({ kind: "link", label: bareUrl, href: bareUrl });
    } else if (token) {
      const sigil = token[0] ?? "";
      const name = token.slice(1);
      // Taggr discards all-numeric tokens, so `#1` stays ordinary text.
      if (isAllDigits(name)) pushText(token);
      else if (sigil === "@") tokens.push({ kind: "user", handle: name });
      else tokens.push({ kind: "tag", sigil: sigil as "#" | "$", tag: name.toLowerCase() });
    }
  }

  pushText(text.slice(lastIndex));
  return tokens;
};

const joinLines = (lines: string[]): string => lines.join("\n");

/** Plain-text preview used by search results, tray text, and agent tool output. */
export const toPlainText = (source: string, maxLength = 280): string => {
  const text = parseBlocks(source)
    .map((block) => {
      switch (block.kind) {
        case "code":
          return block.language ? `[${block.language} code]` : "[code]";
        case "heading":
          return block.text;
        case "rule":
          return "";
        case "list":
          return block.items.join(" · ");
        case "quote":
        case "paragraph":
        default:
          return joinLines(block.lines);
      }
    })
    .filter((line) => line.length > 0)
    .join("\n")
    .replace(/!\[([^\]\n]*)\]\([^)\s]+\)/g, (_match, alt: string) =>
      alt.trim().length > 0 ? `[image: ${alt.trim()}]` : "[image]",
    )
    .replace(/[`*_~]/g, "")
    .replace(/\[([^\]\n]*)\]\([^)\s]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
};
