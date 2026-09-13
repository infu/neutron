import RefillMemory "../../backend/memory/wallet_refills/v1";
import BridgeActivityMemory "../../backend/memory/wallet_bridge_activity/v1";
import BridgeProviderMemory "../../backend/memory/wallet_bridge_provider/v1";
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Capabilities "../../backend/capabilities/Types";
import History "../../backend/history/Reconcile";
import HistoryStore "../../backend/history/Store";
import IcrcTypes "../../backend/icrc1/Types";
import Main "../../backend/main";
import WalletMemory "../../backend/memory/wallet/v1";
import BridgeMemory "../../backend/memory/wallet_bridge/v1";
import BridgeReplacementMemory "../../backend/memory/wallet_bridge_replacements/v1";
import CommandMemory "../../backend/memory/wallet_commands/v1";
import TransferMemory "../../backend/memory/wallet_transfers/v1";

persistent actor {
    public func run() : async () {
        let wallet = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
        let ledger = Principal.fromText("xevnm-gaaaa-aaaar-qafnq-cai");
        let recipient = Principal.fromText("mxzaz-hqaaa-aaaar-qaada-cai");
        let destination : Main.DestinationV1 = #internet_computer({
            owner = recipient;
            subaccount = null;
        });
        let transfer : Main.WalletTransferRequest = {
            ledger;
            network = #internet_computer;
            contact_id = 7;
            contact_revision = 3;
            address_id = 9;
            expected_destination = destination;
            amount = 1_000;
        };
        func requestId(byte : Nat8) : Blob {
            Blob.fromArray(Array.tabulate<Nat8>(16, func(_) { byte }));
        };
        let firstRequest : Main.WalletTransferRequestV2 = {
            request_id = requestId(1);
            transfer;
            withdrawal_quote = null;
        };
        let secondRequest : Main.WalletTransferRequestV2 = {
            request_id = requestId(2);
            transfer;
            withdrawal_quote = null;
        };

        let memory = WalletMemory.init();
        memory.configured := true;
        Map.add<Principal, WalletMemory.Ledger>(memory.ledgers, Principal.compare, ledger, {
            id = 1;
            principal = ledger;
            name = ?"Chain-key USDC";
            symbol = ?"ckUSDC";
            decimals = ?6;
            fee = ?10;
            logo = null;
            balance = ?10_000;
            metadata_updated_at = ?0;
            balance_updated_at = ?0;
            metadata_error = null;
            balance_error = null;
            native_address = null;
            native_address_updated_at = null;
            native_address_error = null;
            native_refresh_updated_at = null;
            native_refresh_error = null;
            native_deposit_progress = null;
            enabled = true;
            history = HistoryStore.emptyHistory(#unavailable);
        });

        let accepted = Map.empty<Blob, Nat>();
        var transferBytes : [Blob] = [];
        var transferArgs : [IcrcTypes.TransferArg] = [];
        var feeCalls = 0;
        var networkCalls = 0;
        var nextBlock = 81;
        var exclusivePrincipal = true;

        // Ledger deduplication sees wire arguments, not Wallet's request ID.
        // Without a request-specific memo, equal transfers in this update
        // collapse onto one block because their timestamps also match.
        func call(request : Capabilities.CallRequest) : async* Capabilities.CallResult {
            assert (request.canister == ledger and request.cycles == 0);
            networkCalls += 1;
            switch (request.method) {
                case ("icrc1_fee") {
                    assert (request.args == to_candid ());
                    feeCalls += 1;
                    #ok(to_candid (10 : Nat));
                };
                case ("icrc1_transfer") {
                    let ?args : ?IcrcTypes.TransferArg = from_candid request.args else {
                        Runtime.trap("Invalid transfer arguments");
                    };
                    transferBytes := Array.concat(transferBytes, [request.args]);
                    transferArgs := Array.concat(transferArgs, [args]);
                    let response : IcrcTypes.TransferResult = switch (Map.get(accepted, Blob.compare, request.args)) {
                        case (?block) #Err(#Duplicate({ duplicate_of = block }));
                        case null {
                            let block = nextBlock;
                            nextBlock += 1;
                            Map.add(accepted, Blob.compare, request.args, block);
                            #Ok(block);
                        };
                    };
                    #ok(to_candid (response));
                };
                case (_) Runtime.trap("Unexpected ledger method: " # request.method);
            };
        };

        let calls : Capabilities.BackendCalls = {
            canister_principal = wallet;
            owns_principal = func(target : Principal) : Bool { exclusivePrincipal and target == ledger };
            can_call = func(target : Principal, method : Text) : Bool {
                target == ledger and (method == "icrc1_fee" or method == "icrc1_transfer");
            };
            call;
            call_batch = func(requests : [Capabilities.CallRequest]) : async* [Capabilities.CallResult] {
                var results : [Capabilities.CallResult] = [];
                for (request in requests.vals()) {
                    results := Array.concat(results, [await* call(request)]);
                };
                results;
            };
        };
        let env : Main.AppBackendEnvironment = {
            stable_memory = { wallet_refills = RefillMemory.init(); wallet_bridge_activity = BridgeActivityMemory.init();
                wallet = memory;
                wallet_commands = CommandMemory.init();
                wallet_transfers = TransferMemory.init();
                wallet_bridge = BridgeMemory.init(); wallet_bridge_provider = BridgeProviderMemory.init(); wallet_bridge_replacements = BridgeReplacementMemory.init();
            };
            capabilities = { backend_calls = calls };
            app_calls = {
                contacts = {
                    contacts_discover_v1 = func(request : Main.DiscoverContactsRequestV1) : Main.DiscoverContactsResultV1 {
                        assert (request.contact_id == ?transfer.contact_id);
                        assert (request.destination_kinds == [#internet_computer]);
                        #ok({
                            book_revision = 4;
                            destinations = [{
                                contact_id = transfer.contact_id;
                                contact_revision = transfer.contact_revision;
                                contact_kind = #person;
                                contact_name = "Recipient";
                                address = {
                                    id = transfer.address_id;
                                    address_label = ?"Wallet";
                                    destination;
                                    preferred = true;
                                };
                            }];
                            total = 1;
                            next_offset = null;
                        });
                    };
                };
            };
        };
        func operation(result : Main.WalletTransferResultV2) : Main.WalletTransferOperationV2 {
            switch (result) {
                case (#ok(value)) value;
                case (#err(error)) Runtime.trap(error);
            };
        };
        func receipt(value : Main.WalletTransferOperationV2) : Main.WalletTransferReceipt {
            switch (value.status) {
                case (#succeeded(value)) value;
                case (_) Runtime.trap("Expected a successful transfer");
            };
        };

        let preparing = Main.Init(env);
        let prepared = operation(preparing.wallet_transfer_prepare_v2(firstRequest));
        assert (prepared.status == #pending and prepared.request_id == firstRequest.request_id);
        assert (operation(preparing.wallet_transfer_prepare_v2(firstRequest)) == prepared);
        assert (networkCalls == 0 and feeCalls == 0 and transferBytes.size() == 0);
        // Acknowledging an unfinished command cannot hide it or execute it.
        assert (operation(preparing.wallet_transfer_acknowledge_v2(firstRequest.request_id)) == prepared);
        let app = Main.Init(env);
        assert (app.wallet_transfers_pending_v2(()) == [prepared]);
        assert (operation(app.wallet_transfer_status_v2(firstRequest.request_id)) == prepared);
        assert (networkCalls == 0);
        // A restored resident command cannot use historical fee/transfer
        // grants after Wallet has lost exclusive ownership of the ledger.
        exclusivePrincipal := false;
        assert calls.can_call(ledger, "icrc1_fee") and calls.can_call(ledger, "icrc1_transfer");
        switch (await* Main.Init(env).wallet_transfer_resume_v2(firstRequest.request_id)) {
            case (#err(message)) assert Text.contains(message, #text("exclusive ledger access"));
            case (#ok(_)) Runtime.trap("Saved transfer resumed without exclusive ledger access");
        };
        assert operation(app.wallet_transfer_status_v2(firstRequest.request_id)) == prepared;
        assert Map.size(env.stable_memory.wallet_transfers.commands) == 1;
        assert networkCalls == 0 and feeCalls == 0 and transferBytes.size() == 0;
        exclusivePrincipal := true;
        // Every await is async*, so both commands execute within the same
        // update and receive the same Time.now() value.
        let first = operation(await* app.wallet_transfer_resume_v2(firstRequest.request_id));
        let second = operation(await* app.wallet_transfer_v2(secondRequest));
        assert (first.created_at_ns == prepared.created_at_ns);
        assert (first.created_at_ns == second.created_at_ns);
        assert (first.request_id == firstRequest.request_id);
        assert (second.request_id == secondRequest.request_id);
        assert (receipt(first).block_index == 81);
        assert (receipt(second).block_index == 82);
        assert (not receipt(first).duplicate and not receipt(second).duplicate);
        assert (feeCalls == 2 and networkCalls == 4);
        assert (transferBytes.size() == 2 and transferBytes[0] != transferBytes[1]);
        assert (Map.size(accepted) == 2);
        assert (transferArgs[0].memo == ?firstRequest.request_id);
        assert (transferArgs[1].memo == ?secondRequest.request_id);
        assert (transferArgs[0].created_at_time == ?first.created_at_ns);
        assert (transferArgs[1].created_at_time == ?second.created_at_ns);
        assert ({ transferArgs[0] with memo = null } == { transferArgs[1] with memo = null });
        for (args in transferArgs.vals()) {
            assert (args.to == { owner = recipient; subaccount = null });
            assert (args.amount == transfer.amount and args.fee == ?10);
            assert (args.from_subaccount == null);
        };

        func historyTransaction(block : Nat) : WalletMemory.HistoryTransaction {
            let ?selected = Map.get(memory.ledgers, Principal.compare, ledger) else {
                Runtime.trap("Selected ledger disappeared");
            };
            let ?transaction = Map.get(selected.history.transactions, Nat.compare, block) else {
                Runtime.trap("Transfer history was not persisted");
            };
            transaction;
        };
        let history = History.Service(memory, calls);
        for ((request, saved) in [(firstRequest, first), (secondRequest, second)].vals()) {
            let pending = historyTransaction(receipt(saved).block_index);
            assert (pending.memo == ?request.request_id);
            assert (pending.provenance == #local_pending);
            let ?intent = pending.intent else Runtime.trap("Transfer contact intent was lost");
            assert (intent.contact_id == transfer.contact_id and intent.address_id == transfer.address_id);
            assert (intent.contact_name == "Recipient" and intent.address_label == ?"Wallet");
            assert (intent.network == "internet_computer" and not intent.native);

            // A canonical receipt with the dispatched memo must still match
            // the local receipt and retain its contact metadata when enriched.
            let canonical : WalletMemory.HistoryTransaction = {
                pending with
                timestamp_ns = pending.timestamp_ns + 1;
                memo = ?request.request_id;
                intent = null;
                provenance = #index;
                verification = #verified;
            };
            assert (History.pendingMatches(ledger, wallet, pending, canonical, null));
            assert (HistoryStore.putTransaction(memory, ledger, canonical));
            assert (history.recordTransfer(
                ledger, pending.block_index, pending.operation, pending.amount,
                pending.fee, pending.to, pending.memo, pending.intent, pending.native,
            ) == #ok(()));
            assert (historyTransaction(pending.block_index) == { canonical with intent = pending.intent });
        };

        let restored = Main.Init(env);
        // A lost success reply leaves the terminal receipt discoverable from
        // canister memory, without relying on a browser's local storage.
        assert (restored.wallet_transfers_pending_v2(()).size() == 2);
        for ((request, saved) in [(firstRequest, first), (secondRequest, second)].vals()) {
            var found = false;
            for (listed in restored.wallet_transfers_pending_v2(()).vals()) {
                if (listed == saved) found := true;
            };
            assert found;
            assert (operation(await* app.wallet_transfer_v2(request)) == saved);
            assert (operation(app.wallet_transfer_status_v2(request.request_id)) == saved);
            assert (operation(await* app.wallet_transfer_resume_v2(request.request_id)) == saved);
            assert (operation(await* restored.wallet_transfer_v2(request)) == saved);
            assert (operation(restored.wallet_transfer_status_v2(request.request_id)) == saved);
            assert (operation(await* restored.wallet_transfer_resume_v2(request.request_id)) == saved);
            assert (operation(restored.wallet_transfer_acknowledge_v2(request.request_id)) == saved);
            for (listed in restored.wallet_transfers_pending_v2(()).vals()) {
                assert (listed.request_id != request.request_id);
            };
        };
        let acknowledged = Main.Init(env);
        assert (acknowledged.wallet_transfers_pending_v2(()) == []);
        for ((request, saved) in [(firstRequest, first), (secondRequest, second)].vals()) {
            assert (operation(acknowledged.wallet_transfer_prepare_v2(request)) == saved);
            assert (operation(acknowledged.wallet_transfer_status_v2(request.request_id)) == saved);
            assert (operation(await* acknowledged.wallet_transfer_resume_v2(request.request_id)) == saved);
            assert (operation(await* acknowledged.wallet_transfer_v2(request)) == saved);
            assert (operation(acknowledged.wallet_transfer_acknowledge_v2(request.request_id)) == saved);
        };
        assert (acknowledged.wallet_transfers_pending_v2(()) == []);
        assert (networkCalls == 4 and transferBytes.size() == 2);
        assert (Map.size(env.stable_memory.wallet_transfers.commands) == 2);

        // Exercise quote authorization through Main's saved native context.
        let gasLedger = Principal.fromText("ss2fx-dyaaa-aaaar-qacoq-cai");
        let minter = Principal.fromText("sv3dd-oaaaa-aaaar-qacoa-cai");
        let ethereumDestination : Main.DestinationV1 = #ethereum_mainnet("0x1111111111111111111111111111111111111111");
        let nativeTransfer : Main.WalletTransferRequest = {
            transfer with network = #ethereum_mainnet; expected_destination = ethereumDestination;
        };
        let gasReview : Main.WalletWithdrawalGasAuthorizationV1 = {
            ledger = gasLedger; minter; budget = 65_000; ledger_fee = 20;
        };
        let review : Main.WalletWithdrawalAuthorizationV1 = { asset_fee = 10; gas = ?gasReview };
        let nativeMemory = WalletMemory.init();
        nativeMemory.configured := true;
        let ?template = Map.get(memory.ledgers, Principal.compare, ledger) else Runtime.trap("Missing ledger fixture");
        Map.add(nativeMemory.ledgers, Principal.compare, ledger, {
            template with balance = ?1_000_000; history = HistoryStore.emptyHistory(#unavailable);
        });
        Map.add(nativeMemory.ledgers, Principal.compare, gasLedger, {
            template with id = 2; principal = gasLedger; name = ?"Chain-key ETH";
            symbol = ?"ckETH"; decimals = ?18; fee = ?20; balance = ?1_000_000;
            history = HistoryStore.emptyHistory(#unavailable);
        });
        var remoteAssetFee = 10;
        var remoteGasFee = 20;
        var remoteGasBudget = 65_000;
        var nativeCallCount = 0;
        type Price = {
            gas_limit : Nat; max_fee_per_gas : Nat; max_priority_fee_per_gas : Nat;
            max_transaction_fee : Nat; timestamp : ?Nat64;
        };
        func nativeCall(request : Capabilities.CallRequest) : async* Capabilities.CallResult {
            nativeCallCount += 1;
            assert (request.cycles == 0);
            switch (request.method) {
                case ("icrc1_fee") {
                    assert (request.canister == ledger or request.canister == gasLedger);
                    assert (request.args == to_candid ());
                    let fee : Nat = if (request.canister == ledger) remoteAssetFee else remoteGasFee;
                    #ok(to_candid (fee));
                };
                case ("eip_1559_transaction_price") {
                    assert (request.canister == minter);
                    let priceArg : ?{ ckerc20_ledger_id : Principal } = ?{ ckerc20_ledger_id = ledger };
                    assert (request.args == to_candid (priceArg));
                    let price : Price = {
                        gas_limit = 65_000; max_fee_per_gas = remoteGasBudget / 65_000;
                        max_priority_fee_per_gas = 1; max_transaction_fee = remoteGasBudget;
                        timestamp = null;
                    };
                    #ok(to_candid (price));
                };
                case ("get_events") {
                    assert (request.canister == minter);
                    assert (request.args == to_candid ({ start = 0 : Nat64; length = 0 : Nat64 }));
                    #err({ code = "unavailable"; message = "Optional recovery tail unavailable" });
                };
                case (_) Runtime.trap("Cost rejection dispatched a financial effect: " # request.method);
            };
        };
        let nativeCalls : Capabilities.BackendCalls = {
            canister_principal = wallet;
            owns_principal = func(target : Principal) : Bool { target == ledger or target == gasLedger or target == minter };
            can_call = func(_target : Principal, _method : Text) : Bool { true };
            call = nativeCall;
            call_batch = func(requests : [Capabilities.CallRequest]) : async* [Capabilities.CallResult] {
                var results : [Capabilities.CallResult] = [];
                for (request in requests.vals()) results := Array.concat(results, [await* nativeCall(request)]);
                results;
            };
        };
        let nativeEnv : Main.AppBackendEnvironment = {
            stable_memory = { wallet_refills = RefillMemory.init(); wallet_bridge_activity = BridgeActivityMemory.init();
                wallet = nativeMemory; wallet_commands = CommandMemory.init();
                wallet_transfers = TransferMemory.init(); wallet_bridge = BridgeMemory.init(); wallet_bridge_provider = BridgeProviderMemory.init(); wallet_bridge_replacements = BridgeReplacementMemory.init();
            };
            capabilities = { backend_calls = nativeCalls };
            app_calls = { contacts = {
                contacts_discover_v1 = func(request : Main.DiscoverContactsRequestV1) : Main.DiscoverContactsResultV1 {
                    assert (request.contact_id == ?nativeTransfer.contact_id);
                    assert (request.destination_kinds == [#ethereum_mainnet]);
                    #ok({
                        book_revision = 4; total = 1; next_offset = null;
                        destinations = [{
                            contact_id = nativeTransfer.contact_id; contact_revision = nativeTransfer.contact_revision;
                            contact_kind = #person; contact_name = "Recipient";
                            address = {
                                id = nativeTransfer.address_id; address_label = ?"Ethereum";
                                destination = ethereumDestination; preferred = true;
                            };
                        }];
                    });
                };
            } };
        };
        func expectError(result : Main.WalletTransferResultV2, fragment : Text) : () {
            switch (result) {
                case (#err(message)) assert (Text.contains(message, #text(fragment)));
                case (#ok(_)) Runtime.trap("Expected quote authorization rejection");
            };
        };
        let nativeApp = Main.Init(nativeEnv);
        let nativeRequest : Main.WalletTransferRequestV2 = {
            request_id = requestId(10); transfer = nativeTransfer; withdrawal_quote = ?review;
        };
        expectError(nativeApp.wallet_transfer_prepare_v2({ nativeRequest with withdrawal_quote = null }), "quote");
        expectError(nativeApp.wallet_transfer_prepare_v2({
            nativeRequest with withdrawal_quote = ?{ review with gas = null };
        }), "quote");
        assert (nativeCallCount == 0 and Map.size(nativeEnv.stable_memory.wallet_transfers.commands) == 0);

        // Each mismatch terminates before reserving an allowance for the next
        // case. The mock traps on every approval or minter withdrawal call.
        let changedCosts : [(Nat8, Nat, Nat, Nat, Nat)] = [
            (10, 11, 65_000, 20, 2),
            (11, 10, 130_000, 20, 4),
            (12, 10, 65_000, 21, 4),
        ];
        for ((id, assetFee, gasBudget, gasFee, expectedReads) in changedCosts.vals()) {
            let request = { nativeRequest with request_id = requestId(id) };
            let before = nativeCallCount;
            let preparedNative = operation(nativeApp.wallet_transfer_prepare_v2(request));
            assert (preparedNative.status == #pending and preparedNative.native);
            expectError(nativeApp.wallet_transfer_prepare_v2({
                request with withdrawal_quote = ?{ review with asset_fee = 11 };
            }), "different withdrawal cost review");
            expectError(nativeApp.wallet_transfer_prepare_v2({
                request with withdrawal_quote = ?{ review with gas = ?{ gasReview with budget = 130_000 } };
            }), "different withdrawal cost review");
            assert (nativeCallCount == before);
            assert (operation(nativeApp.wallet_transfer_status_v2(request.request_id)) == preparedNative);
            remoteAssetFee := assetFee;
            remoteGasBudget := gasBudget;
            remoteGasFee := gasFee;
            let resumedNative = Main.Init(nativeEnv);
            let rejectedNative = operation(await* resumedNative.wallet_transfer_resume_v2(request.request_id));
            switch (rejectedNative.status) {
                case (#rejected(message)) assert (Text.contains(message, #text("Withdrawal costs changed")));
                case (_) Runtime.trap("Changed native quote was not rejected");
            };
            assert (nativeCallCount == before + expectedReads);
            assert (operation(await* resumedNative.wallet_transfer_resume_v2(request.request_id)) == rejectedNative);
            assert (nativeCallCount == before + expectedReads);
        };
    };
};
