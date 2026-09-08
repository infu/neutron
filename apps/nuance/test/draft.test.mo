// Patch engine tests.
//
// This is the module an agent drives while a human is typing, so the failure
// modes matter more than the happy path: a silent half-match or a partially
// applied op list would corrupt the human's writing. Every rejection path below
// is asserted deliberately.

import Debug "mo:core/Debug";
import Runtime "mo:core/Runtime";
import Draft "../backend/nuance/Draft";

let LIMIT : Nat = 300_000;

func target(body : Text) : Draft.Target {
    { title = "T"; subtitle = "S"; tagIds = ["1"]; body };
};

func expectOk(name : Text, result : Draft.PatchResult) : Draft.Target {
    switch (result) {
        case (#ok({ target = updated })) updated;
        case (#err(error)) {
            Runtime.trap("draft test " # name # " unexpectedly failed: " # Draft.errorText(error));
        };
    };
};

func checkBody(name : Text, result : Draft.PatchResult, expected : Text) {
    let updated = expectOk(name, result);
    if (updated.body != expected) {
        Debug.print("FAIL " # name);
        Debug.print("  expected: " # debug_show (expected));
        Debug.print("  actual:   " # debug_show (updated.body));
        Runtime.trap("draft test failed: " # name);
    };
};

func expectErr(name : Text, result : Draft.PatchResult) : Draft.PatchError {
    switch (result) {
        case (#ok({ target = updated })) {
            Runtime.trap(
                "draft test " # name # " should have failed but produced: " #
                debug_show (updated.body)
            );
        };
        case (#err(error)) error;
    };
};

// ------------------------------------------------------------------ replace

checkBody(
    "replace unique match",
    Draft.apply(target("Alpha beta gamma"), [#replace({ find = "beta"; replaceWith = "BETA"; occurrence = null })], LIMIT),
    "Alpha BETA gamma",
);

switch (
    expectErr(
        "replace missing",
        Draft.apply(target("Alpha"), [#replace({ find = "zeta"; replaceWith = "x"; occurrence = null })], LIMIT),
    )
) {
    case (#not_found({ find })) { if (find != "zeta") Runtime.trap("wrong find echoed") };
    case (other) Runtime.trap("expected #not_found, got " # debug_show (other));
};

// The central safety property: a non-unique anchor is refused, not guessed.
switch (
    expectErr(
        "replace ambiguous",
        Draft.apply(target("one two one"), [#replace({ find = "one"; replaceWith = "X"; occurrence = null })], LIMIT),
    )
) {
    case (#ambiguous({ count })) { if (count != 2) Runtime.trap("expected 2 matches, got " # debug_show (count)) };
    case (other) Runtime.trap("expected #ambiguous, got " # debug_show (other));
};

checkBody(
    "replace nth occurrence",
    Draft.apply(target("a a a"), [#replace({ find = "a"; replaceWith = "X"; occurrence = ?2 })], LIMIT),
    "a X a",
);

switch (
    expectErr(
        "occurrence past the end",
        Draft.apply(target("a a"), [#replace({ find = "a"; replaceWith = "X"; occurrence = ?5 })], LIMIT),
    )
) {
    case (#not_found(_)) {};
    case (other) Runtime.trap("expected #not_found, got " # debug_show (other));
};

switch (
    expectErr(
        "empty find",
        Draft.apply(target("body"), [#replace({ find = ""; replaceWith = "X"; occurrence = null })], LIMIT),
    )
) {
    case (#empty_find) {};
    case (other) Runtime.trap("expected #empty_find, got " # debug_show (other));
};

checkBody(
    "replace spanning multiple words",
    Draft.apply(
        target("The quick brown fox"),
        [#replace({ find = "quick brown"; replaceWith = "slow grey"; occurrence = null })],
        LIMIT,
    ),
    "The slow grey fox",
);

checkBody(
    "replace with empty string deletes",
    Draft.apply(target("keep this drop"), [#replace({ find = " drop"; replaceWith = ""; occurrence = null })], LIMIT),
    "keep this",
);

// ------------------------------------------------------------------ inserts

checkBody(
    "insert after adds a block break",
    Draft.apply(target("First block."), [#insert_after({ find = "First block."; text = "Second." })], LIMIT),
    "First block.\n\nSecond.",
);

checkBody(
    "insert before adds a block break",
    Draft.apply(target("Last."), [#insert_before({ find = "Last."; text = "First." })], LIMIT),
    "First.\n\nLast.",
);

switch (
    expectErr(
        "insert after an ambiguous anchor",
        Draft.apply(target("x y x"), [#insert_after({ find = "x"; text = "new" })], LIMIT),
    )
) {
    case (#ambiguous(_)) {};
    case (other) Runtime.trap("expected #ambiguous, got " # debug_show (other));
};

checkBody("append", Draft.apply(target("A"), [#append({ text = "B" })], LIMIT), "A\n\nB");
checkBody("append to empty body", Draft.apply(target(""), [#append({ text = "B" })], LIMIT), "B");
checkBody("prepend", Draft.apply(target("A"), [#prepend({ text = "B" })], LIMIT), "B\n\nA");
checkBody("prepend to empty body", Draft.apply(target(""), [#prepend({ text = "B" })], LIMIT), "B");

// ----------------------------------------------------------------- sections

let article = "# Title\n\nIntro.\n\n## One\n\nOld one.\n\n## Two\n\nOld two.";

checkBody(
    "replace a middle section keeps its heading and neighbours",
    Draft.apply(target(article), [#replace_section({ heading = "## One"; body = "New one." })], LIMIT),
    "# Title\n\nIntro.\n\n## One\n\nNew one.\n\n## Two\n\nOld two.",
);

checkBody(
    "replace the last section",
    Draft.apply(target(article), [#replace_section({ heading = "## Two"; body = "New two." })], LIMIT),
    "# Title\n\nIntro.\n\n## One\n\nOld one.\n\n## Two\n\nNew two.",
);

checkBody(
    "empty section body leaves a bare heading",
    Draft.apply(target(article), [#replace_section({ heading = "## Two"; body = "" })], LIMIT),
    "# Title\n\nIntro.\n\n## One\n\nOld one.\n\n## Two",
);

switch (
    expectErr(
        "unknown section",
        Draft.apply(target(article), [#replace_section({ heading = "## Missing"; body = "x" })], LIMIT),
    )
) {
    case (#section_not_found(_)) {};
    case (other) Runtime.trap("expected #section_not_found, got " # debug_show (other));
};

switch (
    expectErr(
        "duplicate section headings",
        Draft.apply(
            target("## Dup\n\na\n\n## Dup\n\nb"),
            [#replace_section({ heading = "## Dup"; body = "x" })],
            LIMIT,
        ),
    )
) {
    case (#ambiguous(_)) {};
    case (other) Runtime.trap("expected #ambiguous, got " # debug_show (other));
};

// -------------------------------------------------------------- metadata

let meta = expectOk(
    "metadata ops",
    Draft.apply(
        target("body"),
        [#set_title("New title"), #set_subtitle("New subtitle"), #set_tags(["7", "8"])],
        LIMIT,
    ),
);
if (meta.title != "New title") Runtime.trap("title not set");
if (meta.subtitle != "New subtitle") Runtime.trap("subtitle not set");
if (meta.tagIds.size() != 2 or meta.tagIds[0] != "7") Runtime.trap("tags not set");
if (meta.body != "body") Runtime.trap("metadata ops must not touch the body");

// -------------------------------------------------------------- multi-op

// Ops see the result of earlier ops in the same patch.
checkBody(
    "later ops observe earlier ops",
    Draft.apply(
        target("alpha"),
        [
            #replace({ find = "alpha"; replaceWith = "beta"; occurrence = null }),
            #replace({ find = "beta"; replaceWith = "gamma"; occurrence = null }),
        ],
        LIMIT,
    ),
    "gamma",
);

// Atomicity: the second op fails, so the first must not be observable. `apply`
// is pure, so this asserts that no partial target is returned at all.
switch (
    expectErr(
        "atomic rollback",
        Draft.apply(
            target("alpha"),
            [
                #replace({ find = "alpha"; replaceWith = "beta"; occurrence = null }),
                #replace({ find = "nothing"; replaceWith = "x"; occurrence = null }),
            ],
            LIMIT,
        ),
    )
) {
    case (#not_found({ find })) { if (find != "nothing") Runtime.trap("wrong failing op reported") };
    case (other) Runtime.trap("expected #not_found, got " # debug_show (other));
};

let summary = switch (
    Draft.apply(target("A"), [#append({ text = "B" }), #set_title("X")], LIMIT)
) {
    case (#ok({ applied })) applied;
    case (#err(_)) Runtime.trap("summary case failed");
};
if (summary.size() != 2) Runtime.trap("expected one summary line per op");

// ----------------------------------------------------------------- limits

switch (expectErr("no ops", Draft.apply(target("x"), [], LIMIT))) {
    case (#no_ops) {};
    case (other) Runtime.trap("expected #no_ops, got " # debug_show (other));
};

switch (
    expectErr(
        "body limit",
        Draft.apply(target("12345"), [#append({ text = "678901234567890" })], 10),
    )
) {
    case (#too_large({ limit })) { if (limit != 10) Runtime.trap("wrong limit echoed") };
    case (other) Runtime.trap("expected #too_large, got " # debug_show (other));
};

// Unicode: indices are character-based, so multi-byte text must splice cleanly.
checkBody(
    "unicode safe splice",
    Draft.apply(target("héllo wörld"), [#replace({ find = "wörld"; replaceWith = "värld"; occurrence = null })], LIMIT),
    "héllo värld",
);

Debug.print("draft: all assertions passed");
