import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Error "mo:core/Error";
import Int "mo:core/Int";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Order "mo:core/Order";
import Set "mo:core/Set";
import Time "mo:core/Time";
import Capabilities "../capabilities/Types";
import Icrc "../icrc1/Client";
import IcrcTypes "../icrc1/Types";
import Memory "../memory/wallet_refills/v1";
import Journal "Journal";
import Types "Types";
module {
    public class Service(mem : Memory.Mem, calls : Capabilities.BackendCalls) {
        let owner = calls.canister_principal;
        let active = Set.empty<Blob>();

        public func prepare(request : Types.Request) : Types.Result {
            Journal.prepare(mem, owner, request, Time.now());
        };
        public func status(id : Blob) : Types.Result {
            switch (Map.get(mem.commands, Blob.compare, id)) {
                case null #err("Wallet refill was not found");
                case (?command) #ok(Journal.view(command, Time.now()));
            };
        };
        public func page(request : Types.PageRequest) : Types.Page {
            if (request.limit == 0) Runtime.trap("Refill page limit must be greater than zero");
            let eligible = Array.filter<Memory.Command>(Array.fromIter(Map.values(mem.commands)), func(command) {
                if (request.pending_only and Journal.terminal(command.phase)) return false;
                switch (request.before) {
                    case null true;
                    case (?cursor) command.created_at < cursor.created_at or
                        (command.created_at == cursor.created_at and Blob.compare(command.request.id, cursor.id) == #greater);
                };
            });
            let ordered = Array.sort<Memory.Command>(eligible, func(left, right) : Order.Order {
                if (left.created_at > right.created_at) #less
                else if (left.created_at < right.created_at) #greater
                else Blob.compare(left.request.id, right.request.id);
            });
            let count = Nat.min(request.limit, ordered.size());
            let now = Time.now();
            let operations = Array.tabulate<Types.View>(count, func(index) { Journal.view(ordered[index], now) });
            let next_cursor = if (count < ordered.size()) {
                let last = ordered[count - 1];
                ?{ created_at = last.created_at; id = last.request.id };
            } else null;
            { operations; next_cursor };
        };
        public func execute(id : Blob) : async* Types.Result { await* run(id, true) };
        public func resume(id : Blob) : async* Types.Result { await* run(id, false) };

        func setError(command : Memory.Command, text : Text) {
            command.error := ?text;
            command.updated_at := Time.now();
        };
        func stop(command : Memory.Command, text : Text) {
            command.phase := #stopped;
            setError(command, text);
        };
        func run(id : Blob, approve : Bool) : async* Types.Result {
            let ?command = Map.get(mem.commands, Blob.compare, id) else return #err("Wallet refill was not found");
            if (command.owner != owner) return #err("This refill belongs to a different Neutron");
            if (Journal.terminal(command.phase)) return #ok(Journal.view(command, Time.now()));
            if (command.phase == #withdraw_pending and command.duplicate) return #ok(Journal.view(command, Time.now()));
            if (command.phase == #prepared and not approve) return #err("Review and approve this refill before executing it");
            if (Set.contains(active, Blob.compare, id)) return #ok(Journal.view(command, Time.now()));
            Set.add(active, Blob.compare, id);
            // Record acceptance before any outbound call; close/reload never
            // erases a transfer or turns it back into an unapproved intent.
            if (command.phase == #prepared) {
                command.phase := if (command.request.kind == #tcycles_topup) #withdraw_pending else #transfer_pending;
                command.updated_at := Time.now();
            };
            try {
                if (command.phase == #transfer_pending) await* transferIcp(command);
                if (command.phase == #notify_pending) await* notify(command);
                if (command.phase == #withdraw_pending) await* withdraw(command);
                if (command.phase == #forward_pending) await* forward(command);
            } catch (error) {
                // A call exception cannot prove non-execution. Frozen bytes
                // and the last committed stage survive for exact recovery.
                if (not Journal.terminal(command.phase)) {
                    if ((command.phase == #transfer_pending or command.phase == #withdraw_pending) and command.source_args != null) command.source_uncertain := true;
                    if (command.phase == #forward_pending and command.forward_args != null) command.forward_uncertain := true;
                    setError(command, "The refill reply was interrupted. Continue this saved refill: " # Error.message(error));
                };
            };
            Set.remove(active, Blob.compare, id);
            #ok(Journal.view(command, Time.now()));
        };

        func checkFee(command : Memory.Command, ledger : Principal, expected : Nat) : async* Bool {
            let observedPhase = command.phase;
            let sourceArgs = command.source_args;
            let forwardArgs = command.forward_args;
            let observed = await* calls.call(Icrc.feeRequest(ledger));
            // An older fee observation cannot stop work already dispatched or
            // advanced by a restored runtime while this read was suspended.
            if (command.phase != observedPhase or command.source_args != sourceArgs or command.forward_args != forwardArgs or Journal.terminal(command.phase)) return false;
            switch (Icrc.decodeFee(observed)) {
                case (#ok(fee)) {
                    if (fee == expected) return true;
                    if (command.phase == #forward_pending) { setError(command, "TCYCLES are already minted in your Neutron. The recipient transfer fee changed; keep this saved refill and do not convert the ICP again.") } else { stop(command, "The token fee changed before any new debit. Review a new refill with the current fee.") };
                    false;
                };
                case (#err(error)) { setError(command, "Could not check the token fee. No new debit was requested: " # error); false };
            };
        };
        func retryWithinWindow(command : Memory.Command, timestamp : ?Nat64) : Bool {
            switch (timestamp) {
                case (?value) {
                    let now = Nat64.fromNat(Int.abs(Time.now()));
                    if (now > value and now - value >= Journal.DEDUP_WINDOW_NS) {
                        setError(command, "The original ledger request is outside its retry window. Its outcome remains unverified; do not start a replacement to recover it.");
                        return false;
                    };
                };
                case null {};
            };
            true;
        };
        func transferIcp(command : Memory.Command) : async* () {
            let args = switch (command.source_args) {
                case (?saved) {
                    if (not retryWithinWindow(command, command.source_timestamp)) return;
                    saved;
                };
                case null {
                    if (not (await* checkFee(command, Journal.icp(), command.request.icp_fee))) return;
                    if (command.phase != #transfer_pending) return;
                    switch (command.source_args) {
                        case (?existing) existing;
                        case null {
                    let timestamp = Journal.nextTimestamp(mem, Time.now());
                    let mint = command.request.kind == #icp_to_tcycles;
                    let transfer : IcrcTypes.TransferArg = {
                        from_subaccount = null;
                        to = { owner = Journal.cmc(); subaccount = ?Journal.principalSubaccount(if (mint) owner else command.request.target) };
                        amount = command.request.amount; fee = ?command.request.icp_fee;
                        memo = ?(if (mint) Journal.MINT_MEMO else Journal.TOP_UP_MEMO);
                        created_at_time = ?timestamp;
                    };
                    let encoded = to_candid(transfer);
                    command.source_args := ?encoded;
                    command.source_timestamp := ?timestamp;
                    encoded;
                        };
                    };
                };
            };
            let result = await* calls.call(Icrc.transferCandidRequest(Journal.icp(), args));
            if (command.phase != #transfer_pending) return;
            switch (decodeTransfer(result)) {
                case (#ok(receipt)) {
                    command.source_block := ?receipt.block_index;
                    command.duplicate := receipt.duplicate;
                    command.phase := #notify_pending;
                    command.error := null;
                    command.updated_at := Time.now();
                };
                case (#unknown(message)) { command.source_uncertain := true; setError(command, message) };
                case (#retry(message)) setError(command, message);
                case (#rejected(message)) {
                    if (command.source_uncertain) setError(command, message # ". An earlier attempt has an unknown outcome; keep this original request.")
                    else stop(command, message);
                };
            };
        };
        func notify(command : Memory.Command) : async* () {
            let ?block = command.source_block else { setError(command, "The saved ICP transfer has no verified block yet"); return };
            if (block > 18_446_744_073_709_551_615) { stop(command, "The ICP block is outside the CMC block range"); return };
            let block_index = Nat64.fromNat(block);
            if (command.request.kind == #icp_topup) {
                let args : Types.NotifyTopUpArgs = { block_index; canister_id = command.request.target };
                let replyResult = await* calls.call({ canister = Journal.cmc(); method = "notify_top_up"; args = to_candid(args); cycles = 0 });
                if (command.phase != #notify_pending) return;
                switch (replyResult) {
                    case (#err(error)) setError(command, "ICP payment is saved; retry notification: " # error.message);
                    case (#ok(reply)) {
                        let decoded : ?Types.NotifyTopUpResult = from_candid(reply);
                        switch (decoded) {
                            case (?#Ok(cycles)) {
                                command.credited_cycles := ?cycles; command.phase := #complete; command.error := null;
                            };
                            case (?#Err(error)) notifyError(command, error);
                            case null setError(command, "The CMC notification returned an unexpected reply. The original ICP payment remains saved.");
                        };
                    };
                };
            } else {
                let args : Types.NotifyMintArgs = { block_index; to_subaccount = null; deposit_memo = ?command.request.id };
                let replyResult = await* calls.call({ canister = Journal.cmc(); method = "notify_mint_cycles"; args = to_candid(args); cycles = 0 });
                if (command.phase != #notify_pending) return;
                switch (replyResult) {
                    case (#err(error)) setError(command, "ICP payment is saved; retry mint notification: " # error.message);
                    case (#ok(reply)) {
                        let decoded : ?Types.NotifyMintResult = from_candid(reply);
                        switch (decoded) {
                            case (?#Ok(receipt)) {
                                command.mint_block := ?receipt.block_index;
                                command.minted_cycles := ?receipt.minted;
                                if (receipt.minted < command.request.cycles_fee) {
                                    stop(command, "The mint returned less than its ledger fee. Inspect the saved mint receipt before further action.");
                                } else {
                                    let credited = Nat.sub(receipt.minted, command.request.cycles_fee);
                                    command.credited_cycles := if (command.request.target == owner) ?credited else null;
                                    command.error := null;
                                    command.phase := if (command.request.target == owner) #complete else #forward_pending;
                                };
                            };
                            case (?#Err(error)) notifyError(command, error);
                            case null setError(command, "The CMC mint notification returned an unexpected reply. The original ICP payment remains saved.");
                        };
                    };
                };
            };
            command.updated_at := Time.now();
        };
        func notifyError(command : Memory.Command, error : Types.NotifyError) {
            switch (error) {
                case (#Refunded(refund)) {
                    command.phase := if (refund.block_index == null) #stopped else #refunded;
                    command.refund_block := switch (refund.block_index) { case (?index) ?Nat64.toNat(index); case null null };
                    setError(command, switch (refund.block_index) {
                        case (?_) "The CMC returned the ICP payment less its processing and transfer fees: " # refund.reason;
                        case null "The CMC stopped this conversion without a refund transfer. The payment may be below its refund fees: " # refund.reason;
                    });
                };
                case (#Processing) setError(command, "The CMC is processing the saved ICP payment. Continue this refill to check its result.");
                case (#TransactionTooOld(_)) stop(command, "The CMC no longer retains this payment notification. The original payment outcome must be checked; do not transfer the ICP again.");
                case (#InvalidTransaction(reason)) stop(command, "The CMC could not process the saved ICP payment: " # reason);
                case (#Other(error)) setError(command, "The CMC could not finish yet. Continue the same refill: " # error.error_message);
            };
        };
        func withdraw(command : Memory.Command) : async* () {
            let args = switch (command.source_args) {
                case (?saved) {
                    if (not retryWithinWindow(command, command.source_timestamp)) return;
                    saved;
                };
                case null {
                    if (not (await* checkFee(command, Journal.cycles(), command.request.cycles_fee))) return;
                    if (command.phase != #withdraw_pending) return;
                    switch (command.source_args) {
                        case (?existing) existing;
                        case null {
                    let timestamp = Journal.nextTimestamp(mem, Time.now());
                    let withdrawArgs : Types.WithdrawArgs = {
                        from_subaccount = null; to = command.request.target;
                        amount = command.request.amount; created_at_time = ?timestamp;
                    };
                    let encoded = to_candid(withdrawArgs);
                    command.source_args := ?encoded; command.source_timestamp := ?timestamp;
                    encoded;
                        };
                    };
                };
            };
            let replyResult = await* calls.call({ canister = Journal.cycles(); method = "withdraw"; args; cycles = 0 });
            if (command.phase != #withdraw_pending) return;
            switch (replyResult) {
                case (#err(error)) { command.source_uncertain := true; setError(command, "The cycles-ledger withdrawal reply is unverified: " # error.message) };
                case (#ok(reply)) {
                    let decoded : ?Types.WithdrawResult = from_candid(reply);
                    switch (decoded) {
                        case (?#Ok(block)) {
                            command.source_block := ?block; command.credited_cycles := ?command.request.amount;
                            command.phase := #complete; command.error := null;
                        };
                        case (?#Err(#Duplicate(value))) {
                            command.source_block := ?value.duplicate_of; command.duplicate := true; command.source_uncertain := true;
                            setError(command, "The cycles ledger recorded the original withdrawal, but a duplicate reply does not prove delivery. Keep this saved request; do not submit another refill.");
                        };
                        case (?#Err(#FailedToWithdraw(error))) {
                            command.phase := if (error.fee_block == null) #stopped else #refunded; command.refund_block := error.fee_block;
                            setError(command, switch (error.fee_block) {
                                case (?_) "The canister could not receive cycles. The ledger returned the withdrawn balance less its withdrawal and refund fees: " # error.rejection_reason;
                                case null "The canister could not receive cycles and the amount did not cover a refund. The ledger charged its fees: " # error.rejection_reason;
                            });
                        };
                        case (?#Err(#TemporarilyUnavailable)) setError(command, "The cycles ledger is temporarily unavailable. Continue this saved refill.");
                        case (?#Err(#CreatedInFuture(_))) setError(command, "The cycles ledger has not reached the saved request timestamp yet. Continue this refill shortly.");
                        case (?#Err(error)) {
                            let message = "The cycles ledger rejected this attempt: " # debug_show(error);
                            if (command.source_uncertain) setError(command, message # ". An earlier attempt remains unverified.") else stop(command, message);
                        };
                        case null { command.source_uncertain := true; setError(command, "The cycles ledger returned an unexpected withdrawal reply. Keep the saved request for recovery.") };
                    };
                };
            };
            command.updated_at := Time.now();
        };
        func forward(command : Memory.Command) : async* () {
            let ?minted = command.minted_cycles else { setError(command, "The saved TCYCLES mint receipt is unavailable"); return };
            let fees = command.request.cycles_fee * 2;
            if (minted <= fees) {
                stop(command, "TCYCLES were minted into your Neutron, but the amount cannot cover the recipient transfer fee. They remain in your Wallet.");
                return;
            };
            let amount = Nat.sub(minted, fees);
            let args = switch (command.forward_args) {
                case (?saved) {
                    if (not retryWithinWindow(command, command.forward_timestamp)) return;
                    saved;
                };
                case null {
                    // The mint receipt fixes the available amount. A later
                    // token transfer cannot spend more than that mint credit.
                    if (not (await* checkFee(command, Journal.cycles(), command.request.cycles_fee))) return;
                    if (command.phase != #forward_pending) return;
                    switch (command.forward_args) {
                        case (?existing) existing;
                        case null {
                    let timestamp = Journal.nextTimestamp(mem, Time.now());
                    let transfer : IcrcTypes.TransferArg = {
                        from_subaccount = null; to = { owner = command.request.target; subaccount = null };
                        amount; fee = ?command.request.cycles_fee; memo = ?command.request.id; created_at_time = ?timestamp;
                    };
                    let encoded = to_candid(transfer);
                    command.forward_args := ?encoded; command.forward_timestamp := ?timestamp;
                    encoded;
                        };
                    };
                };
            };
            let replyResult = await* calls.call(Icrc.transferCandidRequest(Journal.cycles(), args));
            if (command.phase != #forward_pending) return;
            switch (decodeTransfer(replyResult)) {
                case (#ok(receipt)) {
                    command.forward_block := ?receipt.block_index; command.duplicate := command.duplicate or receipt.duplicate;
                    command.credited_cycles := ?amount; command.phase := #complete; command.error := null;
                };
                case (#unknown(message)) { command.forward_uncertain := true; setError(command, message) };
                case (#retry(message)) setError(command, message);
                case (#rejected(message)) {
                    if (command.forward_uncertain) setError(command, message # ". The original recipient transfer remains unverified.")
                    else setError(command, message # ". Minted TCYCLES remain in your Neutron; continue this saved transfer when ready.");
                };
            };
            command.updated_at := Time.now();
        };
    };

    type TransferOutcome = {
        #ok : Icrc.ExecutionReceipt; #unknown : Text; #retry : Text; #rejected : Text;
    };
    func decodeTransfer(result : Capabilities.CallResult) : TransferOutcome {
        switch (result) {
            case (#ok(reply)) {
                let decoded : ?IcrcTypes.TransferResult = from_candid(reply);
                switch (decoded) {
                    case (?#Err(#TemporarilyUnavailable)) return #retry("The ledger is temporarily unavailable. Continue this saved refill.");
                    case (?#Err(#CreatedInFuture(_))) return #retry("The ledger has not reached the saved request timestamp yet. Continue this refill shortly.");
                    case (_) {};
                };
            };
            case (_) {};
        };
        switch (Icrc.classifyTransferResult(result)) {
            case (#ok(receipt)) #ok(receipt);
            case (#unknown(message)) #unknown(message);
            case (#rejected(message)) #rejected(message);
        };
    };
};
