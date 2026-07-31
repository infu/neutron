import Principal "mo:core/Principal";

import Visibility "../../backend/feed/Visibility";

let sender = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
let author = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
let other = Principal.fromText("r7inp-6aaaa-aaaaa-aaabq-cai");

func nobodyBlocked(_ : Principal) : Bool {
    false;
};

func senderBlocked(node : Principal) : Bool {
    Principal.equal(node, sender);
};

func authorBlocked(node : Principal) : Bool {
    Principal.equal(node, author);
};

assert (Visibility.allows(sender, null, false, nobodyBlocked));
assert (Visibility.allows(sender, ?author, false, nobodyBlocked));
assert (not Visibility.allows(sender, null, false, senderBlocked));
assert (not Visibility.allows(sender, ?author, false, senderBlocked));

// A caller decides whether a local claimed author is safe to consult. Feed
// rendering supplies it conservatively; promotion supplies the verified one.
assert (Visibility.allows(sender, null, false, authorBlocked));
assert (not Visibility.allows(sender, ?author, false, authorBlocked));
assert (Visibility.allows(sender, ?other, false, authorBlocked));

// Verified tombstones remain processable even when their author is blocked.
assert (Visibility.allows(sender, ?author, true, senderBlocked));
assert (Visibility.allows(sender, ?author, true, authorBlocked));
