import Blob "mo:core/Blob";
import Principal "mo:core/Principal";
import V1 "../backend/memory/rendezvous/v1";
import Migration "../backend/memory/rendezvous/v1_to_v2";

let peer = Principal.fromBlob(Blob.fromArray([0, 1, 2]));
let id = Blob.fromArray([1, 2, 3]);
let capability = Blob.fromArray([4, 5, 6]);
let old = V1.init();
old.revision := 7;
old.negotiations := [{
    id;
    capability;
    revision = 3;
    direction = #outbound;
    peer = ?peer;
    state = #confirmed;
    title = "Preserved meeting";
    duration_minutes = 30;
    candidate_starts_ns = [100, 200];
    selected_start_ns = ?200;
    expires_at_ns = 300;
    outbound_bytes = null;
    attempts = 1;
    delivery = #delivered;
}];
old.receipts := [{
    peer;
    negotiation_id = id;
    command_id = Blob.fromArray([7, 8, 9]);
    reply = #ok({ revision = 3; state = #confirmed; candidate_starts_ns = [100, 200] });
}];

let migrated = Migration.migrate(old);
assert (migrated.revision == 7);
assert (migrated.negotiations.size() == 1);
assert (migrated.negotiations[0].title == "Preserved meeting");
assert (migrated.negotiations[0].selected_start_ns == ?200);
assert (migrated.receipts.size() == 1);
assert (migrated.signal_sequence == 0);
assert (migrated.signals.size() == 0);
assert (migrated.signal_receipts.size() == 0);
