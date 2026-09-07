import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Catalog "../../backend/Catalog";
import Capabilities "../../backend/capabilities/Types";
import HistoryStore "../../backend/history/Store";
import Icrc "../../backend/icrc1/Types";
import Main "../../backend/main";
import WalletMemory "../../backend/memory/wallet/v1";
import BridgeMemory "../../backend/memory/wallet_bridge/v1";
import ProviderMemory "../../backend/memory/wallet_bridge_provider/v1";
import ReplacementMemory "../../backend/memory/wallet_bridge_replacements/v1";
import CommandMemory "../../backend/memory/wallet_commands/v1";
import TransferMemory "../../backend/memory/wallet_transfers/v1";
persistent actor {
    public func run() : async () {
        let eth = Principal.fromText("ss2fx-dyaaa-aaaar-qacoq-cai");
        let usdc = Principal.fromText("xevnm-gaaaa-aaaar-qafnq-cai");
        let minter = Principal.fromText("sv3dd-oaaaa-aaaar-qacoa-cai");
        let address = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
        func id(byte : Nat8) : Blob { Blob.fromArray(Array.repeat<Nat8>(byte, 16)) };
        func operation(result : Main.WalletTransferResultV2) : Main.WalletTransferOperationV2 {
            switch (result) { case (#ok(value)) value; case (#err(error)) Runtime.trap(error) };
        };
        func rejected(result : Main.WalletTransferResultV2, text : Text) {
            switch (result) { case (#err(error)) assert Text.contains(error, #text(text)); case (_) Runtime.trap("Expected rejection: " # text) };
        };
        func saved(result : Main.WalletEthereumWithdrawStatusResultV1) : Main.WalletEthereumWithdrawStatusV1 {
            switch (result) { case (#ok(?value)) value; case (_) Runtime.trap("Missing saved direct withdrawal") };
        };
        class Fixture() {
            public let wallet = WalletMemory.init();
            public let transfers = TransferMemory.init();
            public var contacts = 0;
            public var callsMade = 0;
            public var approvalBytes : [Blob] = [];
            public var withdrawalBytes : [Blob] = [];
            public var loseApproval = false;
            public var loseMinter = false;
            wallet.configured := true;
            for (ledger in [eth, usdc].vals()) {
                Map.add<Principal, WalletMemory.Ledger>(wallet.ledgers, Principal.compare, ledger, {
                    id = Map.size(wallet.ledgers); principal = ledger;
                    name = ?"Bridge test"; symbol = ?(if (ledger == eth) "ckETH" else "ckUSDC");
                    decimals = ?(if (ledger == eth) 18 else 6); fee = ?10; logo = null; balance = ?1_000_000;
                    metadata_updated_at = ?0; balance_updated_at = ?0; metadata_error = null; balance_error = null;
                    native_address = null; native_address_updated_at = null; native_address_error = null;
                    native_refresh_updated_at = null; native_refresh_error = null; native_deposit_progress = null;
                    enabled = true; history = HistoryStore.emptyHistory(#unavailable);
                });
            };
            func call(request : Capabilities.CallRequest) : async* Capabilities.CallResult {
                callsMade += 1;
                assert (request.cycles == 0);
                switch (request.method) {
                    case ("icrc1_fee") #ok(to_candid (10 : Nat));
                    case ("get_events") #err({ code = "unavailable"; message = "Optional event tail unavailable" });
                    case ("eip_1559_transaction_price") {
                        let price = { gas_limit = 65_000 : Nat; max_fee_per_gas = 1 : Nat; max_priority_fee_per_gas = 1 : Nat; max_transaction_fee = 65_000 : Nat; timestamp = null : ?Nat64 };
                        #ok(to_candid (price));
                    };
                    case ("icrc2_approve") {
                        let ?args : ?Icrc.ApproveArg = from_candid request.args else Runtime.trap("Bad approval");
                        assert (args.spender.owner == minter and args.fee == ?10);
                        approvalBytes := Array.concat(approvalBytes, [request.args]);
                        if (loseApproval) { loseApproval := false; return #err({ code = "reply_lost"; message = "Approval reply lost" }) };
                        let result : Icrc.ApproveResult = #Ok(20);
                        #ok(to_candid (result));
                    };
                    case ("withdraw_eth" or "withdraw_erc20") {
                        assert (request.canister == minter);
                        let ?args : ?{ recipient : Text; amount : Nat } = from_candid request.args else Runtime.trap("Bad withdrawal");
                        assert (args.recipient == address and args.amount == 1_000);
                        withdrawalBytes := Array.concat(withdrawalBytes, [request.args]);
                        if (loseMinter) return #err({ code = "reply_lost"; message = "Minter reply lost" });
                        if (request.method == "withdraw_eth") {
                            let result : { #Ok : { block_index : Nat } } = #Ok({ block_index = 90 });
                            #ok(to_candid (result));
                        } else {
                            let result : { #Ok : { cketh_block_index : Nat; ckerc20_block_index : Nat } } = #Ok({ cketh_block_index = 91; ckerc20_block_index = 92 });
                            #ok(to_candid (result));
                        };
                    };
                    case (_) Runtime.trap("Unexpected call: " # request.method);
                };
            };
            let calls : Capabilities.BackendCalls = {
                canister_principal = Principal.fromText("aaaaa-aa");
                can_call = func(_ : Principal, _ : Text) : Bool { true }; call;
                call_batch = func(requests : [Capabilities.CallRequest]) : async* [Capabilities.CallResult] {
                    var results : [Capabilities.CallResult] = [];
                    for (request in requests.vals()) results := Array.concat(results, [await* call(request)]);
                    results;
                };
            };
            public let env : Main.AppBackendEnvironment = {
                stable_memory = {
                    wallet; wallet_transfers = transfers; wallet_commands = CommandMemory.init();
                    wallet_bridge = BridgeMemory.init(); wallet_bridge_replacements = ReplacementMemory.init();
                    wallet_bridge_provider = ProviderMemory.init();
                };
                capabilities = { backend_calls = calls };
                app_calls = { contacts = { contacts_discover_v1 = func(_ : Main.DiscoverContactsRequestV1) : Main.DiscoverContactsResultV1 {
                    contacts += 1;
                    #ok({ book_revision = 1; destinations = []; total = 0; next_offset = null });
                } } };
            };
        };
        func request(ledger : Principal, byte : Nat8) : Main.WalletEthereumWithdrawRequestV1 {
            {
                request_id = id(byte); ledger; address = "0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD"; amount = 1_000;
                withdrawal_quote = ?{ asset_fee = 10; gas = if (ledger == eth) null else ?{ ledger = eth; minter; budget = 65_000; ledger_fee = 10 } };
            };
        };
        for (ledger in [eth, usdc].vals()) {
            let f = Fixture();
            let app = Main.Init(f.env);
            let input = request(ledger, 1);
            assert (app.wallet_ethereum_withdraw_status_v1(input.request_id) == #ok(null));
            rejected(app.wallet_ethereum_withdraw_prepare_v1({ input with address = "not-an-address" }), "Ethereum address");
            rejected(app.wallet_ethereum_withdraw_prepare_v1({ input with ledger = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai") }), "Ledger");
            assert (f.callsMade == 0 and Map.size(f.transfers.commands) == 0);
            let prepared = operation(app.wallet_ethereum_withdraw_prepare_v1(input));
            assert (prepared.destination == address and prepared.status == #pending);
            assert (operation(app.wallet_ethereum_withdraw_prepare_v1(input)) == prepared);
            assert (saved(app.wallet_ethereum_withdraw_status_v1(input.request_id)).request == { input with address });
            assert (f.callsMade == 0 and f.contacts == 0);
            rejected(app.wallet_ethereum_withdraw_prepare_v1({ input with amount = 1_001 }), "different intent");
            rejected(app.wallet_ethereum_withdraw_prepare_v1({ input with withdrawal_quote = null }), "different withdrawal cost review");
            let synthetic : Main.WalletTransferRequest = {
                ledger; amount = 1_000; network = #ethereum_mainnet; expected_destination = #ethereum_mainnet(address);
                contact_id = 0; contact_revision = 0; address_id = 0;
            };
            rejected(app.wallet_transfer_prepare_v2({ request_id = input.request_id; transfer = synthetic; withdrawal_quote = input.withdrawal_quote }), "destination authorization");
            // Retry a lost timestamp-deduplicated approval with exact Candid.
            f.loseApproval := true;
            assert (operation(await* app.wallet_transfer_resume_v2(input.request_id)).status == #pending);
            assert (f.approvalBytes.size() == 1 and f.withdrawalBytes.size() == 0);
            let ?stored = Map.get(f.transfers.commands, Blob.compare, input.request_id) else Runtime.trap("Missing command");
            let exactIntent = stored.intent;
            let exactContext = stored.resolved;
            let restored = Main.Init(f.env);
            let complete = operation(await* restored.wallet_transfer_resume_v2(input.request_id));
            switch (complete.status) { case (#succeeded(value)) assert (value.native and value.amount == 1_000); case (_) Runtime.trap("Direct withdrawal did not execute") };
            assert (f.approvalBytes[0] == f.approvalBytes[1]);
            assert (f.approvalBytes.size() == (if (ledger == eth) 2 else 3));
            assert (f.withdrawalBytes.size() == 1 and f.contacts == 0);
            assert (stored.intent == exactIntent and stored.resolved == exactContext);
            let callsBefore = f.callsMade;
            assert (operation(restored.wallet_ethereum_withdraw_prepare_v1(input)) == complete);
            assert (operation(await* restored.wallet_transfer_resume_v2(input.request_id)) == complete);
            assert (saved(restored.wallet_ethereum_withdraw_status_v1(input.request_id)).operation == complete);
            assert (f.callsMade == callsBefore);
        };
        // Released payloads omit the optional binding. Contact IDs of zero
        // still require Contacts revalidation after restoring existing roots.
        let legacy = Fixture();
        let input = request(eth, 2);
        let intent : Main.WalletTransferRequest = {
            ledger = eth; amount = 1_000; network = #ethereum_mainnet; expected_destination = #ethereum_mainnet(address);
            contact_id = 0; contact_revision = 0; address_id = 0;
        };
        let ?catalog = Catalog.find(eth) else Runtime.trap("No ckETH catalog");
        let legacyContext = to_candid ({
            contact = { destination = intent.expected_destination; contact_name = "Existing contact"; address_label = null : ?Text };
            route = catalog.native_route; withdrawal_quote = input.withdrawal_quote;
        });
        let command : TransferMemory.Command = {
            request_id = input.request_id; intent = to_candid (intent); resolved = legacyContext;
            created_at = 10_000; ledger = eth; native = true; minter = ?minter; allowance_ledgers = [eth];
            var updated_at = 10_000; var status = #pending; var last_error = null;
            var settlement = null; var acknowledged = false; var calls = [];
        };
        Map.add(legacy.transfers.commands, Blob.compare, input.request_id, command);
        let app = Main.Init(legacy.env);
        assert (app.wallet_ethereum_withdraw_status_v1(input.request_id) == #ok(null));
        rejected(app.wallet_ethereum_withdraw_prepare_v1(input), "destination authorization");
        assert (operation(app.wallet_transfer_prepare_v2({ request_id = input.request_id; transfer = intent; withdrawal_quote = input.withdrawal_quote })).status == #pending);
        let legacyResult = operation(await* app.wallet_transfer_resume_v2(input.request_id));
        switch (legacyResult.status) { case (#rejected(error)) assert Text.contains(error, #text("Contact destination was not found")); case (_) Runtime.trap("Legacy contact bypassed revalidation") };
        assert (legacy.contacts == 1 and legacy.approvalBytes.size() == 0 and command.resolved == legacyContext);
        // A minter has no deduplication key; an ambiguous reply is not resent.
        let ambiguous = Fixture();
        ambiguous.loseMinter := true;
        let unknownInput = request(eth, 3);
        let unknownApp = Main.Init(ambiguous.env);
        ignore operation(unknownApp.wallet_ethereum_withdraw_prepare_v1(unknownInput));
        assert (operation(await* unknownApp.wallet_transfer_resume_v2(unknownInput.request_id)).status == #pending);
        let before = ambiguous.callsMade;
        assert (operation(await* Main.Init(ambiguous.env).wallet_transfer_resume_v2(unknownInput.request_id)).status == #pending);
        assert (ambiguous.callsMade == before and ambiguous.withdrawalBytes.size() == 1);
    };
};
