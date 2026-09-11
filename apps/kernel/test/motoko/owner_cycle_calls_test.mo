import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Error "mo:core/Error";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import UsageService "../../backend/app_usage/Service";
import UsageTypes "../../backend/app_usage/Types";
import BackendMemory "../../backend/backend_calls/Memory";
import BackendService "../../backend/backend_calls/Service";
import BackendTypes "../../backend/backend_calls/Types";
import CapabilityTypes "../../backend/capabilities/Types";
import OwnerMemory "../../backend/memory/kernel_cycle_calls/v1";
import OwnerService "../../backend/owner_cycle_calls/Service";
import OwnerTypes "../../backend/owner_cycle_calls/Types";

let T : Nat = 1_000_000_000_000;
let app : CapabilityTypes.AppScope = { app_id = "wallet"; installation_uid = 7 };
let reinstall : CapabilityTypes.AppScope = { app_id = "wallet"; installation_uid = 8 };
let anotherApp : CapabilityTypes.AppScope = { app_id = "other"; installation_uid = 9 };
let target = Principal.fromText("um5iw-rqaaa-aaaaq-qaaba-cai");
let otherTarget = Principal.fromText("rkp4c-7iaaa-aaaaa-aaaca-cai");
let selfPrincipal = Principal.fromText("r7inp-6aaaa-aaaaa-aaabq-cai");
let owner = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");

var appActive = true;
var capabilityEnabled = true;
var leaseActive = true;
var ownerActive = true;
var balance : Nat = 55 * T;
var callCost : Nat = 2;
var dispatches = 0;
var charged : Nat = 0;
var transportRejects = false;
var transportThrows = false;
var lastCall : ?BackendTypes.CallRequest = null;
var now : Nat64 = 100;
var onDispatch : () -> async () = func() : async () {};

func scopeActive(scope : CapabilityTypes.AppScope) : Bool {
    appActive and scope == app;
};
let usageMem = UsageService.init();
let usage = UsageService.Service(usageMem, scopeActive, func() { now }, func() { 0 });
let accounting : UsageTypes.OutgoingCycleAccounting = {
    reserve = usage.reserveOutgoingCycles;
    commit = usage.commitOutgoingDispatch;
    cancel = usage.cancelOutgoingReservation;
    finalize = usage.finalizeOutgoingCycles;
};
let registry : CapabilityTypes.RuntimeRegistry = {
    allowed = func(scope, kind, resource) {
        scopeActive(scope) and capabilityEnabled and kind == #backend_calls and resource == "default";
    };
    lease = func(scope, kind, resource) {
        if (not scopeActive(scope) or not capabilityEnabled or kind != #backend_calls or resource != "default") return null;
        ?{ active = func() { leaseActive } };
    };
    record = func(_scope, _kind, _resource, _operation, _outcome) { true };
};
let transport : BackendTypes.Transport = {
    cycle_balance = func() { balance };
    call_cost = func(_method, _argumentBytes) { callCost };
    call = func(call : BackendTypes.CallRequest) : async BackendTypes.TransportResult {
        dispatches += 1;
        lastCall := ?call;
        await onDispatch();
        if (transportThrows) throw Error.reject("reply interrupted");
        if (transportRejects) return #err({ message = "destination rejected"; charged_cycles = charged });
        #ok({ reply = call.args; charged_cycles = charged });
    };
};
let reservations : BackendTypes.Memory = {
    var next_id = 1;
    reservations = Map.empty<Nat, BackendTypes.Reservation>();
};
let declaration : BackendTypes.AppCapabilitiesDeclaration = {
    app_scope = app;
    backend_calls = ?{
        reservation_scopes = ["principal"];
        max_concurrency = 1;
        max_cycles_per_call = 10;
        max_cycles_per_day = 12;
        install_reservations = [#principal(target)];
    };
};
let broker = BackendService.Service(reservations, scopeActive, registry, transport, accounting);
broker.configure([declaration], selfPrincipal);
let actorSelf : actor {} = actor (Principal.toText(selfPrincipal));
let ordinary = broker.capability(app, actorSelf);
let ownerMem = OwnerMemory.init();
assert (ownerMem.next_sequence == 1);
assert (Map.size(ownerMem.by_scope) == 0);

func request(id : Blob, amount : Nat, partial : Bool) : OwnerTypes.Request {
    let bytes = Blob.toArray(id);
    {
        id = Blob.fromArray(Array.tabulate<Nat8>(16, func(index) { if (index < bytes.size()) bytes[index] else 0 }));
        app_scope = app;
        call = { canister = target; method = "deposit"; args = "frozen recipient"; cycles = amount };
        allow_partial = partial;
    };
};
func requireReceipt(result : OwnerTypes.Result) : OwnerTypes.Receipt {
    switch (result) {
        case (#ok(receipt)) receipt;
        case (#err(error)) Runtime.trap("Expected owner receipt: " # error.code # ": " # error.message);
    };
};
func expectError(result : OwnerTypes.Result, code : Text) : () {
    switch (result) {
        case (#err(error)) assert (error.code == code);
        case (#ok(_)) Runtime.trap("Expected owner error: " # code);
    };
};
func expectReply(receipt : OwnerTypes.Receipt, expected : Blob) : () {
    switch (receipt.result) {
        case (?#ok(reply)) assert (reply == expected);
        case (_) Runtime.trap("Expected retained transport reply");
    };
};

func requireFailure(result : OwnerTypes.Result) : Text {
    switch (result) {
        case (#err(error)) error.code;
        case (#ok(receipt)) {
            assert (not receipt.dispatched);
            switch (receipt.result) {
                case (?#err(error)) error.code;
                case (_) Runtime.trap("Expected a refusal before dispatch");
            };
        };
    };
};
func ownerService() : OwnerService.Service {
    OwnerService.Service(ownerMem, broker, scopeActive, func(caller) { ownerActive and caller == owner }, selfPrincipal, func() { now });
};
let service = ownerService();
let exact = request("exact", 50 * T, false);

// A quote is a read. The owner sees the exact attachment and the call cost;
// a caller asking for 50T from 55T cannot silently eat into the retained 5T.
switch (service.quote(exact)) {
    case (#ok(quote)) {
        assert (quote.balance == 55 * T);
        assert (quote.min_remaining_cycles == 5 * T);
        assert (quote.max_cycles == 50 * T - callCost);
        assert (quote.actual_cycles == 50 * T);
        assert (quote.max_cycles_per_call == 10);
        assert (quote.max_cycles_per_day == 12);
    };
    case (#err(_)) Runtime.trap("Expected an owner quote");
};
assert (ownerMem.next_sequence == 1 and dispatches == 0);
assert (requireFailure(await* service.execute(exact, owner)) == "low_cycles");
assert (dispatches == 0);

// Exhausted or near-empty canisters must yield zero available cycles rather
// than trapping in a Nat subtraction or attempting to spend their reserve.
balance := 5 * T - 1;
switch (service.quote(request("empty_quote", 1, true))) {
    case (#ok(quote)) assert (quote.max_cycles == 0 and quote.actual_cycles == 0);
    case (#err(_)) Runtime.trap("Low-balance quote should expose zero capacity");
};
ignore requireFailure(await* service.execute(request("empty", 1, true), owner));
assert (dispatches == 0);
balance := 55 * T;

// App roots do not get the owner's exceptional authorization. No durable
// dispatched command or transport effect may be created by another caller.
ignore requireFailure(await* service.execute(request("not_owner", T, false), otherTarget));
assert (service.status({ app_scope = app; id = "not_owner" }) == null);
assert (dispatches == 0);
let selfAuthorized = OwnerService.Service(ownerMem, broker, scopeActive, func(caller) { caller == owner or caller == selfPrincipal }, selfPrincipal, func() { now });
assert (requireFailure(await* selfAuthorized.execute(request("kernel_self", T, false), selfPrincipal)) == "unauthorized");
assert (dispatches == 0);

// Ordinary invocation still enforces the app's original per-call ceiling.
switch (await* ordinary.call({ exact.call with cycles = 11 })) {
    case (#err(error)) assert (error.code == "cycles_per_call_limit");
    case (#ok(_)) Runtime.trap("Owner feature changed ordinary per-call limits");
};
assert (dispatches == 0);

// The approval explicitly permits a smaller attachment if the live balance
// changed after review. Frozen recipient/arguments are never changed.
let partial = request("partial", 50 * T, true);
charged := 40 * T;
let partialReceipt = requireReceipt(await* service.execute(partial, owner));
assert (partialReceipt.dispatched);
assert (partialReceipt.actual_cycles == 50 * T - callCost);
assert (partialReceipt.request == partial);
assert (partialReceipt.charged_cycles == ?(40 * T));
expectReply(partialReceipt, partial.call.args);
assert (lastCall == ?{ partial.call with cycles = 50 * T - callCost });
assert (dispatches == 1);
assert (usage.snapshot().apps[0].lifetime_outgoing_cycles == 40 * T + UsageService.INTERCANISTER_CALL_BASE_CYCLES);

// A successful request keeps one exact result through lost replies, Service
// reconstruction, and other root calls. There is no reusable cycle allowance.
now += 1;
let restored = ownerService();
let duplicate = requireReceipt(await* restored.execute(partial, owner));
assert (duplicate == partialReceipt);
assert (restored.status({ app_scope = app; id = partial.id }) == ?partialReceipt);
assert (restored.status({ app_scope = reinstall; id = partial.id }) == null);
assert (restored.status({ app_scope = anotherApp; id = partial.id }) == null);
assert (dispatches == 1);
ignore requireFailure(await* service.execute({ partial with call = { partial.call with args = "different recipient" } }, owner));
ignore requireFailure(await* service.execute({ partial with call = { partial.call with canister = otherTarget } }, owner));
ignore requireFailure(await* service.execute({ partial with call = { partial.call with method = "other_method" } }, owner));
ignore requireFailure(await* service.execute({ partial with call = { partial.call with cycles = T } }, owner));
ignore requireFailure(await* service.execute({ partial with allow_partial = false }, owner));
assert (dispatches == 1);

// Large owner spend and its refund are usage, but neither consumes nor opens
// ordinary daily budget. Two permitted calls spend precisely its original 12.
charged := 10;
switch (await* ordinary.call({ exact.call with cycles = 10 })) {
    case (#ok(_)) {};
    case (#err(error)) Runtime.trap("Owner spend incorrectly consumed daily budget: " # error.code);
};
charged := 2;
switch (await* ordinary.call({ exact.call with cycles = 2 })) {
    case (#ok(_)) {};
    case (#err(error)) Runtime.trap("Expected last ordinary budget: " # error.code);
};
let ordinaryCount = dispatches;
switch (await* ordinary.call({ exact.call with cycles = 1 })) {
    case (#err(error)) assert (error.code == "cycles_daily_limit");
    case (#ok(_)) Runtime.trap("Exceptional refund reopened ordinary daily allowance");
};
assert (dispatches == ordinaryCount);

// Reentry sees a durable pending record before the remote future can run.
// Reconstructing the journal at this boundary cannot dispatch a duplicate.
let pending = request("pending", T, false);
onDispatch := func() : async () {
    let ?saved = service.status({ app_scope = app; id = pending.id }) else Runtime.trap("Missing dispatch journal");
    assert (saved.dispatched and saved.result == null and saved.actual_cycles == T);
    let recovered = requireReceipt(await* ownerService().execute(pending, owner));
    assert (recovered == saved);
    ignore requireFailure(await* service.execute({ pending with call = { pending.call with args = "tampered" } }, owner));
    assert (requireFailure(await* service.execute(request("concurrent", T, false), owner)) == "concurrency_limit");
};
charged := T;
let beforePending = dispatches;
let pendingReceipt = requireReceipt(await* service.execute(pending, owner));
expectReply(pendingReceipt, pending.call.args);
assert (dispatches == beforePending + 1);
onDispatch := func() : async () {};

// Approval of Max is a cap, not permission to attach a stale full-balance
// quote. Dispatch rereads the available cycles and preserves the exact reserve.
let changing = request("changed_balance", 50 * T, true);
ignore service.quote(changing);
balance := 54 * T;
charged := 49 * T - callCost;
let adjusted = requireReceipt(await* service.execute(changing, owner));
assert (adjusted.actual_cycles == 49 * T - callCost);
assert (lastCall == ?{ changing.call with cycles = 49 * T - callCost });
balance := 55 * T;

// Owner approval does not revive a disabled capability or revoked reservation.
capabilityEnabled := false;
assert (requireFailure(await* service.execute(request("disabled", T, false), owner)) == "capability_disabled");
capabilityEnabled := true;
appActive := false;
assert (requireFailure(await* service.execute(request("inactive", T, false), owner)) == "capability_revoked");
appActive := true;
assert (BackendMemory.removeReservationScope(reservations, app, #principal(target)));
assert (requireFailure(await* service.execute(request("unreserved", T, false), owner)) == "not_reserved");
let ?_ = BackendMemory.put(reservations, app, #principal(target), owner, now) else Runtime.trap("Restore reservation");

// A callback must save the original transport result before scope/lease
// revocation is considered. Recovery cannot mistake delivered cycles for an
// unsigned refusal or perform another deposit.
let revoked = request("revoked_during_call", T, false);
onDispatch := func() : async () { leaseActive := false; appActive := false };
let beforeRevoked = dispatches;
ignore await* service.execute(revoked, owner);
appActive := true;
leaseActive := true;
let ?savedRevoked = service.status({ app_scope = app; id = revoked.id }) else Runtime.trap("Lost revoked callback result");
expectReply(savedRevoked, revoked.call.args);
let recoveredRevoked = requireReceipt(await* ownerService().execute(revoked, owner));
expectReply(recoveredRevoked, revoked.call.args);
assert (dispatches == beforeRevoked + 1);
onDispatch := func() : async () {};

let revokedOwner = request("owner_revoked", T, false);
onDispatch := func() : async () { ownerActive := false };
let beforeRevokedOwner = dispatches;
expectError(await* service.execute(revokedOwner, owner), "revoked_after_dispatch");
ownerActive := true;
let restoredOwnerReceipt = requireReceipt(await* ownerService().execute(revokedOwner, owner));
expectReply(restoredOwnerReceipt, revokedOwner.call.args);
assert (dispatches == beforeRevokedOwner + 1);
onDispatch := func() : async () {};

// Retained rejects and unexpected transport failures are terminal observations
// for this identity. They never turn into automatic redispatches.
transportRejects := true;
charged := 7;
let rejection = request("rejected", T, false);
let rejected = requireReceipt(await* service.execute(rejection, owner));
assert (rejected.dispatched and rejected.charged_cycles == ?7);
switch (rejected.result) { case (?#err(error)) assert (error.code == "call_rejected"); case (_) Runtime.trap("Expected retained reject") };
let beforeRejectedRetry = dispatches;
assert (requireReceipt(await* service.execute(rejection, owner)) == rejected);
assert (dispatches == beforeRejectedRetry);
transportRejects := false;
transportThrows := true;
let interrupted = request("interrupted", T, false);
let unknown = requireReceipt(await* service.execute(interrupted, owner));
assert (unknown.dispatched and unknown.charged_cycles == ?T);
switch (unknown.result) { case (?#err(_)) {}; case (_) Runtime.trap("Expected retained transport failure") };
let beforeUnknownRetry = dispatches;
ignore requireReceipt(await* ownerService().execute(interrupted, owner));
assert (dispatches == beforeUnknownRetry);
transportThrows := false;

// Recovery listing is scoped and paginated; byte-heavy args/replies stay in
// the exact status read rather than every list entry.
let firstPage = service.list({ app_scope = app; before = null; limit = 2 });
assert (firstPage.calls.size() == 2);
let ?cursor = firstPage.next_before else Runtime.trap("Expected another page");
let secondPage = service.list({ app_scope = app; before = ?cursor; limit = 2 });
assert (secondPage.calls.size() == 2);
assert (firstPage.calls[1].sequence > secondPage.calls[0].sequence);
assert (service.list({ app_scope = reinstall; before = null; limit = 2 }).calls.size() == 0);
