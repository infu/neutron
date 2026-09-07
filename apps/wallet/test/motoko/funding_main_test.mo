import BridgeProviderMemory "../../backend/memory/wallet_bridge_provider/v1";
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Int "mo:core/Int";
import Map "mo:core/Map";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Time "mo:core/Time";
import Capabilities "../../backend/capabilities/Types";
import HistoryStore "../../backend/history/Store";
import IcrcTypes "../../backend/icrc1/Types";
import Main "../../backend/main";
import WalletMemory "../../backend/memory/wallet/v1";
import BridgeMemory "../../backend/memory/wallet_bridge/v1";
import BridgeReplacementMemory "../../backend/memory/wallet_bridge_replacements/v1";
import CommandMemory "../../backend/memory/wallet_commands/v1";
import TransferMemory "../../backend/memory/wallet_transfers/v1";

// Exercise the actual Main/FundingJournal path, including its serialized ledger
// dispatch admission. A real actor await does not guarantee a new IC timestamp.
persistent actor Test {
    public func boundary() : async () {};

    public func run() : async () {
        let wallet = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
        let ledger = Principal.fromText("xevnm-gaaaa-aaaar-qafnq-cai");
        let recipient = Principal.fromText("mxzaz-hqaaa-aaaar-qaada-cai");
        let memory = WalletMemory.init();
        memory.configured := true;
        Map.add<Principal, WalletMemory.Ledger>(memory.ledgers, Principal.compare, ledger, {
            id = 1; principal = ledger; name = ?"Chain-key USDC";
            symbol = ?"ckUSDC"; decimals = ?6; fee = ?10; logo = null;
            balance = ?10_000; metadata_updated_at = ?0; balance_updated_at = ?0;
            metadata_error = null; balance_error = null; native_address = null;
            native_address_updated_at = null; native_address_error = null;
            native_refresh_updated_at = null; native_refresh_error = null;
            native_deposit_progress = null; enabled = true;
            history = HistoryStore.emptyHistory(#unavailable);
        });
        let accepted = Map.empty<Blob, Nat>();
        var transferBytes : [Blob] = [];
        var transferArgs : [IcrcTypes.TransferArg] = [];
        var dispatchedAt : [Int] = [];
        var nextBlock = 81;

        func call(request : Capabilities.CallRequest) : async* Capabilities.CallResult {
            assert (request.canister == ledger and request.cycles == 0);
            switch (request.method) {
                case ("icrc1_metadata") {
                    let metadata : IcrcTypes.Metadata = [
                        ("icrc1:name", #Text("Chain-key USDC")),
                        ("icrc1:symbol", #Text("ckUSDC")),
                        ("icrc1:decimals", #Nat(6)),
                        ("icrc1:fee", #Nat(10)),
                    ];
                    #ok(to_candid(metadata));
                };
                case ("icrc1_fee") #ok(to_candid(10 : Nat));
                case ("icrc1_transfer") {
                    let ?args : ?IcrcTypes.TransferArg = from_candid request.args else {
                        Runtime.trap("Invalid transfer arguments");
                    };
                    transferBytes := Array.concat(transferBytes, [request.args]);
                    transferArgs := Array.concat(transferArgs, [args]);
                    dispatchedAt := Array.concat(dispatchedAt, [Time.now()]);
                    // The Main lock remains held over a genuine message boundary.
                    // This test double deduplicates the exact ledger identity;
                    // it cannot observe or use the Wallet command ID.
                    await Test.boundary();
                    switch (Map.get(accepted, Blob.compare, request.args)) {
                        case (?block) {
                            let reply : IcrcTypes.TransferResult = #Err(#Duplicate({ duplicate_of = block }));
                            #ok(to_candid(reply));
                        };
                        case null {
                            let block = nextBlock;
                            nextBlock += 1;
                            Map.add(accepted, Blob.compare, request.args, block);
                            // The ledger accepted the debit, but Wallet has no
                            // definitive receipt until it replays exact bytes.
                            #err({ code = "response_lost"; message = "Ledger accepted transfer but its response was lost" });
                        };
                    };
                };
                case (_) Runtime.trap("Unexpected ledger method: " # request.method);
            };
        };
        let calls : Capabilities.BackendCalls = {
            canister_principal = wallet;
            can_call = func(target : Principal, method : Text) : Bool {
                target == ledger and (method == "icrc1_metadata" or method == "icrc1_fee" or method == "icrc1_transfer");
            };
            call;
            call_batch = func(requests : [Capabilities.CallRequest]) : async* [Capabilities.CallResult] {
                var results : [Capabilities.CallResult] = [];
                for (request in requests.vals()) results := Array.concat(results, [await* call(request)]);
                results;
            };
        };
        let env : Main.AppBackendEnvironment = {
            stable_memory = {
                wallet = memory; wallet_commands = CommandMemory.init();
                wallet_transfers = TransferMemory.init(); wallet_bridge = BridgeMemory.init(); wallet_bridge_provider = BridgeProviderMemory.init(); wallet_bridge_replacements = BridgeReplacementMemory.init();
            };
            capabilities = { backend_calls = calls };
            app_calls = { contacts = {
                contacts_discover_v1 = func(_request : Main.DiscoverContactsRequestV1) : Main.DiscoverContactsResultV1 {
                    Runtime.trap("Funding does not use Contacts");
                };
            } };
        };
        func request(id : Nat8, memo : ?Blob) : Main.WalletFundingPrepareRequestV1 {
            {
                request_id = Blob.fromArray(Array.repeat<Nat8>(id, 16));
                ledger; valid_until_ns = Nat64.fromNat(Int.abs(Time.now())) + 300_000_000_000;
                caller = { app_id = "kitchensink"; endpoint = "funding-test"; role = null };
                agent_mode = false;
                intent = #direct({ amount_atoms = 1_000; to = { owner = recipient; subaccount = null }; memo });
            };
        };
        func prepared(outcome : Main.WalletFundingPrepareResultV1) : Main.WalletFundingPreparedV1 {
            switch (outcome) { case (#ok(#prepared(value))) value; case (_) Runtime.trap(debug_show(outcome)) };
        };
        func pending(outcome : Main.WalletFundingExecutionResultV1) {
            switch (outcome) { case (#pending(_)) {}; case (_) Runtime.trap("Expected unknown transfer: " # debug_show(outcome)) };
        };
        func receipt(outcome : Main.WalletFundingExecutionResultV1) : Main.WalletFundingTransferredV1 {
            switch (outcome) { case (#transferred(value)) value; case (_) Runtime.trap(debug_show(outcome)) };
        };
        var pair = 0;
        for (memo in [null, ?("\de\ad\be\ef" : Blob)].vals()) {
            let firstRequest = request(if (pair == 0) 11 else 13, memo);
            let secondRequest = request(if (pair == 0) 12 else 14, memo);
            let app = Main.Init(env);
            let first = prepared(await* app.wallet_funding_prepare_v1(firstRequest));
            let second = prepared(await* app.wallet_funding_prepare_v1(secondRequest));
            assert first.command_id != second.command_id;
            assert first.review.memo == memo and second.review.memo == memo;
            let start = transferBytes.size();
            pending(await* app.wallet_funding_execute_v1({ command_id = first.command_id }));
            // Rebuild the runtime over the same managed roots. Fresh identities
            // must remain unique after a reload, not only within one Init object.
            let restored = Main.Init(env);
            pending(await* restored.wallet_funding_execute_v1({ command_id = second.command_id }));
            assert transferBytes.size() == start + 2;
            assert transferBytes[start] != transferBytes[start + 1];
            let a = transferArgs[start];
            let b = transferArgs[start + 1];
            assert a.memo == memo and b.memo == memo;
            assert ({ a with created_at_time = null } == { b with created_at_time = null });
            let ?at = a.created_at_time else Runtime.trap("Missing first timestamp");
            let ?bt = b.created_at_time else Runtime.trap("Missing second timestamp");
            assert bt > at;
            assert a.to == { owner = recipient; subaccount = null };
            assert a.amount == 1_000 and a.fee == ?10 and a.from_subaccount == null;
            // Each unknown request reconciles to its own original ledger block.
            let afterReload = Main.Init(env);
            let firstReceipt = receipt(await* afterReload.wallet_funding_execute_v1({ command_id = first.command_id }));
            let secondReceipt = receipt(await* afterReload.wallet_funding_execute_v1({ command_id = second.command_id }));
            assert firstReceipt.duplicate and secondReceipt.duplicate;
            assert firstReceipt.block_index == 81 + pair * 2;
            assert secondReceipt.block_index == 82 + pair * 2;
            assert transferBytes.size() == start + 4;
            assert transferBytes[start] == transferBytes[start + 2];
            assert transferBytes[start + 1] == transferBytes[start + 3];
            // Terminal repeats return the retained receipt with no ledger call.
            assert receipt(await* Main.Init(env).wallet_funding_execute_v1({ command_id = first.command_id })) == firstReceipt;
            assert receipt(await* Main.Init(env).wallet_funding_execute_v1({ command_id = second.command_id })) == secondReceipt;
            assert transferBytes.size() == start + 4;
            pair += 1;
        };
        assert Map.size(accepted) == 4;
        assert transferBytes.size() == 8;
        // Keep observed dispatch times in the diagnostic record when this
        // regression fails: real awaits can share a round's IC time.
        assert dispatchedAt.size() == transferBytes.size();
    };
};
