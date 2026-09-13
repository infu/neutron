import RefillMemory "../../backend/memory/wallet_refills/v1";
import BridgeActivityMemory "../../backend/memory/wallet_bridge_activity/v1";
import BridgeProviderMemory "../../backend/memory/wallet_bridge_provider/v1";
import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Capabilities "../../backend/capabilities/Types";
import HistoryStore "../../backend/history/Store";
import IcrcTypes "../../backend/icrc1/Types";
import Main "../../backend/main";
import WalletMemory "../../backend/memory/wallet/v1";
import BridgeMemory "../../backend/memory/wallet_bridge/v1";
import ReplacementMemory "../../backend/memory/wallet_bridge_replacements/v1";
import CommandMemory "../../backend/memory/wallet_commands/v1";
import TransferMemory "../../backend/memory/wallet_transfers/v1";
import Journal "../../backend/transfers/Journal";

// Actual Main.Init, journal, withdrawal adapter, history and settlement code.
// The strict mock transport crosses real IC message/await boundaries through
// this actor; its scripted replies do not execute real ledgers or minters.
persistent actor NativeSettlementMain {
    type ExpectedCall = { request : Capabilities.CallRequest; result : Capabilities.CallResult };
    var expected : [ExpectedCall] = [];
    var cursor = 0;
    var callsMade = 0;

    public func transport(request : Capabilities.CallRequest) : async Capabilities.CallResult {
        if (cursor >= expected.size()) Runtime.trap("Unexpected native transport call: " # request.method);
        let next = expected[cursor];
        if (request != next.request) Runtime.trap("Native transport request mismatch at " # Nat.toText(cursor) # ": " # request.method);
        cursor += 1;
        callsMade += 1;
        next.result;
    };

    func schedule(values : [ExpectedCall]) {
        assert (cursor == expected.size());
        expected := values;
        cursor := 0;
    };
    func consumed() { assert (cursor == expected.size()) };

    public func run() : async () {
        type Route = {
            ledger : Principal; minter : Principal; network : Main.DestinationKindV1;
            destination : Main.DestinationV1; address : Text;
            withdraw_method : Text; status_method : Text; sol : Bool;
        };
        let btcAddress = "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh";
        let dogeAddress = "D7Y55xwxvQygeCgx7uEmYw7pUbKKRzcTRF";
        let solAddress = "11111111111111111111111111111111";
        let routes : [Route] = [
            {
                ledger = Principal.fromText("mxzaz-hqaaa-aaaar-qaada-cai");
                minter = Principal.fromText("mqygn-kiaaa-aaaar-qaadq-cai");
                network = #bitcoin_mainnet; destination = #bitcoin_mainnet(btcAddress); address = btcAddress;
                withdraw_method = "retrieve_btc_with_approval"; status_method = "retrieve_btc_status_v2"; sol = false;
            },
            {
                ledger = Principal.fromText("efmc5-wyaaa-aaaar-qb3wa-cai");
                minter = Principal.fromText("eqltq-xqaaa-aaaar-qb3vq-cai");
                network = #dogecoin_mainnet; destination = #dogecoin_mainnet(dogeAddress); address = dogeAddress;
                withdraw_method = "retrieve_doge_with_approval"; status_method = "retrieve_doge_status"; sol = false;
            },
            {
                ledger = Principal.fromText("ls5lp-lqaaa-aaaar-qb5oa-cai");
                minter = Principal.fromText("lh22c-kyaaa-aaaar-qb5nq-cai");
                network = #solana_mainnet; destination = #solana_mainnet(solAddress); address = solAddress;
                withdraw_method = "withdraw"; status_method = "withdrawal_status"; sol = true;
            },
        ];
        func requestId(byte : Nat8) : Blob { Blob.fromArray(Array.tabulate<Nat8>(16, func(_) { byte })) };
        func transferRequest(route : Route, id : Nat8) : Main.WalletTransferRequestV2 {
            {
                request_id = requestId(id); withdrawal_quote = null;
                transfer = {
                    ledger = route.ledger; network = route.network; expected_destination = route.destination;
                    contact_id = 7; contact_revision = 3; address_id = 9; amount = 1_000;
                };
            };
        };
        func operation(result : Main.WalletTransferResultV2) : Main.WalletTransferOperationV2 {
            switch (result) { case (#ok(value)) value; case (#err(message)) Runtime.trap(message) };
        };
        func receipt(value : Main.WalletTransferOperationV2) : Main.WalletTransferReceipt {
            switch (value.status) { case (#succeeded(receipt)) receipt; case (_) Runtime.trap("Expected accepted native burn") };
        };
        func settlement(value : Main.WalletTransferOperationV2) : Main.WalletTransferSettlementV2 {
            switch (value.settlement) { case (?status) status; case null Runtime.trap("Missing native settlement") };
        };

        class Fixture() {
            public let wallet = WalletMemory.init();
            public let transfers = TransferMemory.init();
            wallet.configured := true;
            for (route in routes.vals()) {
                Map.add<Principal, WalletMemory.Ledger>(wallet.ledgers, Principal.compare, route.ledger, {
                    id = Map.size(wallet.ledgers) + 1; principal = route.ledger;
                    name = ?"Native settlement test"; symbol = ?"ckTEST";
                    decimals = ?(if (route.sol) 9 else 8); fee = ?10; logo = null; balance = ?1_000_000;
                    metadata_updated_at = ?0; balance_updated_at = ?0;
                    metadata_error = null; balance_error = null;
                    native_address = null; native_address_updated_at = null; native_address_error = null;
                    native_refresh_updated_at = null; native_refresh_error = null; native_deposit_progress = null;
                    enabled = true; history = HistoryStore.emptyHistory(#unavailable);
                });
            };
            func call(request : Capabilities.CallRequest) : async* Capabilities.CallResult {
                await NativeSettlementMain.transport(request);
            };
            let calls : Capabilities.BackendCalls = {
                canister_principal = Principal.fromActor(NativeSettlementMain);
                owns_principal = func(_target : Principal) : Bool { true };
                can_call = func(_target : Principal, _method : Text) : Bool { true };
                call;
                call_batch = func(requests : [Capabilities.CallRequest]) : async* [Capabilities.CallResult] {
                    var results : [Capabilities.CallResult] = [];
                    for (request in requests.vals()) results := Array.concat(results, [await* call(request)]);
                    results;
                };
            };
            public let env : Main.AppBackendEnvironment = {
                stable_memory = { wallet_refills = RefillMemory.init(); wallet_bridge_activity = BridgeActivityMemory.init();
                    wallet; wallet_transfers = transfers;
                    wallet_commands = CommandMemory.init(); wallet_bridge = BridgeMemory.init();
                    wallet_bridge_provider = BridgeProviderMemory.init(); wallet_bridge_replacements = ReplacementMemory.init();
                };
                capabilities = { backend_calls = calls };
                app_calls = { contacts = {
                    contacts_discover_v1 = func(request : Main.DiscoverContactsRequestV1) : Main.DiscoverContactsResultV1 {
                        assert (request.contact_id == ?7 and request.offset == 0 and request.limit == 20);
                        for (route in routes.vals()) {
                            if (request.destination_kinds == [route.network]) return #ok({
                                book_revision = 4; total = 1; next_offset = null;
                                destinations = [{
                                    contact_id = 7; contact_revision = 3; contact_kind = #person; contact_name = "Native recipient";
                                    address = { id = 9; address_label = ?"Native"; destination = route.destination; preferred = true };
                                }];
                            });
                        };
                        Runtime.trap("Unexpected contact network");
                    };
                } };
            };
        };

        func withdrawalCalls(route : Route, request : Main.WalletTransferRequestV2, prepared : Main.WalletTransferOperationV2, result : Capabilities.CallResult) : [ExpectedCall] {
            let approval : IcrcTypes.ApproveArg = {
                from_subaccount = null; spender = { owner = route.minter; subaccount = null };
                amount = 1_010; fee = ?10; expected_allowance = null;
                expires_at = ?(prepared.created_at_ns + 600_000_000_000);
                memo = ?request.request_id; created_at_time = ?prepared.created_at_ns;
            };
            let approved : IcrcTypes.ApproveResult = #Ok(80);
            let withdrawal : { address : Text; amount : Nat64; from_subaccount : ?Blob } = {
                address = route.address; amount = 1_000; from_subaccount = null;
            };
            [
                { request = { canister = route.ledger; method = "icrc1_fee"; args = to_candid (); cycles = 0 }; result = #ok(to_candid (10 : Nat)) },
                { request = { canister = route.ledger; method = "icrc2_approve"; args = to_candid (approval); cycles = 0 }; result = #ok(to_candid (approved)) },
                { request = { canister = route.minter; method = route.withdraw_method; args = to_candid (withdrawal); cycles = 0 }; result },
            ];
        };
        func acceptedBurn(block : Nat64) : Capabilities.CallResult {
            let value : { #Ok : { block_index : Nat64 } } = #Ok({ block_index = block });
            #ok(to_candid (value));
        };
        func statusCall(route : Route, block : Nat64, reply : Capabilities.CallResult) : ExpectedCall {
            { request = { canister = route.minter; method = route.status_method; args = to_candid ({ block_index = block }); cycles = 0 }; result = reply };
        };
        let txid : Blob = "\00\01\02\03\04\05\06\07\08\09\0a\0b\0c\0d\0e\0f\10\11\12\13\14\15\16\17\18\19\1a\1b\1c\1d\1e\1f";
        let displayed = "1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100";
        let signature = "4vdAydTJcnLToErPyDRgYEpZnr3rxNJkuPXi4WHUmjfsZ7J9M9GWtRS82bvm8SnBPDhPFSL17jjhHxHaErFeQU7Z";
        func submitted(route : Route) : Capabilities.CallResult {
            if (route.sol) {
                let value : { #TxSent : { transaction_id : Text } } = #TxSent({ transaction_id = signature });
                #ok(to_candid (value));
            } else {
                let value : { #Submitted : { txid : Blob } } = #Submitted({ txid });
                #ok(to_candid (value));
            };
        };
        func confirmed(route : Route) : Capabilities.CallResult {
            if (route.sol) {
                let value : { #TxFinalized : { #Success : { transaction_id : Text; effective_transaction_fee : ?Nat } } } =
                    #TxFinalized(#Success({ transaction_id = signature; effective_transaction_fee = ?5_000 }));
                #ok(to_candid (value));
            } else {
                let value : { #Confirmed : { txid : Blob } } = #Confirmed({ txid });
                #ok(to_candid (value));
            };
        };
        let lostReply : Capabilities.CallResult = #err({ code = "reply_lost"; message = "mock reply lost after minter acceptance" });
        let alreadyProcessing : { #Err : { #AlreadyProcessing } } = #Err(#AlreadyProcessing);

        var routeIndex = 0;
        for (route in routes.vals()) {
            let fixture = Fixture();
            let app = Main.Init(fixture.env);
            let request = transferRequest(route, 1);
            let beforePrepare = callsMade;
            let prepared = operation(app.wallet_transfer_prepare_v2(request));
            assert (prepared.status == #pending and callsMade == beforePrepare);
            // The minter's Nat64 burn identifier is deliberately above Nat32.
            let burnBlock : Nat64 = 4_294_967_391;
            schedule(withdrawalCalls(route, request, prepared, acceptedBurn(burnBlock)));
            let burned = operation(await* app.wallet_transfer_resume_v2(request.request_id));
            consumed();
            assert (callsMade == beforePrepare + 3);
            assert (receipt(burned).block_index == Nat64.toNat(burnBlock));
            assert (receipt(burned).secondary_block_index == null and receipt(burned).native);
            assert (receipt(burned).ledger == route.ledger and receipt(burned).amount == 1_000);
            assert (receipt(burned).fee == 10 and not receipt(burned).duplicate);
            switch (settlement(burned).status) { case (#pending(_)) {}; case (_) assert false };
            let afterBurn = callsMade;
            let restored = Main.Init(fixture.env);
            assert (operation(restored.wallet_transfer_status_v2(request.request_id)) == burned);
            ignore operation(restored.wallet_transfer_acknowledge_v2(request.request_id));
            assert (restored.wallet_transfers_pending_v2(()).size() == 1);
            assert (operation(await* restored.wallet_transfer_resume_v2(request.request_id)) == burned);
            assert (callsMade == afterBurn);

            schedule([statusCall(route, burnBlock, lostReply)]);
            let unavailable = operation(await* restored.wallet_transfer_refresh_v2(request.request_id));
            consumed();
            switch (settlement(unavailable).status) { case (#unknown(_)) {}; case (_) assert false };
            assert (receipt(unavailable) == receipt(burned));
            schedule([statusCall(route, burnBlock, submitted(route))]);
            let broadcast = operation(await* Main.Init(fixture.env).wallet_transfer_refresh_v2(request.request_id));
            consumed();
            let expectedHash = if (route.sol) signature else displayed;
            switch (settlement(broadcast).status) {
                case (#submitted(value)) assert (value.transaction_hash == expectedHash);
                case (_) assert false;
            };
            schedule([statusCall(route, burnBlock, confirmed(route))]);
            let complete = operation(await* Main.Init(fixture.env).wallet_transfer_refresh_v2(request.request_id));
            consumed();
            switch (settlement(complete).status) {
                case (#confirmed(value)) assert (value.transaction_hash == expectedHash);
                case (_) assert false;
            };
            let ?storedLedger = Map.get(fixture.wallet.ledgers, Principal.compare, route.ledger) else Runtime.trap("Missing ledger");
            let ?history = Map.get(storedLedger.history.transactions, Nat.compare, Nat64.toNat(burnBlock)) else Runtime.trap("Missing native history");
            let ?native = history.native else Runtime.trap("Missing native history links");
            assert (native.transaction_id == ?expectedHash);
            let ?intent = history.intent else Runtime.trap("Missing contact intent");
            assert (intent.contact_id == 7 and intent.address_id == 9 and intent.native);
            let finalApp = Main.Init(fixture.env);
            assert (finalApp.wallet_transfers_pending_v2(()) == [complete]);
            ignore operation(finalApp.wallet_transfer_acknowledge_v2(request.request_id));
            let afterComplete = callsMade;
            let acknowledged = Main.Init(fixture.env);
            assert (acknowledged.wallet_transfers_pending_v2(()) == []);
            assert (operation(acknowledged.wallet_transfer_prepare_v2(request)) == complete);
            assert (operation(await* acknowledged.wallet_transfer_v2(request)) == complete);
            assert (operation(await* acknowledged.wallet_transfer_resume_v2(request.request_id)) == complete);
            assert (operation(await* acknowledged.wallet_transfer_refresh_v2(request.request_id)) == complete);
            assert (callsMade == afterComplete);

            // Keep a separate earlier minter call ambiguous. A definite
            // AlreadyProcessing rejection for this route cannot resolve it.
            let independentRoute = routes[(routeIndex + 1) % routes.size()];
            let independent = transferRequest(independentRoute, 2);
            let independentPrepared = operation(acknowledged.wallet_transfer_prepare_v2(independent));
            schedule(withdrawalCalls(independentRoute, independent, independentPrepared, lostReply));
            let unknown = operation(await* acknowledged.wallet_transfer_resume_v2(independent.request_id));
            consumed();
            assert (unknown.status == #pending);
            assert (Journal.allowanceReserved(fixture.transfers, independentRoute.ledger, independentRoute.minter, null));
            let rejectedRequest = transferRequest(route, 3);
            let rejectionPrepared = operation(acknowledged.wallet_transfer_prepare_v2(rejectedRequest));
            schedule(withdrawalCalls(route, rejectedRequest, rejectionPrepared, #ok(to_candid (alreadyProcessing))));
            let rejected = operation(await* acknowledged.wallet_transfer_resume_v2(rejectedRequest.request_id));
            consumed();
            switch (rejected.status) {
                case (#rejected(message)) assert (Text.contains(message, #text("processing")));
                case (_) Runtime.trap("AlreadyProcessing must reject this pre-burn invocation");
            };
            assert (not Journal.allowanceReserved(fixture.transfers, route.ledger, route.minter, null));
            assert (Journal.allowanceReserved(fixture.transfers, independentRoute.ledger, independentRoute.minter, null));
            let recovery = Main.Init(fixture.env);
            let afterRejection = callsMade;
            assert (operation(await* recovery.wallet_transfer_resume_v2(rejectedRequest.request_id)) == rejected);
            assert (operation(await* recovery.wallet_transfer_v2(rejectedRequest)) == rejected);
            ignore operation(recovery.wallet_transfer_acknowledge_v2(rejectedRequest.request_id));
            // The newly rejected allowance can accept a new owner intent.
            let next = transferRequest(route, 4);
            assert (operation(recovery.wallet_transfer_prepare_v2(next)).status == #pending);
            // The independently ambiguous allowance remains fenced.
            switch (recovery.wallet_transfer_prepare_v2(transferRequest(independentRoute, 5))) {
                case (#err(message)) assert (Text.contains(message, #text("unresolved")));
                case (_) Runtime.trap("An ambiguous earlier burn lost its allowance reservation");
            };
            let resumedUnknown = operation(await* recovery.wallet_transfer_resume_v2(independent.request_id));
            assert (resumedUnknown.status == #pending);
            assert (operation(recovery.wallet_transfer_status_v2(independent.request_id)).status == #pending);
            assert (Journal.allowanceReserved(fixture.transfers, independentRoute.ledger, independentRoute.minter, null));
            assert (callsMade == afterRejection);
            consumed();
            routeIndex += 1;
        };
    };
};
