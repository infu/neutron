import Blob "mo:core/Blob";
import Runtime "mo:core/Runtime";
import Rendezvous "../backend/main";

let id = Blob.fromArray([1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1]);
let first = Rendezvous.commandIdFor(id, 1, "offer");
let retry = Rendezvous.commandIdFor(id, 1, "offer");
assert (first == retry);
assert (first != Rendezvous.commandIdFor(id, 2, "offer"));
assert (first != Rendezvous.commandIdFor(id, 1, "accept"));

let #uncertain(timeoutMessage) = Rendezvous.failedDelivery("timeout", "outcome unknown") else Runtime.trap("timeout must be uncertain");
assert (timeoutMessage == "outcome unknown");
let #retryable(offlineMessage) = Rendezvous.failedDelivery("offline", "peer unavailable") else Runtime.trap("definite transport failure must be retryable");
assert (offlineMessage == "peer unavailable");
