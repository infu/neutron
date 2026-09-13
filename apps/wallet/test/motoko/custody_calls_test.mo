import Array "mo:core/Array";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Custody "../../backend/capabilities/Custody";
import Types "../../backend/capabilities/Types";
import Journal "../../backend/transfers/Journal";
import Memory "../../backend/memory/wallet_transfers/v1";

persistent actor CustodyTest {
    public func boundary() : async () {};

    public func run() : async () {
        let ledger = Principal.fromText("xevnm-gaaaa-aaaar-qafnq-cai");
        let gasLedger = Principal.fromText("ss2fx-dyaaa-aaaar-qacoq-cai");
        let minter = Principal.fromText("sv3dd-oaaaa-aaaar-qacoa-cai");
        let index = Principal.fromText("qhbym-qaaaa-aaaaa-aaafq-cai");
        let cmc = Principal.fromText("rkp4c-7iaaa-aaaaa-aaaca-cai");
        let reply : Blob = "retained reply";
        var owned = false;
        var excluded : ?Principal = null;
        var ordinaryGrant = true;
        var revokeAfterDispatch = false;
        var dispatched : [Types.CallRequest] = [];
        var batches : [[Types.CallRequest]] = [];

        func request(canister : Principal, method : Text) : Types.CallRequest {
            { canister; method; args = "original candid bytes"; cycles = 17 };
        };
        func errorCode(result : Types.CallResult) : Text {
            switch (result) { case (#err(error)) error.code; case (#ok(_)) Runtime.trap("Expected denial") };
        };
        func call(value : Types.CallRequest) : async* Types.CallResult {
            if (not ordinaryGrant) return #err({ code = "not_reserved"; message = "No ordinary Kernel grant" });
            dispatched := Array.concat(dispatched, [value]);
            await CustodyTest.boundary();
            if (revokeAfterDispatch) owned := false;
            #ok(reply);
        };
        let base : Types.BackendCalls = {
            canister_principal = Principal.fromActor(CustodyTest);
            owns_principal = func(target : Principal) : Bool { owned and excluded != ?target };
            // Models historical exact grants that remain individually valid.
            can_call = func(_ : Principal, _ : Text) : Bool { ordinaryGrant };
            call;
            call_batch = func(values : [Types.CallRequest]) : async* [Types.CallResult] {
                batches := Array.concat(batches, [values]);
                if (not ordinaryGrant) return Array.map<Types.CallRequest, Types.CallResult>(values, func(_) {
                    #err({ code = "not_reserved"; message = "No ordinary Kernel grant" });
                });
                dispatched := Array.concat(dispatched, values);
                await CustodyTest.boundary();
                if (revokeAfterDispatch) owned := false;
                Array.map<Types.CallRequest, Types.CallResult>(values, func(_) { #ok(reply) });
            };
        };
        let calls = Custody.guard(base);
        let custodyRequests = [
            request(ledger, "icrc1_metadata"), request(ledger, "icrc1_fee"),
            request(ledger, "icrc1_transfer"), request(ledger, "icrc2_approve"),
            request(ledger, "icrc3_get_blocks"), request(ledger, "remove_approval"),
            request(gasLedger, "icrc2_approve"), request(gasLedger, "withdraw"),
            request(minter, "get_events"), request(minter, "withdraw_erc20"),
            request(minter, "retrieve_btc_with_approval"),
            request(ledger, "future_ledger_method"),
            // A public index method name does not exempt an arbitrary ledger.
            request(ledger, "get_account_transactions"),
            // A caller chooses the mint subaccount when notifying the CMC;
            // exact grants must not substitute for exclusive custody there.
            request(cmc, "notify_top_up"), request(cmc, "notify_mint_cycles"),
            request(ledger, "notify_top_up"), request(ledger, "notify_mint_cycles"),
            request(cmc, "unapproved_future_cmc_method"),
        ];
        for (value in custodyRequests.vals()) {
            assert base.can_call(value.canister, value.method);
            assert not calls.can_call(value.canister, value.method);
            assert errorCode(await* calls.call(value)) == "not_reserved";
        };
        assert dispatched.size() == 0 and batches.size() == 0;

        let sharedRequests = [request(index, "get_account_transactions")];
        for (value in sharedRequests.vals()) {
            assert calls.can_call(value.canister, value.method);
            assert (await* calls.call(value)) == #ok(reply);
        };
        assert dispatched.size() == sharedRequests.size();
        ordinaryGrant := false;
        for (value in sharedRequests.vals()) {
            assert not calls.can_call(value.canister, value.method);
            assert errorCode(await* calls.call(value)) == "not_reserved";
        };
        assert dispatched.size() == sharedRequests.size();
        ordinaryGrant := true;
        owned := true;
        for (value in custodyRequests.vals()) {
            assert calls.can_call(value.canister, value.method);
            assert (await* calls.call(value)) == #ok(reply);
        };

        // Mixed ownership denies the complete operation before handing any
        // request to the Kernel. Original result cardinality is retained.
        let mixed = [request(ledger, "icrc1_fee"), request(gasLedger, "icrc1_fee"), request(index, "get_account_transactions")];
        excluded := ?gasLedger;
        let beforeMixed = dispatched.size();
        let denied = await* calls.call_batch(mixed);
        assert denied.size() == mixed.size();
        for (result in denied.vals()) assert errorCode(result) == "not_reserved";
        assert dispatched.size() == beforeMixed and batches.size() == 0;
        excluded := null;
        let accepted = await* calls.call_batch(mixed);
        assert accepted == [#ok(reply), #ok(reply), #ok(reply)];
        assert batches == [mixed];
        assert dispatched.size() == beforeMixed + mixed.size();

        // A completed remote effect has an unknown result to Wallet if its
        // exclusive reservation is removed while the call is in flight.
        revokeAfterDispatch := true;
        let beforeRace = dispatched.size();
        assert errorCode(await* calls.call(request(ledger, "icrc1_transfer"))) == "revoked_after_dispatch";
        assert dispatched.size() == beforeRace + 1;
        assert base.can_call(ledger, "icrc1_transfer");
        assert errorCode(await* calls.call(request(ledger, "icrc1_transfer"))) == "not_reserved";
        assert dispatched.size() == beforeRace + 1;
        owned := true;
        let racedBatch = await* calls.call_batch(mixed);
        assert racedBatch.size() == mixed.size();
        assert errorCode(racedBatch[0]) == "revoked_after_dispatch";
        assert errorCode(racedBatch[1]) == "revoked_after_dispatch";
        assert racedBatch[2] == #ok(reply);
        assert batches == [mixed, mixed];
        revokeAfterDispatch := false;

        // Restoring exact saved replies after an upgrade cannot bypass the
        // outer guard. Denial must not overwrite the original journal bytes.
        let fee = request(ledger, "icrc1_fee");
        let transfer = request(ledger, "icrc1_transfer");
        let command : Memory.Command = {
            request_id = "saved request"; intent = "saved owner intent"; resolved = "saved destination";
            created_at = 1; ledger; native = false; minter = null; allowance_ledgers = [];
            var updated_at = 0; var status = #pending; var last_error = null;
            var settlement = null; var acknowledged = false;
            var calls = [
                { canister = fee.canister; method = fee.method; args = fee.args; cycles = fee.cycles; var outcome = #reply(reply) },
                { canister = transfer.canister; method = transfer.method; args = transfer.args; cycles = transfer.cycles; var outcome = #reply(reply) },
            ];
        };
        func saved() : Blob {
            to_candid(
                command.request_id, command.intent, command.resolved,
                command.created_at, command.ledger, command.native, command.minter,
                command.allowance_ledgers, command.updated_at, command.status,
                command.last_error, command.settlement, command.acknowledged,
                Array.map<Memory.Step, Blob>(command.calls, func(step) {
                    to_candid(step.canister, step.method, step.args, step.cycles, step.outcome);
                }),
            );
        };
        let original = saved();
        let beforeReplay = dispatched.size();
        let replay = Journal.Replay(command, calls);
        let guardedReplay = Custody.guard(replay.backend_calls);
        assert errorCode(await* guardedReplay.call(fee)) == "not_reserved";
        assert errorCode(await* guardedReplay.call(transfer)) == "not_reserved";
        assert saved() == original;
        assert dispatched.size() == beforeReplay;
        owned := true;
        assert (await* guardedReplay.call(fee)) == #ok(reply);
        assert (await* guardedReplay.call(transfer)) == #ok(reply);
        assert saved() == original;
        assert dispatched.size() == beforeReplay;
    };
};
