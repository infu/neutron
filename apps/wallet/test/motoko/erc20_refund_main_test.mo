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
import HistoryStore "../../backend/history/Store";
import IcrcTypes "../../backend/icrc1/Types";
import Main "../../backend/main";
import WalletMemory "../../backend/memory/wallet/v1";
import BridgeMemory "../../backend/memory/wallet_bridge/v1";
import ReplacementMemory "../../backend/memory/wallet_bridge_replacements/v1";
import CommandMemory "../../backend/memory/wallet_commands/v1";
import TransferMemory "../../backend/memory/wallet_transfers/v1";
import Journal "../../backend/transfers/Journal";

// Main and all financial/reconciliation adapters execute as compiled IC Wasm.
// Scripted transport replies cross real actor-call boundaries. They model
// ledger/minter outcomes, without sending assets or accessing live canisters.
persistent actor Erc20RefundMain {
    type ExpectedCall = { request : Capabilities.CallRequest; result : Capabilities.CallResult };
    var expected : [ExpectedCall] = [];
    var cursor = 0;
    var callsMade = 0;
    public func transport(request : Capabilities.CallRequest) : async Capabilities.CallResult {
        if (cursor >= expected.size()) Runtime.trap("Unexpected refund transport call: " # request.method);
        let next = expected[cursor];
        if (request != next.request) Runtime.trap("Refund request mismatch at " # Nat.toText(cursor) # ": " # request.method);
        cursor += 1;
        callsMade += 1;
        next.result;
    };
    func schedule(values : [ExpectedCall]) {
        assert (cursor == expected.size()); expected := values; cursor := 0;
    };
    func consumed() { assert (cursor == expected.size()) };

    public func run() : async () {
        let ledger = Principal.fromText("xevnm-gaaaa-aaaar-qafnq-cai");
        let gasLedger = Principal.fromText("ss2fx-dyaaa-aaaar-qacoq-cai");
        let minter = Principal.fromText("sv3dd-oaaaa-aaaar-qacoa-cai");
        let address = "0x1111111111111111111111111111111111111111";
        let destination : Main.DestinationV1 = #ethereum_mainnet(address);
        let transfer : Main.WalletTransferRequest = {
            ledger; network = #ethereum_mainnet; expected_destination = destination;
            contact_id = 7; contact_revision = 3; address_id = 9; amount = 1_000;
        };
        let review : Main.WalletWithdrawalAuthorizationV1 = {
            asset_fee = 10; gas = ?{ ledger = gasLedger; minter; budget = 65_000; ledger_fee = 20 };
        };
        func request(byte : Nat8) : Main.WalletTransferRequestV2 {
            { transfer; withdrawal_quote = ?review; request_id = Blob.fromArray(Array.tabulate<Nat8>(16, func(_) { byte })) };
        };
        func operation(result : Main.WalletTransferResultV2) : Main.WalletTransferOperationV2 {
            switch (result) { case (#ok(value)) value; case (#err(message)) Runtime.trap(message) };
        };
        func messageContains(message : ?Text, fragment : Text) : Bool {
            switch (message) { case (?text) Text.contains(text, #text(fragment)); case null false };
        };
        class Fixture() {
            public let wallet = WalletMemory.init();
            public let transfers = TransferMemory.init();
            wallet.configured := true;
            for ((principal, fee, decimals) in [(ledger, 10, 6), (gasLedger, 20, 18)].vals()) {
                Map.add<Principal, WalletMemory.Ledger>(wallet.ledgers, Principal.compare, principal, {
                    id = Map.size(wallet.ledgers) + 1; principal; name = ?"Refund test"; symbol = ?"ckTEST";
                    decimals = ?decimals; fee = ?fee; logo = null; balance = ?1_000_000;
                    metadata_updated_at = ?0; balance_updated_at = ?0; metadata_error = null; balance_error = null;
                    native_address = null; native_address_updated_at = null; native_address_error = null;
                    native_refresh_updated_at = null; native_refresh_error = null; native_deposit_progress = null;
                    enabled = true; history = HistoryStore.emptyHistory(#unavailable);
                });
            };
            func call(value : Capabilities.CallRequest) : async* Capabilities.CallResult { await Erc20RefundMain.transport(value) };
            public let env : Main.AppBackendEnvironment = {
                stable_memory = { wallet_bridge_activity = BridgeActivityMemory.init(); wallet; wallet_transfers = transfers; wallet_commands = CommandMemory.init(); wallet_bridge = BridgeMemory.init(); wallet_bridge_provider = BridgeProviderMemory.init(); wallet_bridge_replacements = ReplacementMemory.init() };
                capabilities = { backend_calls = {
                    canister_principal = Principal.fromActor(Erc20RefundMain);
                    can_call = func(_canister : Principal, _method : Text) : Bool { true };
                    call;
                    call_batch = func(requests : [Capabilities.CallRequest]) : async* [Capabilities.CallResult] {
                        var results : [Capabilities.CallResult] = [];
                        for (value in requests.vals()) results := Array.concat(results, [await* call(value)]);
                        results;
                    };
                } };
                app_calls = { contacts = {
                    contacts_discover_v1 = func(contactRequest : Main.DiscoverContactsRequestV1) : Main.DiscoverContactsResultV1 {
                        assert (contactRequest.contact_id == ?7 and contactRequest.destination_kinds == [#ethereum_mainnet]);
                        #ok({
                            book_revision = 4; total = 1; next_offset = null;
                            destinations = [{
                                contact_id = 7; contact_revision = 3; contact_kind = #person; contact_name = "Refund recipient";
                                address = { id = 9; address_label = ?"Ethereum"; destination; preferred = true };
                            }];
                        });
                    };
                } };
            };
            public func command(id : Blob) : TransferMemory.Command {
                switch (Map.get(transfers.commands, Blob.compare, id)) { case (?value) value; case null Runtime.trap("Missing saved withdrawal") };
            };
        };

        type LedgerError = {
            #InsufficientFunds : { balance : Nat; failed_burn_amount : Nat; token_symbol : Text; ledger_id : Principal };
            #InsufficientAllowance : { allowance : Nat; failed_burn_amount : Nat; token_symbol : Text; ledger_id : Principal };
            #AmountTooLow : { minimum_burn_amount : Nat; failed_burn_amount : Nat; token_symbol : Text; ledger_id : Principal };
            #TemporarilyUnavailable : Text;
        };
        type WithdrawalReply = { #Err : { #CkErc20LedgerError : { cketh_block_index : Nat; error : LedgerError } } };
        let burn : Nat = 4_294_967_391;
        let refundBlock : Nat = 4_294_967_555;
        let definiteError : LedgerError = #InsufficientFunds({ balance = 0; failed_burn_amount = 1_000; token_symbol = "ckUSDC"; ledger_id = ledger });
        func financialCalls(request : Main.WalletTransferRequestV2, prepared : Main.WalletTransferOperationV2, error : LedgerError) : [ExpectedCall] {
            func approve(target : Principal, amount : Nat, fee : Nat) : ExpectedCall {
                let args : IcrcTypes.ApproveArg = {
                    from_subaccount = null; spender = { owner = minter; subaccount = null }; amount;
                    expected_allowance = null; expires_at = ?(prepared.created_at_ns + 600_000_000_000);
                    fee = ?fee; memo = ?request.request_id; created_at_time = ?prepared.created_at_ns;
                };
                let reply : IcrcTypes.ApproveResult = #Ok(80);
                { request = { canister = target; method = "icrc2_approve"; args = to_candid (args); cycles = 0 }; result = #ok(to_candid (reply)) };
            };
            let price = { gas_limit = 65_000 : Nat; max_fee_per_gas = 1 : Nat; max_priority_fee_per_gas = 1 : Nat; max_transaction_fee = 65_000 : Nat; timestamp = null : ?Nat64 };
            let priceArg : ?{ ckerc20_ledger_id : Principal } = ?{ ckerc20_ledger_id = ledger };
            let args = { amount = 1_000 : Nat; ckerc20_ledger_id = ledger; recipient = address; from_cketh_subaccount = null : ?Blob; from_ckerc20_subaccount = null : ?Blob };
            let reply : WithdrawalReply = #Err(#CkErc20LedgerError({ cketh_block_index = burn; error }));
            [
                { request = { canister = ledger; method = "icrc1_fee"; args = to_candid (); cycles = 0 }; result = #ok(to_candid (10 : Nat)) },
                { request = { canister = minter; method = "eip_1559_transaction_price"; args = to_candid (priceArg); cycles = 0 }; result = #ok(to_candid (price)) },
                { request = { canister = gasLedger; method = "icrc1_fee"; args = to_candid (); cycles = 0 }; result = #ok(to_candid (20 : Nat)) },
                approve(ledger, 1_000, 10), approve(gasLedger, 65_000, 20),
                { request = { canister = minter; method = "withdraw_erc20"; args = to_candid (args); cycles = 0 }; result = #ok(to_candid (reply)) },
            ];
        };
        type Payload = {
            #ReimbursedEthWithdrawal : { withdrawal_id : Nat; reimbursed_amount : Nat; reimbursed_in_block : Nat; transaction_hash : ?Text };
            #UnrelatedFutureEvent : { arbitrary_field : [Text] };
        };
        type Event = { timestamp : Nat64; payload : Payload };
        let unrelated : Event = { timestamp = 42; payload = #UnrelatedFutureEvent({ arbitrary_field = ["irrelevant"] }) };
        func refundAmount(id : Nat, hash : ?Text, amount : Nat) : Event {
            { timestamp = 42; payload = #ReimbursedEthWithdrawal({ withdrawal_id = id; reimbursed_amount = amount; reimbursed_in_block = refundBlock; transaction_hash = hash }) };
        };
        // Definite ledger errors can deduct a fee from the refund. The event
        // amount, not the previously reviewed gas budget, is authoritative.
        func refund(id : Nat, hash : ?Text) : Event { refundAmount(id, hash, 64_980) };
        func page(events : [Event], total : Nat64) : Capabilities.CallResult {
            #ok(to_candid ({ events; total_event_count = total }));
        };
        func eventsCall(start : Nat64, length : Nat64, result : Capabilities.CallResult) : ExpectedCall {
            { request = { canister = minter; method = "get_events"; args = to_candid ({ start; length }); cycles = 0 }; result };
        };
        func tail(total : Nat64) : ExpectedCall { eventsCall(0, 0, page([], total)) };
        func reserved(fixture : Fixture) : Bool {
            Journal.allowanceReserved(fixture.transfers, ledger, minter, null) and Journal.allowanceReserved(fixture.transfers, gasLedger, minter, null);
        };
        func expectRefunded(value : Main.WalletTransferOperationV2) {
            switch (value.status) { case (#rejected(_)) {}; case (_) Runtime.trap("Definite failed asset burn must finish after gas reimbursement") };
            let ?settlement = value.settlement else Runtime.trap("Missing refund settlement");
            switch (settlement.status) {
                case (#failed(message)) {
                    assert (Text.contains(message, #text("64980")));
                    assert (Text.contains(message, #text("4294967555")));
                };
                case (_) Runtime.trap("Gas reimbursement did not produce failed-with-refund settlement");
            };
        };
        func cachedPage(command : TransferMemory.Command, bytes : Blob) : Bool {
            for (step in command.calls.vals()) {
                if (step.canister == minter and step.method == "get_events" and step.outcome == #reply(bytes)) return true;
            };
            false;
        };

        // New commands freeze the pre-withdrawal tail before any fee/approval.
        let fresh = Fixture();
        let freshRequest = request(1);
        let freshApp = Main.Init(fresh.env);
        let beforePrepare = callsMade;
        let freshPrepared = operation(freshApp.wallet_transfer_prepare_v2(freshRequest));
        assert (callsMade == beforePrepare);
        schedule(Array.concat([tail(1_000)], financialCalls(freshRequest, freshPrepared, definiteError)));
        let partial = operation(await* freshApp.wallet_transfer_resume_v2(freshRequest.request_id));
        consumed();
        assert (partial.status == #pending and reserved(fresh));
        assert (messageContains(partial.message, Nat.toText(burn)));
        assert (fresh.command(freshRequest.request_id).calls[0].method == "get_events");

        // A same-amount refund for another withdrawal is not evidence. Even a
        // matching burn must carry null transaction_hash for this partial path.
        schedule([eventsCall(1_000, 100, page([unrelated, refund(burn + 1, null), refund(burn, ?"0xunexpected")], 1_003))]);
        let wrongId = operation(await* freshApp.wallet_transfer_refresh_v2(freshRequest.request_id));
        consumed();
        assert (wrongId.status == #pending and reserved(fresh));
        let matchingPage = page([refund(burn, null)], 1_004);
        schedule([eventsCall(1_003, 100, matchingPage)]);
        let reimbursed = operation(await* freshApp.wallet_transfer_refresh_v2(freshRequest.request_id));
        consumed();
        expectRefunded(reimbursed);
        assert (not reserved(fresh));
        let #ok(matchingBytes) = matchingPage else Runtime.trap("Invalid refund fixture");
        assert (cachedPage(fresh.command(freshRequest.request_id), matchingBytes));
        let recovered = Main.Init(fresh.env);
        let afterRefund = callsMade;
        assert (operation(recovered.wallet_transfer_status_v2(freshRequest.request_id)) == reimbursed);
        assert (operation(await* recovered.wallet_transfer_resume_v2(freshRequest.request_id)) == reimbursed);
        assert (operation(await* recovered.wallet_transfer_refresh_v2(freshRequest.request_id)) == reimbursed);
        ignore operation(recovered.wallet_transfer_acknowledge_v2(freshRequest.request_id));
        assert (Main.Init(fresh.env).wallet_transfers_pending_v2(()) == []);
        assert (callsMade == afterRefund);
        assert (operation(recovered.wallet_transfer_prepare_v2(request(9))).status == #pending);

        // A representative installed Wallet315 command starts with fee, not
        // the new optional event-tail read. Resuming preserves those bytes.
        let legacy = Fixture();
        let legacyRequest = request(2);
        let legacyApp = Main.Init(legacy.env);
        let legacyPrepared = operation(legacyApp.wallet_transfer_prepare_v2(legacyRequest));
        let legacyCalls = financialCalls(legacyRequest, legacyPrepared, definiteError);
        let first = legacyCalls[0];
        let #ok(firstReply) = first.result else Runtime.trap("Invalid legacy fee fixture");
        let legacyStep : TransferMemory.Step = {
            canister = first.request.canister; method = first.request.method; args = first.request.args; cycles = first.request.cycles;
            var outcome = #reply(firstReply);
        };
        legacy.command(legacyRequest.request_id).calls := [legacyStep];
        schedule(Array.tabulate<ExpectedCall>(5, func(index) { legacyCalls[index + 1] }));
        assert (operation(await* Main.Init(legacy.env).wallet_transfer_resume_v2(legacyRequest.request_id)).status == #pending);
        consumed();
        assert (legacy.command(legacyRequest.request_id).calls[0].method == "icrc1_fee");
        let legacyRecovery = Main.Init(legacy.env);
        let newestLegacyPage = page(Array.tabulate<Event>(100, func(index) { if (index == 80) refund(burn + 1, null) else unrelated }), 250);
        schedule([tail(250), eventsCall(150, 100, newestLegacyPage)]);
        assert (operation(await* legacyRecovery.wallet_transfer_refresh_v2(legacyRequest.request_id)).status == #pending);
        consumed();
        assert reserved(legacy);
        let legacyPage = page(Array.tabulate<Event>(100, func(index) { if (index == 80) refund(burn, null) else unrelated }), 250);
        schedule([eventsCall(50, 100, legacyPage)]);
        let legacyRefunded = operation(await* legacyRecovery.wallet_transfer_refresh_v2(legacyRequest.request_id));
        consumed();
        expectRefunded(legacyRefunded);
        assert (not reserved(legacy));

        // An unavailable optional prefix must not block the withdrawal. Its
        // failed step stays frozen; later recovery scans from the current tail.
        let unavailable : Capabilities.CallResult = #err({ code = "unavailable"; message = "optional event tail unavailable" });
        let failedPrefix = Fixture();
        let failedRequest = request(3);
        let failedApp = Main.Init(failedPrefix.env);
        let failedPrepared = operation(failedApp.wallet_transfer_prepare_v2(failedRequest));
        schedule(Array.concat([eventsCall(0, 0, unavailable)], financialCalls(failedRequest, failedPrepared, definiteError)));
        assert (operation(await* failedApp.wallet_transfer_resume_v2(failedRequest.request_id)).status == #pending);
        consumed();
        let prefixOutcome = failedPrefix.command(failedRequest.request_id).calls[0].outcome;
        let fallbackPage = page(Array.tabulate<Event>(75, func(index) { if (index == 60) refund(burn, null) else unrelated }), 75);
        schedule([tail(75), eventsCall(0, 100, fallbackPage)]);
        expectRefunded(operation(await* Main.Init(failedPrefix.env).wallet_transfer_resume_v2(failedRequest.request_id)));
        consumed();
        assert (failedPrefix.command(failedRequest.request_id).calls[0].outcome == prefixOutcome);
        assert (not reserved(failedPrefix));

        // A gas refund cannot prove whether a TemporarilyUnavailable token
        // burn occurred. Preserve that independent uncertainty after reload.
        let ambiguous = Fixture();
        let ambiguousRequest = request(4);
        let ambiguousApp = Main.Init(ambiguous.env);
        let ambiguousPrepared = operation(ambiguousApp.wallet_transfer_prepare_v2(ambiguousRequest));
        schedule(Array.concat([tail(2_000)], financialCalls(ambiguousRequest, ambiguousPrepared, #TemporarilyUnavailable("asset response could not be decoded"))));
        assert (operation(await* ambiguousApp.wallet_transfer_resume_v2(ambiguousRequest.request_id)).status == #pending);
        consumed();
        let ambiguousPage = page([refundAmount(burn, null, 65_000)], 2_001);
        schedule([eventsCall(2_000, 100, ambiguousPage)]);
        let gasRefunded = operation(await* ambiguousApp.wallet_transfer_refresh_v2(ambiguousRequest.request_id));
        consumed();
        assert (gasRefunded.status == #pending and reserved(ambiguous));
        let ?unresolvedSettlement = gasRefunded.settlement else Runtime.trap("Missing partial refund status");
        switch (unresolvedSettlement.status) { case (#unknown(_)) {}; case (_) Runtime.trap("Ambiguous asset burn became terminal after gas refund") };
        let #ok(ambiguousBytes) = ambiguousPage else Runtime.trap("Invalid ambiguous fixture");
        assert (cachedPage(ambiguous.command(ambiguousRequest.request_id), ambiguousBytes));
        let afterAmbiguousRefund = callsMade;
        let reopened = Main.Init(ambiguous.env);
        assert (operation(await* reopened.wallet_transfer_resume_v2(ambiguousRequest.request_id)).status == #pending);
        assert (operation(await* reopened.wallet_transfer_refresh_v2(ambiguousRequest.request_id)).status == #pending);
        ignore operation(reopened.wallet_transfer_acknowledge_v2(ambiguousRequest.request_id));
        assert (reopened.wallet_transfers_pending_v2(()).size() == 1 and reserved(ambiguous));
        switch (reopened.wallet_transfer_prepare_v2(request(8))) {
            case (#err(message)) assert (Text.contains(message, #text("unresolved")));
            case (_) Runtime.trap("Gas refund released an independently ambiguous asset allowance");
        };
        assert (callsMade == afterAmbiguousRefund);
        consumed();
    };
};
