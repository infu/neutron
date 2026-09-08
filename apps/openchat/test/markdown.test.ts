import { expect, test } from "bun:test";
import { parseInline, parseBlocks, safeHref, stripMarkdown } from "../src/tile/markdown.tsx";

test("safeHref allows only http(s)/mailto, rejects script/data/relative", () => {
  expect(safeHref("https://oc.app/x")).toBe("https://oc.app/x");
  expect(safeHref("http://a.b")).toBe("http://a.b");
  expect(safeHref("mailto:a@b.com")).toBe("mailto:a@b.com");
  // Security: these must all be rejected so nothing dangerous reaches an href.
  expect(safeHref("javascript:alert(1)")).toBeNull();
  expect(safeHref("JavaScript:alert(1)")).toBeNull();
  expect(safeHref("data:text/html,<script>")).toBeNull();
  expect(safeHref("vbscript:msgbox")).toBeNull();
  expect(safeHref("/relative")).toBeNull();
  expect(safeHref(" javascript:alert(1) ")).toBeNull();
});

test("parseInline: a javascript: link degrades to plain text (no link node)", () => {
  const input = "[click](javascript:alert(1))";
  const nodes = parseInline(input);
  // Security: no link node is produced, and the content is preserved as literal
  // text (which React escapes) — nothing dangerous can reach an href.
  expect(nodes.some((n) => n.t === "link")).toBe(false);
  const asText = nodes.map((n) => (n.t === "text" ? n.v : "")).join("");
  expect(asText).toBe(input);
});

test("parseInline: bold / italic / strike / code / spoiler", () => {
  expect(parseInline("**b**")).toEqual([{ t: "strong", c: [{ t: "text", v: "b" }] }]);
  expect(parseInline("_i_")).toEqual([{ t: "em", c: [{ t: "text", v: "i" }] }]);
  expect(parseInline("~~s~~")).toEqual([{ t: "del", c: [{ t: "text", v: "s" }] }]);
  expect(parseInline("`c`")).toEqual([{ t: "code", v: "c" }]);
  expect(parseInline("||sp||")).toEqual([{ t: "spoiler", c: [{ t: "text", v: "sp" }] }]);
});

test("parseInline: ** wins over * at the same position (strong not em)", () => {
  const nodes = parseInline("**bold**");
  expect(nodes).toEqual([{ t: "strong", c: [{ t: "text", v: "bold" }] }]);
});

test("parseInline: nested emphasis inside bold, and surrounding text", () => {
  const nodes = parseInline("a **b _i_** c");
  expect(nodes[0]).toEqual({ t: "text", v: "a " });
  expect(nodes[1]!.t).toBe("strong");
  const strong = nodes[1] as { t: "strong"; c: unknown[] };
  expect(strong.c).toEqual([{ t: "text", v: "b " }, { t: "em", c: [{ t: "text", v: "i" }] }]);
  expect(nodes[2]).toEqual({ t: "text", v: " c" });
});

test("parseInline: markdown link and bare-url autolink", () => {
  expect(parseInline("[OC](https://oc.app)")).toEqual([
    { t: "link", href: "https://oc.app", label: [{ t: "text", v: "OC" }] },
  ]);
  const auto = parseInline("see https://oc.app, ok");
  expect(auto[0]).toEqual({ t: "text", v: "see " });
  expect(auto[1]).toEqual({ t: "link", href: "https://oc.app", label: [{ t: "text", v: "https://oc.app" }] });
  expect(auto[2]).toEqual({ t: "text", v: "," }); // trailing comma not swallowed
});

test("parseBlocks: fenced code, heading, list, quote", () => {
  const blocks = parseBlocks("# Title\n\n```\ncode\nhere\n```\n\n- one\n- two\n\n> quoted");
  expect(blocks[0]).toEqual({ t: "h", level: 1, c: [{ t: "text", v: "Title" }] });
  expect(blocks[1]).toEqual({ t: "code", v: "code\nhere" });
  expect(blocks[2]!.t).toBe("ul");
  expect((blocks[2] as { items: unknown[] }).items.length).toBe(2);
  expect(blocks[3]!.t).toBe("quote");
});

test("stripMarkdown flattens formatting for previews", () => {
  expect(stripMarkdown("**hello** _world_")).toBe("hello world");
  expect(stripMarkdown("see [OC](https://oc.app)")).toBe("see OC");
  expect(stripMarkdown("`code` and ||secret||")).toBe("code and secret");
  expect(stripMarkdown("# Heading")).toBe("Heading");
});
