// The draft patch engine.
//
// This is the part a collaborating agent drives, so it is deliberately strict:
// every match is an exact substring, never fuzzy and never a regex, and an op
// that is not uniquely satisfiable fails loudly instead of guessing. An agent
// that half-matches prose destroys the human's writing, so ambiguity is an
// error, not a heuristic.
//
// `apply` is atomic over the whole op list: it works on a copy and returns
// either a fully-updated target or an error. The caller only bumps the draft
// revision on `#ok`, so a rejected patch leaves the shared draft untouched.
//
// The module is pure -- no memory, no capabilities, no time -- which is what
// makes it exhaustively testable in `test/draft.test.mo`.

import Iter "mo:core/Iter";
import List "mo:core/List";
import Text "mo:core/Text";
import Markup "Markup";

module {

    /// Patch operations.
    ///
    /// `#replace` matches an exact substring; with `occurrence = null` the match
    /// must be unique, with `?n` the 1-based nth match is used.
    ///
    /// `#insert_after` / `#insert_before` are block-level: a blank line is
    /// inserted between the anchor and the new text. Use `#replace` for
    /// mid-sentence edits.
    ///
    /// `#replace_section` replaces everything under a heading line while keeping
    /// the heading. `heading` is the full line as authored, e.g. "## Introduction".
    public type Op = {
        #replace : { find : Text; replaceWith : Text; occurrence : ?Nat };
        #insert_after : { find : Text; text : Text };
        #insert_before : { find : Text; text : Text };
        #append : { text : Text };
        #prepend : { text : Text };
        #replace_section : { heading : Text; body : Text };
        #set_title : Text;
        #set_subtitle : Text;
        #set_tags : [Text];
    };

    public type PatchError = {
        #empty_find;
        #not_found : { find : Text };
        #ambiguous : { find : Text; count : Nat };
        #section_not_found : { heading : Text };
        #too_large : { size : Nat; limit : Nat };
        #no_ops;
    };

    public type Target = {
        title : Text;
        subtitle : Text;
        tagIds : [Text];
        body : Text;
    };

    public type PatchResult = {
        #ok : { target : Target; applied : [Text] };
        #err : PatchError;
    };

    public func errorText(error : PatchError) : Text {
        switch (error) {
            case (#empty_find) "A patch op supplied an empty `find` value.";
            case (#not_found({ find })) "No match for " # debug_show (Markup.excerpt(find, 60));
            case (#ambiguous({ find; count })) {
                "Found " # debug_show (count) # " matches for " #
                debug_show (Markup.excerpt(find, 60)) #
                "; extend `find` or pass `occurrence`.";
            };
            case (#section_not_found({ heading })) {
                "No heading line equal to " # debug_show (Markup.excerpt(heading, 60));
            };
            case (#too_large({ size; limit })) {
                "Body would be " # debug_show (size) # " characters; the limit is " #
                debug_show (limit) # ".";
            };
            case (#no_ops) "The patch contained no operations.";
        };
    };

    // ------------------------------------------------------ search helpers

    /// First index of `needle` in `hay` at or after `start`, in characters.
    func indexOfFrom(hay : [Char], needle : [Char], start : Nat) : ?Nat {
        let n = hay.size();
        let m = needle.size();
        if (m == 0 or m > n) return null;
        var i = start;
        while (i + m <= n) {
            var j = 0;
            var matched = true;
            label compare while (j < m) {
                if (hay[i + j] != needle[j]) { matched := false; break compare };
                j += 1;
            };
            if (matched) return ?i;
            i += 1;
        };
        null;
    };

    /// Non-overlapping occurrence count.
    func countOccurrences(hay : [Char], needle : [Char]) : Nat {
        let m = needle.size();
        if (m == 0) return 0;
        var count = 0;
        var from = 0;
        label scan loop {
            switch (indexOfFrom(hay, needle, from)) {
                case (?index) { count += 1; from := index + m };
                case null break scan;
            };
        };
        count;
    };

    func slice(cs : [Char], from : Nat, to : Nat) : Text {
        let out = List.empty<Char>();
        var i = from;
        while (i < to and i < cs.size()) {
            List.add(out, cs[i]);
            i += 1;
        };
        Text.fromIter(List.values(out));
    };

    /// Splice `replacement` over `[at, at + length)`.
    func spliceAt(cs : [Char], at : Nat, length : Nat, replacement : Text) : Text {
        slice(cs, 0, at) # replacement # slice(cs, at + length, cs.size());
    };

    /// Resolve the 1-based occurrence an op refers to, applying the uniqueness
    /// rule when the caller did not pin one.
    func resolveMatch(
        body : Text,
        find : Text,
        occurrence : ?Nat,
    ) : { #ok : { index : Nat; length : Nat }; #err : PatchError } {
        if (find == "") return #err(#empty_find);
        let hay = Text.toArray(body);
        let needle = Text.toArray(find);
        let total = countOccurrences(hay, needle);
        if (total == 0) return #err(#not_found({ find }));

        let wanted = switch (occurrence) {
            case (?n) { if (n == 0) 1 else n };
            case null {
                if (total > 1) return #err(#ambiguous({ find; count = total }));
                1;
            };
        };
        if (wanted > total) return #err(#not_found({ find }));

        var from = 0;
        var seen = 0;
        loop {
            switch (indexOfFrom(hay, needle, from)) {
                case (?index) {
                    seen += 1;
                    if (seen == wanted) {
                        return #ok({ index; length = needle.size() });
                    };
                    from := index + needle.size();
                };
                case null return #err(#not_found({ find }));
            };
        };
    };

    func joinBlock(left : Text, right : Text) : Text {
        if (left == "") return right;
        if (right == "") return left;
        left # "\n\n" # right;
    };

    func isHeadingLine(line : Text) : Bool {
        Text.startsWith(line, #text "# ") or Text.startsWith(line, #text "## ") or Text.startsWith(line, #text "### ");
    };

    // ------------------------------------------------------------- sections

    func replaceSection(body : Text, heading : Text, replacement : Text) : { #ok : Text; #err : PatchError } {
        let wanted = Text.trim(heading, #char ' ');
        if (wanted == "") return #err(#section_not_found({ heading }));
        let ls = Iter.toArray(Text.split(body, #text "\n"));

        var matches = 0;
        var at = 0;
        var i = 0;
        while (i < ls.size()) {
            if (Text.trim(ls[i], #char ' ') == wanted) {
                matches += 1;
                if (matches == 1) at := i;
            };
            i += 1;
        };
        if (matches == 0) return #err(#section_not_found({ heading }));
        if (matches > 1) return #err(#ambiguous({ find = heading; count = matches }));

        // The section runs to the next heading line, or the end of the body.
        var stop = at + 1;
        while (stop < ls.size() and not isHeadingLine(Text.trim(ls[stop], #char ' '))) {
            stop += 1;
        };

        let before = List.empty<Text>();
        var k = 0;
        while (k < at) { List.add(before, ls[k]); k += 1 };

        let after = List.empty<Text>();
        var m = stop;
        while (m < ls.size()) { List.add(after, ls[m]); m += 1 };

        // Trim the segment edges so re-joining with a blank line cannot stack up
        // extra newlines around the replaced section.
        let head = Text.trim(Text.join(List.values(before), "\n"), #char '\n');
        let tail = Text.trim(Text.join(List.values(after), "\n"), #char '\n');
        let section = wanted # (if (replacement == "") "" else "\n\n" # replacement);

        var out = joinBlock(head, section);
        out := joinBlock(out, tail);
        #ok(out);
    };

    // ---------------------------------------------------------------- apply

    /// Apply `ops` in order to a copy of `target`. Either every op succeeds and
    /// the new target is returned with a human-readable summary of each step, or
    /// the first failure is returned and nothing is changed.
    public func apply(
        target : Target,
        ops : [Op],
        maxBodyChars : Nat,
    ) : PatchResult {
        if (ops.size() == 0) return #err(#no_ops);

        var title = target.title;
        var subtitle = target.subtitle;
        var tagIds = target.tagIds;
        var body = target.body;
        let applied = List.empty<Text>();

        for (op in ops.vals()) {
            switch (op) {
                case (#replace({ find; replaceWith; occurrence })) {
                    switch (resolveMatch(body, find, occurrence)) {
                        case (#err(error)) return #err(error);
                        case (#ok({ index; length })) {
                            body := spliceAt(Text.toArray(body), index, length, replaceWith);
                            List.add(
                                applied,
                                "replaced " # debug_show (Markup.excerpt(find, 40)),
                            );
                        };
                    };
                };
                case (#insert_after({ find; text })) {
                    switch (resolveMatch(body, find, null)) {
                        case (#err(error)) return #err(error);
                        case (#ok({ index; length })) {
                            let at = index + length;
                            body := spliceAt(Text.toArray(body), at, 0, "\n\n" # text);
                            List.add(
                                applied,
                                "inserted a block after " # debug_show (Markup.excerpt(find, 40)),
                            );
                        };
                    };
                };
                case (#insert_before({ find; text })) {
                    switch (resolveMatch(body, find, null)) {
                        case (#err(error)) return #err(error);
                        case (#ok({ index })) {
                            body := spliceAt(Text.toArray(body), index, 0, text # "\n\n");
                            List.add(
                                applied,
                                "inserted a block before " # debug_show (Markup.excerpt(find, 40)),
                            );
                        };
                    };
                };
                case (#append({ text })) {
                    body := joinBlock(body, text);
                    List.add(applied, "appended a block");
                };
                case (#prepend({ text })) {
                    body := joinBlock(text, body);
                    List.add(applied, "prepended a block");
                };
                case (#replace_section({ heading; body = sectionBody })) {
                    switch (replaceSection(body, heading, sectionBody)) {
                        case (#err(error)) return #err(error);
                        case (#ok(updated)) {
                            body := updated;
                            List.add(
                                applied,
                                "replaced section " # debug_show (Markup.excerpt(heading, 40)),
                            );
                        };
                    };
                };
                case (#set_title(value)) {
                    title := value;
                    List.add(applied, "set the title");
                };
                case (#set_subtitle(value)) {
                    subtitle := value;
                    List.add(applied, "set the subtitle");
                };
                case (#set_tags(value)) {
                    tagIds := value;
                    List.add(applied, "set " # debug_show (value.size()) # " tag(s)");
                };
            };
        };

        if (body.size() > maxBodyChars) {
            return #err(#too_large({ size = body.size(); limit = maxBodyChars }));
        };

        #ok({
            target = { title; subtitle; tagIds; body };
            applied = List.toArray(applied);
        });
    };
};
