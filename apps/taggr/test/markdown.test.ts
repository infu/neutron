import { describe, expect, test } from "bun:test";
import { parseBlocks, parseInline, toPlainText } from "../src/markdown_source.ts";

describe("block parsing", () => {
  test("splits paragraphs on blank lines and keeps soft line breaks", () => {
    expect(parseBlocks("one\ntwo\n\nthree")).toEqual([
      { kind: "paragraph", lines: ["one", "two"] },
      { kind: "paragraph", lines: ["three"] },
    ]);
  });

  test("normalises CRLF so Windows-authored posts do not gain blank lines", () => {
    expect(parseBlocks("one\r\ntwo")).toEqual([
      { kind: "paragraph", lines: ["one", "two"] },
    ]);
  });

  test("reads fenced code and keeps its language label", () => {
    expect(parseBlocks("```rust\nfn main() {}\n```")).toEqual([
      { kind: "code", language: "rust", lines: ["fn main() {}"] },
    ]);
  });

  test("keeps the text of an unterminated fence rather than dropping the post", () => {
    expect(parseBlocks("```\nstill here")).toEqual([
      { kind: "code", language: "", lines: ["still here"] },
    ]);
  });

  test("does not treat a hash inside a fence as a heading", () => {
    expect(parseBlocks("```\n# not a heading\n```")).toEqual([
      { kind: "code", language: "", lines: ["# not a heading"] },
    ]);
  });

  test("reads headings, quotes, rules, and both list kinds", () => {
    expect(parseBlocks("## Title")).toEqual([
      { kind: "heading", level: 2, text: "Title" },
    ]);
    expect(parseBlocks("> quoted\n> lines")).toEqual([
      { kind: "quote", lines: ["quoted", "lines"] },
    ]);
    expect(parseBlocks("---")).toEqual([{ kind: "rule" }]);
    expect(parseBlocks("- a\n- b")).toEqual([
      { kind: "list", ordered: false, items: ["a", "b"] },
    ]);
    expect(parseBlocks("1. a\n2. b")).toEqual([
      { kind: "list", ordered: true, items: ["a", "b"] },
    ]);
  });

  test("requires a space after the hash so a bare tag stays a paragraph", () => {
    expect(parseBlocks("#taggr rules")).toEqual([
      { kind: "paragraph", lines: ["#taggr rules"] },
    ]);
  });

  test("returns nothing for empty or whitespace-only input", () => {
    expect(parseBlocks("")).toEqual([]);
    expect(parseBlocks("   \n\n  ")).toEqual([]);
  });
});

describe("inline tokenizer", () => {
  test("keeps plain text as one run", () => {
    expect(parseInline("just words")).toEqual([
      { kind: "text", value: "just words" },
    ]);
  });

  test("recognises Taggr handles and tags", () => {
    expect(parseInline("hi @alice see #Taggr and $ICP")).toEqual([
      { kind: "text", value: "hi " },
      { kind: "user", handle: "alice" },
      { kind: "text", value: " see " },
      { kind: "tag", sigil: "#", tag: "taggr" },
      { kind: "text", value: " and " },
      { kind: "tag", sigil: "$", tag: "icp" },
    ]);
  });

  test("leaves all-numeric tokens as text, matching Taggr's own tokenizer", () => {
    expect(parseInline("post #123 here")).toEqual([
      { kind: "text", value: "post #123 here" },
    ]);
  });

  test("does not style anything inside a code span", () => {
    expect(parseInline("`**not bold** @nobody`")).toEqual([
      { kind: "code", value: "**not bold** @nobody" },
    ]);
  });

  test("reads markdown links and bare URLs as links", () => {
    expect(parseInline("[docs](https://example.com/x)")).toEqual([
      { kind: "link", label: "docs", href: "https://example.com/x" },
    ]);
    expect(parseInline("see https://example.com/x now")).toEqual([
      { kind: "text", value: "see " },
      { kind: "link", label: "https://example.com/x", href: "https://example.com/x" },
      { kind: "text", value: " now" },
    ]);
  });

  test("reads emphasis, strong, and strikethrough", () => {
    expect(parseInline("**b** _i_ ~~s~~")).toEqual([
      { kind: "strong", value: "b" },
      { kind: "text", value: " " },
      { kind: "emphasis", value: "i" },
      { kind: "text", value: " " },
      { kind: "strike", value: "s" },
    ]);
  });

  test("stops a handle at the first character Taggr would not accept", () => {
    expect(parseInline("@alice, hello")).toEqual([
      { kind: "user", handle: "alice" },
      { kind: "text", value: ", hello" },
    ]);
  });

  test("is not confused by an email-shaped string", () => {
    const tokens = parseInline("mail me at a@b.example");
    expect(tokens.some((token) => token.kind === "user" && token.handle === "b")).toBe(true);
  });
});

describe("plain text preview", () => {
  test("flattens markdown into a single line", () => {
    expect(toPlainText("# Title\n\nSome **bold** text\n\n- one\n- two")).toBe(
      "Title Some bold text one · two",
    );
  });

  test("summarises code blocks instead of inlining them", () => {
    expect(toPlainText("```rust\nfn main() {}\n```")).toBe("[rust code]");
    expect(toPlainText("```\nplain\n```")).toBe("[code]");
  });

  test("keeps link labels and drops their destinations", () => {
    expect(toPlainText("read [the docs](https://example.com)")).toBe("read the docs");
  });

  test("truncates with an ellipsis at the requested length", () => {
    const preview = toPlainText("a".repeat(100), 10);
    expect(preview).toHaveLength(10);
    expect(preview.endsWith("…")).toBe(true);
  });

  test("returns an empty string for an empty body", () => {
    expect(toPlainText("")).toBe("");
  });
});
