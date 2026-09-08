// Editor text -> the HTML Nuance stores.
//
// Drafts are plain text on purpose: patch operations (Draft.mo) match over text,
// agents produce text, and a human types text. HTML exists only at the boundary.
//
// This direction lives in the backend so the tile and the resident background
// cannot disagree about what gets published, and so `nuance_publish` can take a
// draft id instead of a caller-supplied body. An agent therefore cannot publish
// markup other than what the human sees in the editor.
//
// The reverse direction -- article HTML back to editor text -- is not here. It
// is only ever needed by a caller that has already fetched an article, and every
// article fetch now happens in the browser as a free anonymous query, so it lives
// in `src/markup.ts` where it costs the owner nothing to run. Doing it here meant
// the canister scanned a whole article body character by character and then made
// 17 to 40 further full-string rebuild passes over it -- 14 for entity decoding
// and the rest for whitespace and blank-line collapsing -- to produce a field the
// tile discarded.
//
// The round trip is deliberately lossy in either direction: inline emphasis and
// links inside an imported article do not survive it. Callers that import a live
// article must say so.

import Iter "mo:core/Iter";
import List "mo:core/List";
import Text "mo:core/Text";

module {

    // --------------------------------------------------------- text -> HTML

    func escape(value : Text) : Text {
        // `&` must be replaced first or the other replacements get double-escaped.
        var out = Text.replace(value, #text "&", "&amp;");
        out := Text.replace(out, #text "<", "&lt;");
        out := Text.replace(out, #text ">", "&gt;");
        out := Text.replace(out, #text "\"", "&quot;");
        out;
    };

    func lines(block : Text) : [Text] {
        Iter.toArray(Text.split(block, #text "\n"));
    };

    func allLinesStartWith(ls : [Text], prefix : Text) : Bool {
        if (ls.size() == 0) return false;
        for (line in ls.vals()) {
            if (not Text.startsWith(line, #text prefix)) return false;
        };
        true;
    };

    func dropPrefix(value : Text, prefix : Text) : Text {
        switch (Text.stripStart(value, #text prefix)) {
            case (?rest) rest;
            case null value;
        };
    };

    func listItems(ls : [Text], prefix : Text) : Text {
        var out = "";
        for (line in ls.vals()) {
            out #= "<li>" # escape(dropPrefix(line, prefix)) # "</li>";
        };
        out;
    };

    func paragraph(block : Text) : Text {
        // A single newline inside a block is a soft break, matching what a writer
        // sees in the editor.
        "<p>" # Text.replace(escape(block), #text "\n", "<br>") # "</p>";
    };

    /// Convert an editor body to the HTML Nuance stores.
    ///
    /// Blocks are separated by a blank line. Within a block:
    ///   `# ` / `## ` / `### `  headings
    ///   `- `                   unordered list (whole block)
    ///   `> `                   blockquote
    ///   anything else          paragraph, single newlines become `<br>`
    public func textToHtml(body : Text) : Text {
        let normalized = Text.replace(body, #text "\r\n", "\n");
        let blocks = Iter.toArray(Text.split(normalized, #text "\n\n"));
        var out = "";
        for (raw in blocks.vals()) {
            let block = Text.trim(raw, #char ' ') |> Text.trim(_, #char '\n');
            if (block != "") {
                let ls = lines(block);
                if (Text.startsWith(block, #text "### ")) {
                    out #= "<h3>" # escape(dropPrefix(block, "### ")) # "</h3>";
                } else if (Text.startsWith(block, #text "## ")) {
                    out #= "<h2>" # escape(dropPrefix(block, "## ")) # "</h2>";
                } else if (Text.startsWith(block, #text "# ")) {
                    out #= "<h1>" # escape(dropPrefix(block, "# ")) # "</h1>";
                } else if (allLinesStartWith(ls, "- ")) {
                    out #= "<ul>" # listItems(ls, "- ") # "</ul>";
                } else if (allLinesStartWith(ls, "> ")) {
                    var quoted = "";
                    for (line in ls.vals()) {
                        if (quoted != "") quoted #= "\n";
                        quoted #= dropPrefix(line, "> ");
                    };
                    out #= "<blockquote>" # paragraph(quoted) # "</blockquote>";
                } else {
                    out #= paragraph(block);
                };
            };
        };
        out;
    };

    // -------------------------------------------------------------- shared

    func isSpace(c : Char) : Bool {
        c == ' ' or c == '\t' or c == '\n' or c == '\r';
    };

    // ------------------------------------------------------------- excerpts

    /// Bounded plain-text excerpt. Used for agent replies and subtitles, both of
    /// which have hard size limits well below a full article.
    public func excerpt(value : Text, maxChars : Nat) : Text {
        if (value.size() <= maxChars) return value;
        let cs = Text.toArray(value);
        let out = List.empty<Char>();
        var i = 0;
        while (i < maxChars and i < cs.size()) {
            List.add(out, cs[i]);
            i += 1;
        };
        Text.fromIter(List.values(out)) # "...";
    };

    /// Approximate word count, used for editor feedback only.
    public func wordCount(value : Text) : Nat {
        var count = 0;
        var inWord = false;
        for (c in value.chars()) {
            if (isSpace(c)) {
                inWord := false;
            } else if (not inWord) {
                inWord := true;
                count += 1;
            };
        };
        count;
    };
};
