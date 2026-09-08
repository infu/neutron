// Article HTML -> editor text.
//
// This ran in Motoko until the read path moved into the browser. The fixtures
// are carried over verbatim from `markup.test.mo`, so the TypeScript port is
// pinned to the behaviour the Motoko implementation had.

import { expect, test } from "bun:test";
import { excerpt, htmlToText, wordCount } from "../src/markup";

test("block elements become editor blocks", () => {
  expect(htmlToText("<p>One.</p><p>Two.</p>")).toBe("One.\n\nTwo.");
  expect(htmlToText("<h1>Title</h1><h2>Section</h2><p>Body</p>")).toBe(
    "# Title\n\n## Section\n\nBody",
  );
  expect(htmlToText("<ul><li>one</li><li>two</li></ul>")).toBe("- one\n- two");
  expect(htmlToText("<p>One<br>Two</p>")).toBe("One\nTwo");
  expect(htmlToText("")).toBe("");
});

test("inline markup is dropped and its text kept", () => {
  expect(htmlToText("<p>A <strong>bold</strong> and <em>italic</em> word</p>")).toBe(
    "A bold and italic word",
  );
  expect(
    htmlToText('<p>See <a href="https://example.com" target="_blank">the source</a>.</p>'),
  ).toBe("See the source.");
});

test("entities decode, and an escaped entity stays literal", () => {
  expect(htmlToText("<p>Tom &amp; Jerry &lt;tag&gt; &quot;q&quot; &#39;a&#39;</p>")).toBe(
    "Tom & Jerry <tag> \"q\" 'a'",
  );
  expect(htmlToText("<p>&amp;lt;</p>")).toBe("&lt;");
});

test("script and style bodies never reach the editor", () => {
  // Neither should ever appear in a Nuance article, but stripping them here
  // means an imported body cannot smuggle content into the draft.
  expect(htmlToText("<p>before</p><script>alert(1)</script><p>after</p>")).toBe(
    "before\n\nafter",
  );
  expect(htmlToText("<style>p{color:red}</style><p>text</p>")).toBe("text");
});

test("an angle bracket inside an attribute does not break the scanner", () => {
  // The scanner ends a tag at the first `>`, quoted or not. That is the same
  // behaviour the Motoko version had; it is recorded, not relied upon.
  expect(htmlToText('<p class="a>b">text</p>')).toBe('b">text');
});

test("the round trip through the canister's textToHtml preserves structure", () => {
  // `textToHtml` still runs in Motoko, so the two halves have to agree on the
  // same markers. The HTML below is exactly what `Markup.textToHtml` emits for
  // `authored` -- pinned by the fixtures in `markup.test.mo` -- so reading it
  // back here closes the loop without a second implementation of the forward
  // direction.
  const authored = "# Title\n\n## Section\n\nA paragraph.\n\n- one\n- two";
  const stored =
    "<h1>Title</h1><h2>Section</h2><p>A paragraph.</p><ul><li>one</li><li>two</li></ul>";
  expect(htmlToText(stored)).toBe(authored);
});

test("excerpt and word count match the Motoko helpers", () => {
  expect(excerpt("short", 10)).toBe("short");
  expect(excerpt("exactly10!", 10)).toBe("exactly10!");
  expect(excerpt("abcdefghijk", 5)).toBe("abcde...");

  expect(wordCount("one two  three\nfour")).toBe(4);
  expect(wordCount("   ")).toBe(0);
});
