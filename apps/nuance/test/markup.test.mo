// Markup tests: editor text -> the HTML Nuance stores.
//
// These run in the browser Motoko interpreter via
// `bun ../../packages/neutron-scripts/src/run_motoko_program.ts`. The program
// traps on the first failure, which the runner reports as a failed test.
//
// The reverse direction lives in `src/markup.ts` because it only ever runs in
// the browser; its tests are in `test/markup.test.ts`, and they include the
// round-trip fixtures that used to live here.

import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";
import Markup "../backend/nuance/Markup";

func check(name : Text, actual : Text, expected : Text) {
    if (actual != expected) {
        Debug.print("FAIL " # name);
        Debug.print("  expected: " # debug_show (expected));
        Debug.print("  actual:   " # debug_show (actual));
        Runtime.trap("markup test failed: " # name);
    };
};

func checkNat(name : Text, actual : Nat, expected : Nat) {
    if (actual != expected) {
        Runtime.trap(
            "markup test failed: " # name # " expected " # debug_show (expected) #
            " got " # debug_show (actual)
        );
    };
};

// ------------------------------------------------------------ text -> HTML

check(
    "single paragraph",
    Markup.textToHtml("Hello world"),
    "<p>Hello world</p>",
);

check(
    "two paragraphs",
    Markup.textToHtml("One.\n\nTwo."),
    "<p>One.</p><p>Two.</p>",
);

check(
    "soft break inside a paragraph",
    Markup.textToHtml("Line one\nLine two"),
    "<p>Line one<br>Line two</p>",
);

check(
    "headings",
    Markup.textToHtml("# Title\n\n## Section\n\n### Sub"),
    "<h1>Title</h1><h2>Section</h2><h3>Sub</h3>",
);

check(
    "unordered list",
    Markup.textToHtml("- one\n- two"),
    "<ul><li>one</li><li>two</li></ul>",
);

check(
    "blockquote",
    Markup.textToHtml("> quoted"),
    "<blockquote><p>quoted</p></blockquote>",
);

// Escaping is the security-relevant direction: a writer typing markup must not
// be able to inject live elements into the published article.
check(
    "escapes markup",
    Markup.textToHtml("<script>alert(1)</script>"),
    "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
);

check(
    "escapes ampersand before other entities",
    Markup.textToHtml("Tom & Jerry <tag>"),
    "<p>Tom &amp; Jerry &lt;tag&gt;</p>",
);

check(
    "escapes quotes",
    Markup.textToHtml("say \"hi\""),
    "<p>say &quot;hi&quot;</p>",
);

check(
    "blank runs collapse to block boundaries",
    Markup.textToHtml("A\n\n\n\nB"),
    "<p>A</p><p>B</p>",
);

check("empty body", Markup.textToHtml(""), "");

// ---------------------------------------------------------------- excerpts

check("excerpt under limit", Markup.excerpt("short", 10), "short");
check("excerpt at limit", Markup.excerpt("exactly10!", 10), "exactly10!");
check("excerpt over limit", Markup.excerpt("abcdefghijk", 5), "abcde...");

checkNat("word count", Markup.wordCount("one two  three\nfour"), 4);
checkNat("word count empty", Markup.wordCount("   "), 0);

Debug.print("markup: all assertions passed");
