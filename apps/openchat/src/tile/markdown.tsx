import type { ReactNode } from "react";

// A small, dependency-free Markdown renderer that emits React elements — never
// HTML. Because every text node goes through React (which escapes it) and we
// only ever construct a fixed set of safe elements, there is no HTML-injection
// surface at all: a message can't smuggle <script>, event handlers, styles, or
// a javascript:/data: URL into our (allow-same-origin) frame. This is the
// security boundary OpenChat gets from DOMPurify — we get it structurally.
//
// Supported (the GitHub-flavoured subset users actually type): **bold**,
// *italic*/_italic_, ~~strike~~, `code`, ||spoiler||, [text](url), bare-URL
// autolinks, fenced ``` code blocks, > blockquotes, #-headings, - / 1. lists,
// and --- rules. Anything else is rendered as literal, escaped text.

type Inline =
  | { t: "text"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "del"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "spoiler"; c: Inline[] }
  | { t: "link"; href: string; label: Inline[] };

type Block =
  | { t: "p"; lines: Inline[][] }
  | { t: "h"; level: number; c: Inline[] }
  | { t: "quote"; lines: Inline[][] }
  | { t: "ul"; items: Inline[][] }
  | { t: "ol"; items: Inline[][] }
  | { t: "code"; v: string }
  | { t: "hr" };

/** Only http(s) and mailto links are allowed; everything else (javascript:,
 *  data:, relative, …) is rejected so the label renders as plain text. */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (/^https?:\/\/[^\s]+$/i.test(href)) return href;
  if (/^mailto:[^\s]+$/i.test(href)) return href;
  return null;
}

// Inline delimiter rules, tried by earliest match position (ties broken by the
// order here, so ** wins over *). `code` and autolinks don't parse their inner.
const INLINE_RULES: { kind: Inline["t"] | "url"; re: RegExp }[] = [
  { kind: "code", re: /`([^`]+)`/ },
  { kind: "link", re: /\[([^\]]*)\]\(([^)\s]+)\)/ },
  { kind: "spoiler", re: /\|\|([\s\S]+?)\|\|/ },
  { kind: "strong", re: /\*\*([\s\S]+?)\*\*/ },
  { kind: "strong", re: /__([\s\S]+?)__/ },
  { kind: "del", re: /~~([\s\S]+?)~~/ },
  { kind: "em", re: /\*([^*\n]+?)\*/ },
  { kind: "em", re: /_([^_\n]+?)_/ },
  { kind: "url", re: /https?:\/\/[^\s<]+/ },
];

export function parseInline(text: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let rest = text;
  if (depth > 8) return [{ t: "text", v: text }]; // guard against pathological nesting
  while (rest.length > 0) {
    let best: { idx: number; order: number; m: RegExpExecArray; kind: string } | null = null;
    INLINE_RULES.forEach((rule, order) => {
      const m = rule.re.exec(rest);
      if (m && (best === null || m.index < best.idx)) best = { idx: m.index, order, m, kind: rule.kind };
    });
    if (!best) {
      out.push({ t: "text", v: rest });
      break;
    }
    // Non-null assertion: the closure above assigned `best` when a rule matched.
    const chosen = best as { idx: number; order: number; m: RegExpExecArray; kind: string };
    if (chosen.idx > 0) out.push({ t: "text", v: rest.slice(0, chosen.idx) });
    const m = chosen.m;
    switch (chosen.kind) {
      case "code":
        out.push({ t: "code", v: m[1]! });
        break;
      case "url": {
        let url = m[0]!;
        let trail = "";
        // Don't swallow trailing sentence punctuation into the URL.
        const tm = /[).,;:!?]+$/.exec(url);
        if (tm) {
          trail = tm[0];
          url = url.slice(0, -trail.length);
        }
        const href = safeHref(url);
        out.push(href ? { t: "link", href, label: [{ t: "text", v: url }] } : { t: "text", v: url });
        if (trail) out.push({ t: "text", v: trail });
        break;
      }
      case "link": {
        const href = safeHref(m[2]!);
        const label = parseInline(m[1]!, depth + 1);
        out.push(href ? { t: "link", href, label } : { t: "text", v: m[0]! });
        break;
      }
      case "spoiler":
        out.push({ t: "spoiler", c: parseInline(m[1]!, depth + 1) });
        break;
      case "strong":
        out.push({ t: "strong", c: parseInline(m[1]!, depth + 1) });
        break;
      case "del":
        out.push({ t: "del", c: parseInline(m[1]!, depth + 1) });
        break;
      case "em":
        out.push({ t: "em", c: parseInline(m[1]!, depth + 1) });
        break;
    }
    rest = rest.slice(chosen.idx + m[0]!.length);
  }
  return out;
}

export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    // Fenced code block.
    const fence = /^```/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i]!)) body.push(lines[i++]!);
      if (i < lines.length) i++; // closing fence
      blocks.push({ t: "code", v: body.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    const hr = /^(-{3,}|\*{3,}|_{3,})\s*$/.exec(line);
    if (hr) {
      blocks.push({ t: "hr" });
      i++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ t: "h", level: heading[1]!.length, c: parseInline(heading[2]!) });
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: Inline[][] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) quote.push(parseInline(lines[i++]!.replace(/^>\s?/, "")));
      blocks.push({ t: "quote", lines: quote });
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: Inline[][] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i]!)) items.push(parseInline(lines[i++]!.replace(/^[-*]\s+/, "")));
      blocks.push({ t: "ul", items });
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items: Inline[][] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i]!)) items.push(parseInline(lines[i++]!.replace(/^\d+\.\s+/, "")));
      blocks.push({ t: "ol", items });
      continue;
    }
    // Paragraph: gather consecutive plain lines (soft breaks become <br/>).
    const para: Inline[][] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^```|^>\s?|^[-*]\s+|^\d+\.\s+|^#{1,6}\s+/.test(lines[i]!) &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]!)
    ) {
      para.push(parseInline(lines[i++]!));
    }
    blocks.push({ t: "p", lines: para });
  }
  return blocks;
}

// ---- render to React ----
function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, k) => {
    switch (n.t) {
      case "text":
        return <span key={k}>{n.v}</span>;
      case "strong":
        return <strong key={k}>{renderInline(n.c)}</strong>;
      case "em":
        return <em key={k}>{renderInline(n.c)}</em>;
      case "del":
        return <del key={k}>{renderInline(n.c)}</del>;
      case "code":
        return (
          <code key={k} className="md-code">
            {n.v}
          </code>
        );
      case "spoiler":
        return (
          <span key={k} className="md-spoiler" title="Spoiler">
            {renderInline(n.c)}
          </span>
        );
      case "link":
        return (
          <a key={k} href={n.href} target="_blank" rel="noreferrer noopener">
            {renderInline(n.label)}
          </a>
        );
    }
  });
}

function joinLines(lines: Inline[][]): ReactNode[] {
  return lines.flatMap((ln, k) => (k === 0 ? renderInline(ln) : [<br key={`br${k}`} />, ...renderInline(ln)]));
}

export function Markdown({ text }: { text: string }): ReactNode {
  const blocks = parseBlocks(text);
  // A single paragraph is the overwhelmingly common case — render it inline
  // (no block margins) so short messages don't gain surprise spacing.
  if (blocks.length === 1 && blocks[0]!.t === "p") {
    return <span className="md">{joinLines((blocks[0] as { lines: Inline[][] }).lines)}</span>;
  }
  return (
    <span className="md md--block">
      {blocks.map((b, k) => {
        switch (b.t) {
          case "p":
            return <p key={k} className="md-p">{joinLines(b.lines)}</p>;
          case "h":
            return (
              <p key={k} className={`md-h md-h${b.level}`}>
                {renderInline(b.c)}
              </p>
            );
          case "quote":
            return (
              <blockquote key={k} className="md-quote">
                {joinLines(b.lines)}
              </blockquote>
            );
          case "ul":
            return (
              <ul key={k} className="md-list">
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={k} className="md-list">
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it)}</li>
                ))}
              </ol>
            );
          case "code":
            return (
              <pre key={k} className="md-pre">
                <code>{b.v}</code>
              </pre>
            );
          case "hr":
            return <hr key={k} className="md-hr" />;
        }
      })}
    </span>
  );
}

/** Flatten markdown to plain text for one-line previews (drops formatting
 *  markers so `**bold**` shows as `bold`, links show their label, etc.). */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, "$1")
    .replace(/\|\|([\s\S]+?)\|\|/g, "$1")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[^*])\*([^*\n]+?)\*/g, "$1$2")
    .replace(/(^|[^_])_([^_\n]+?)_/g, "$1$2")
    .replace(/^\s{0,3}(#{1,6}|>|[-*]|\d+\.)\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}
