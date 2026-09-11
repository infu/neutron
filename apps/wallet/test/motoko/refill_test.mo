import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Journal "../../backend/refill/Journal";
import Memory "../../backend/memory/wallet_refills/v1";
import Types "../../backend/refill/Types";

let owner = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
let recipient = Principal.fromText("mxzaz-hqaaa-aaaar-qaada-cai");
let id = Blob.fromArray(Array.repeat<Nat8>(0x11, 16));
let request : Types.Request = {
    id; kind = #icp_topup; target = recipient; amount = 100_000_000;
    icp_fee = 10_000; cycles_fee = 100_000_000; estimated_cycles = 3_000_000_000_000;
};
func result(value : Types.Result) : Types.View {
    switch (value) { case (#ok(view)) view; case (#err(error)) Runtime.trap(error) };
};
func rejected(value : Types.Result) {
    switch (value) { case (#err(_)) {}; case (#ok(_)) assert false };
};

// The original request identity binds its recipient, amount and reviewed fees.
// Identical recovery reads do not create another command or timestamp.
let mem = Memory.init();
assert Map.size(mem.commands) == 0 and mem.last_timestamp == 0;
let prepared = result(Journal.prepare(mem, owner, request, 100));
assert prepared.phase == #prepared and not prepared.can_continue;
assert result(Journal.prepare(mem, owner, request, 200)) == prepared;
rejected(Journal.prepare(mem, recipient, request, 300));
rejected(Journal.prepare(mem, owner, { request with target = owner }, 300));
rejected(Journal.prepare(mem, owner, { request with amount = request.amount + 1 }, 300));
rejected(Journal.prepare(mem, owner, { request with icp_fee = request.icp_fee + 1 }, 300));
rejected(Journal.prepare(mem, owner, { request with kind = #icp_to_tcycles }, 300));
assert Map.size(mem.commands) == 1 and mem.last_timestamp == 0;

// Invalid new intents never become durable requests, including destinations
// that cannot represent either a recipient account or a top-up canister.
func invalid(changed : Types.Request) {
    let fresh = Memory.init();
    rejected(Journal.prepare(fresh, owner, changed, 100));
    assert Map.size(fresh.commands) == 0 and fresh.last_timestamp == 0;
};
invalid({ request with id = "short" });
invalid({ request with amount = 0 });
invalid({ request with target = Principal.fromText("2vxsx-fae") });
invalid({ request with target = Principal.fromText("aaaaa-aa") });
let accountRecipient = Principal.fromBlob(Blob.fromArray(Array.tabulate<Nat8>(29, func(index) { if (index == 28) 2 else 17 })));
invalid({ request with target = accountRecipient });
invalid({ request with kind = #tcycles_topup; target = accountRecipient });
assert result(Journal.prepare(Memory.init(), owner, { request with kind = #icp_to_tcycles; target = accountRecipient }, 100)).phase == #prepared;
invalid({ request with kind = #tcycles_topup; cycles_fee = 1 });
invalid({ request with kind = #icp_to_tcycles; cycles_fee = 1 });
assert result(Journal.prepare(Memory.init(), owner, { request with cycles_fee = 0 }, 100)).phase == #prepared;
invalid({ request with amount = 18_446_744_073_709_551_616 });
invalid({ request with kind = #icp_to_tcycles; target = owner; estimated_cycles = 100_000_000 });
invalid({ request with kind = #icp_to_tcycles; estimated_cycles = 200_000_000 });
assert result(Journal.prepare(Memory.init(), owner, { request with kind = #icp_to_tcycles; target = owner; estimated_cycles = 100_000_001 }, 100)).phase == #prepared;
assert result(Journal.prepare(Memory.init(), owner, { request with kind = #icp_to_tcycles; estimated_cycles = 200_000_001 }, 100)).phase == #prepared;

// Independent same-size CMC payments have distinct deduplication timestamps,
// even when the Neutron resumes from the same root in the same IC time round.
let firstTimestamp = Journal.nextTimestamp(mem, 1_000);
let restored : Memory.Mem = mem;
let secondTimestamp = Journal.nextTimestamp(restored, 1_000);
assert firstTimestamp == 1_000 and secondTimestamp == 1_001;
assert mem.last_timestamp == 1_001;
assert Journal.nextTimestamp(restored, 999) == 1_002;
let ?command = Map.get(restored.commands, Blob.compare, id) else Runtime.trap("Saved refill missing");
command.phase := #notify_pending;
command.source_block := ?31;
command.source_args := ?"retained-candid-bytes";
command.source_timestamp := ?firstTimestamp;
command.error := ?"CMC is still processing the original payment";
let pending = result(Journal.prepare(restored, owner, request, 3_000));
assert pending.phase == #notify_pending and pending.can_continue;
assert pending.source_block == ?31 and command.source_args == ?"retained-candid-bytes";
command.phase := #complete;
command.credited_cycles := ?2_900_000_000_000;
let completed = result(Journal.prepare(restored, owner, request, 4_000));
assert completed.phase == #complete and not completed.can_continue;
assert completed.credited_cycles == ?2_900_000_000_000;
assert result(Journal.prepare(mem, owner, request, 5_000)) == completed;
for (phase in [#complete, #refunded, #stopped].vals()) assert Journal.terminal(phase);
for (phase in [#prepared, #transfer_pending, #notify_pending, #withdraw_pending, #forward_pending].vals()) assert not Journal.terminal(phase);

// CMC's documented principal subaccount starts with its byte length, followed
// by principal bytes and zero padding. A different recipient changes it.
let subaccount = Blob.toArray(Journal.principalSubaccount(Principal.fromBlob("\01\02\03")));
assert subaccount.size() == 32;
assert subaccount[0] == 3 and subaccount[1] == 1 and subaccount[2] == 2 and subaccount[3] == 3;
for (index in [4, 15, 31].vals()) assert subaccount[index] == 0;
assert Journal.principalSubaccount(owner) != Journal.principalSubaccount(recipient);
