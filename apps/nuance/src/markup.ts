// Article HTML -> editor text.
//
// This used to run in Motoko on every article read, which meant the canister
// scanned an entire article body character by character and then made 17 to 40
// further full-string rebuild passes over it -- 14 for entity decoding, the rest
// for whitespace and blank-line collapsing -- to produce a field the tile
// immediately discarded. Nuance articles run to 15 KB and more.
//
// It is a string scanner rather than a `DOMParser` walk on purpose: it runs
// identically in the tile, in the resident background, and in unit tests with no
// DOM, and it is a direct port of the Motoko implementation whose fixtures it
// still satisfies.
//
// Text -> HTML deliberately stays in the backend. `nuance_publish` takes a draft
// id, not a body, so an agent cannot publish markup other than what the human
// sees in the editor.

const BLOCK_OPEN: Record<string, string> = {
  h1: "\n\n# ",
  h2: "\n\n## ",
  h3: "\n\n### ",
  h4: "\n\n### ",
  h5: "\n\n### ",
  h6: "\n\n### ",
  li: "\n- ",
  br: "\n",
  hr: "\n\n",
  p: "\n\n",
  div: "\n\n",
  blockquote: "\n\n> ",
  ul: "\n\n",
  ol: "\n\n",
  pre: "\n\n",
  tr: "\n",
};

const BLOCK_CLOSE: Record<string, string> = {
  h1: "\n",
  h2: "\n",
  h3: "\n",
  h4: "\n",
  h5: "\n",
  h6: "\n",
  p: "\n",
  div: "\n",
  blockquote: "\n",
  pre: "\n",
  ul: "\n",
  ol: "\n",
};

const ENTITIES: [string, string][] = [
  ["&nbsp;", " "],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&#39;", "'"],
  ["&#x27;", "'"],
  ["&apos;", "'"],
  ["&rsquo;", "'"],
  ["&lsquo;", "'"],
  ["&ldquo;", '"'],
  ["&rdquo;", '"'],
  ["&mdash;", "-"],
  ["&ndash;", "-"],
  // `&amp;` last, so an escaped entity such as `&amp;lt;` stays literal.
  ["&amp;", "&"],
];

function decodeEntities(value: string): string {
  let out = value;
  for (const [entity, replacement] of ENTITIES) {
    out = out.split(entity).join(replacement);
  }
  return out;
}

/// Convert stored article markup into editor text.
///
/// A tag-stripping scanner, never a DOM: nothing here parses, executes, or
/// renders. `<script>` and `<style>` bodies are dropped entirely.
export function htmlToText(html: string): string {
  const out: string[] = [];
  const n = html.length;
  let i = 0;
  let skipping = "";

  while (i < n) {
    const char = html[i]!;
    if (char === "<") {
      let j = i + 1;
      let closing = false;
      if (html[j] === "/") {
        closing = true;
        j += 1;
      }
      let name = "";
      while (j < n && !/[\s>/]/.test(html[j]!)) {
        name += html[j]!.toLowerCase();
        j += 1;
      }
      while (j < n && html[j] !== ">") j += 1;
      if (j < n) j += 1;

      if (skipping) {
        if (closing && name === skipping) skipping = "";
      } else if (name === "script" || name === "style") {
        if (!closing) skipping = name;
      } else if (closing) {
        out.push(BLOCK_CLOSE[name] ?? "");
      } else {
        out.push(BLOCK_OPEN[name] ?? "");
      }
      i = j;
    } else {
      if (!skipping) out.push(char);
      i += 1;
    }
  }

  let text = decodeEntities(out.join(""));
  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

/// Bounded excerpt for previews and agent replies.
export function excerpt(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

export function wordCount(value: string): number {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}
