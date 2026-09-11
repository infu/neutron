import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Int "mo:core/Int";
import Map "mo:core/Map";
import Nat64 "mo:core/Nat64";
import Nat8 "mo:core/Nat8";
import Principal "mo:core/Principal";
import Memory "../memory/wallet_refills/v1";
import Types "Types";
module {
    public func icp() : Principal { Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai") };
    public func cmc() : Principal { Principal.fromText("rkp4c-7iaaa-aaaaa-aaaca-cai") };
    public func cycles() : Principal { Principal.fromText("um5iw-rqaaa-aaaaq-qaaba-cai") };
    public let CYCLES_FEE : Nat = 100_000_000;
    public let TOP_UP_MEMO : Blob = "\54\50\55\50\00\00\00\00";
    public let MINT_MEMO : Blob = "\4d\49\4e\54\00\00\00\00";
    public let DEDUP_WINDOW_NS : Nat64 = 86_400_000_000_000;

    public func principalSubaccount(target : Principal) : Blob {
        let bytes = Blob.toArray(Principal.toBlob(target));
        Blob.fromArray(Array.tabulate<Nat8>(32, func(index) {
            if (index == 0) Nat8.fromNat(bytes.size())
            else if (index <= bytes.size()) bytes[index - 1]
            else 0;
        }));
    };
    public func nextTimestamp(mem : Memory.Mem, now : Int) : Nat64 {
        let current = Nat64.fromNat(Int.abs(now));
        let next = if (current > mem.last_timestamp) current else mem.last_timestamp + 1;
        mem.last_timestamp := next;
        next;
    };
    public func terminal(phase : Memory.Phase) : Bool {
        switch (phase) { case (#complete or #refunded or #stopped) true; case (_) false };
    };
    public func canContinue(command : Memory.Command, now : Int) : Bool {
        if (command.phase == #prepared or terminal(command.phase)) return false;
        if (command.phase == #notify_pending) return true;
        // A duplicate withdraw only exposes the burn identity; repeating it
        // cannot recover the management-call outcome. Keep its evidence visible.
        if (command.phase == #withdraw_pending and command.duplicate) return false;
        let timestamp = if (command.phase == #forward_pending) command.forward_timestamp else command.source_timestamp;
        switch (timestamp) {
            case null true;
            case (?at) Int.abs(now) < Nat64.toNat(at) + Nat64.toNat(DEDUP_WINDOW_NS);
        };
    };
    public func view(command : Memory.Command, now : Int) : Types.View {
        let request = command.request;
        {
            id = request.id; kind = request.kind; target = request.target; amount = request.amount;
            icp_fee = request.icp_fee; cycles_fee = request.cycles_fee;
            estimated_cycles = request.estimated_cycles;
            created_at = command.created_at; updated_at = command.updated_at;
            phase = command.phase; source_block = command.source_block;
            mint_block = command.mint_block; minted_cycles = command.minted_cycles;
            credited_cycles = command.credited_cycles; forward_block = command.forward_block;
            refund_block = command.refund_block; duplicate = command.duplicate;
            error = command.error; can_continue = canContinue(command, now);
        };
    };
    public func prepare(mem : Memory.Mem, owner : Principal, request : Types.Request, now : Int) : Types.Result {
        if (request.id.size() != 16) return #err("Refill request ID must contain 16 bytes");
        switch (Map.get(mem.commands, Blob.compare, request.id)) {
            case (?command) {
                if (command.request != request or command.owner != owner) return #err("This refill ID belongs to a different saved request");
                return #ok(view(command, now));
            };
            case null {};
        };
        if (request.amount == 0) return #err("Enter an amount greater than zero");
        if (Principal.isAnonymous(request.target)) return #err("Choose a valid recipient principal");
        if (request.target == Principal.fromText("aaaaa-aa")) return #err("Choose a canister or account, not the management canister");
        let targetBytes = Blob.toArray(Principal.toBlob(request.target));
        if (request.kind != #icp_to_tcycles and targetBytes.size() > 0 and targetBytes[targetBytes.size() - 1] == 2) {
            return #err("A refill needs a canister ID. This principal identifies a user account instead.");
        };
        // withdraw has a fixed ledger fee and no caller-supplied fee argument.
        if (request.kind != #icp_topup and request.cycles_fee != CYCLES_FEE) return #err("The reviewed TCYCLES fee does not match the cycles ledger fee");
        if (request.kind != #tcycles_topup and request.amount > 18_446_744_073_709_551_615) return #err("ICP amount exceeds the ledger's token range");
        if (request.kind == #icp_to_tcycles) {
            let fees = request.cycles_fee * (if (request.target == owner) 1 else 2);
            if (request.estimated_cycles <= fees) return #err("Choose enough ICP to cover the TCYCLES mint and recipient transfer fees");
        };
        let command : Memory.Command = {
            request; owner; created_at = now; var updated_at = now; var phase = #prepared;
            var source_args = null; var source_timestamp = null; var source_uncertain = false;
            var source_block = null; var mint_block = null; var minted_cycles = null;
            var credited_cycles = null; var forward_args = null; var forward_timestamp = null;
            var forward_uncertain = false; var forward_block = null; var refund_block = null;
            var duplicate = false; var error = null;
        };
        Map.add(mem.commands, Blob.compare, request.id, command);
        #ok(view(command, now));
    };
};
