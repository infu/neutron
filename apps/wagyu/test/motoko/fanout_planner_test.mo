import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";

import Fanout "../../backend/fanout/Planner";

let network = Blob.fromArray(Array.repeat<Nat8>(7, 32));
let peer = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
let exact = Blob.fromArray([1, 2, 3, 4]);

let ?operation = Fanout.operationId(
    network,
    4,
    "post:abc",
    peer,
    9,
) else Runtime.trap("fanout operation id was not derived");
assert (operation.size() == 16);
assert (
    Fanout.operationId(
        network,
        4,
        "post:abc",
        peer,
        9,
    ) == ?operation
);
assert (
    Fanout.operationId(
        network,
        4,
        "post:abc",
        peer,
        10,
    ) != ?operation
);
assert (Fanout.targetKey(4, 9) == "fanout-target:4:9");

switch (Fanout.event(#share, exact)) {
    case (#share(value)) assert (Blob.equal(value, exact));
    case (_) Runtime.trap("share fanout used the wrong event tag");
};
switch (Fanout.event(#tombstone_relay, exact)) {
    case (#tombstone(value)) assert (Blob.equal(value, exact));
    case (_) Runtime.trap("relay fanout used the wrong event tag");
};

let zero : Fanout.Counters = {
    completed = 0;
    terminal = 0;
    uncertain = 0;
};
let ?completed = Fanout.transition(zero, #sending, #accepted)
else Runtime.trap("accepted transition failed");
assert (completed.completed == 1);
let ?retrying = Fanout.transition(completed, #accepted, #queued)
else Runtime.trap("counter removal failed");
assert (retrying == zero);
let ?uncertain = Fanout.transition(zero, #sending, #uncertain)
else Runtime.trap("uncertain transition failed");
assert (uncertain.uncertain == 1);
assert (Fanout.jobState(false, 1, zero) == ?#scanning);
assert (Fanout.jobState(true, 1, zero) == ?#sending);
assert (Fanout.jobState(true, 0, zero) == ?#complete);
assert (Fanout.jobState(true, 1, completed) == ?#complete);
assert (Fanout.jobState(true, 1, uncertain) == ?#partial);
let terminal : Fanout.Counters = {
    completed = 0;
    terminal = 1;
    uncertain = 0;
};
assert (Fanout.jobState(true, 1, terminal) == ?#failed);
assert (Fanout.transition(zero, #failed, #queued) == null);
assert (Fanout.terminalWithoutTargets(#complete, true));
assert (Fanout.terminalWithoutTargets(#partial, true));
assert (Fanout.terminalWithoutTargets(#failed, true));
assert (not Fanout.terminalWithoutTargets(#sending, true));
assert (not Fanout.terminalWithoutTargets(#complete, false));
