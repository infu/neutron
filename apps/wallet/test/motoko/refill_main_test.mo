import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Error "mo:core/Error";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Capabilities "../../backend/capabilities/Types";
import IcrcTypes "../../backend/icrc1/Types";
import Main "../../backend/main";
import WalletMemory "../../backend/memory/wallet/v1";
import CommandMemory "../../backend/memory/wallet_commands/v1";
import TransferMemory "../../backend/memory/wallet_transfers/v1";
import BridgeMemory "../../backend/memory/wallet_bridge/v1";
import ReplacementMemory "../../backend/memory/wallet_bridge_replacements/v1";
import ProviderMemory "../../backend/memory/wallet_bridge_provider/v1";
import ActivityMemory "../../backend/memory/wallet_bridge_activity/v1";
import RefillMemory "../../backend/memory/wallet_refills/v1";
import Journal "../../backend/refill/Journal";
import Types "../../backend/refill/Types";

persistent actor RefillMain {
    public func boundary() : async () {};

    public func run() : async () {
        let owner = Principal.fromActor(RefillMain);
        let target = Principal.fromText("mxzaz-hqaaa-aaaar-qaada-cai");
        let icp = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
        let cmc = Principal.fromText("rkp4c-7iaaa-aaaaa-aaaca-cai");
        let cyclesLedger = Principal.fromText("um5iw-rqaaa-aaaaq-qaaba-cai");
        type Expected = { canister : Principal; method : Text; result : Capabilities.CallResult };
        func view(value : Types.Result) : Types.View {
            switch (value) { case (#ok(found)) found; case (#err(error)) Runtime.trap(error) };
        };
        func rejected(value : Types.Result) {
            switch (value) { case (#err(_)) {}; case (#ok(_)) assert false };
        };
        func request(id : Nat8, kind : RefillMemory.Kind, recipient : Principal) : Types.Request {
            {
                id = Blob.fromArray(Array.repeat<Nat8>(id, 16)); kind; target = recipient;
                amount = if (kind == #tcycles_topup) 2_000_000_000_000 else 100_000_000;
                icp_fee = 10_000; cycles_fee = 100_000_000; estimated_cycles = 3_000_000_000_000;
            };
        };
        class Fixture(expected : [Expected]) {
            public let memory = RefillMemory.init();
            public var dispatched : [Capabilities.CallRequest] = [];
            public var next = 0;
            public var throwNext = false;
            public var excludedCustody : ?Principal = null;
            public var onNextFee : ?(() -> async* ()) = null;
            func call(input : Capabilities.CallRequest) : async* Capabilities.CallResult {
                assert input.cycles == 0;
                if (next >= expected.size()) Runtime.trap("Unexpected refill call " # input.method);
                let planned = expected[next];
                assert input.canister == planned.canister and input.method == planned.method;
                if (input.method == "icrc1_transfer" or input.method == "withdraw") {
                    var retained = false;
                    for (command in Map.values(memory.commands)) {
                        if (command.source_args == ?input.args or command.forward_args == ?input.args) retained := true;
                    };
                    // Freeze every debit's exact bytes before yielding to the IC.
                    assert retained;
                };
                dispatched := Array.concat(dispatched, [input]);
                next += 1;
                if (input.method == "icrc1_fee") {
                    switch (onNextFee) {
                        case (?callback) { onNextFee := null; await* callback() };
                        case null {};
                    };
                };
                await RefillMain.boundary();
                if (throwNext and input.method != "icrc1_fee") {
                    throwNext := false;
                    throw Error.reject("The debit reply threw after dispatch");
                };
                planned.result;
            };
            let calls : Capabilities.BackendCalls = {
                canister_principal = owner;
                owns_principal = func(canister : Principal) : Bool {
                    excludedCustody != ?canister and (canister == icp or canister == cyclesLedger or canister == cmc);
                };
                can_call = func(canister : Principal, method : Text) : Bool {
                    (canister == icp and (method == "icrc1_transfer" or method == "icrc1_fee")) or
                    (canister == cmc and (method == "notify_top_up" or method == "notify_mint_cycles")) or
                    (canister == cyclesLedger and (method == "withdraw" or method == "icrc1_transfer" or method == "icrc1_fee"));
                };
                call;
                call_batch = func(requests : [Capabilities.CallRequest]) : async* [Capabilities.CallResult] {
                    var result : [Capabilities.CallResult] = [];
                    for (entry in requests.vals()) result := Array.concat(result, [await* call(entry)]);
                    result;
                };
            };
            public let env : Main.AppBackendEnvironment = {
                stable_memory = {
                    wallet = WalletMemory.init(); wallet_commands = CommandMemory.init();
                    wallet_transfers = TransferMemory.init(); wallet_bridge = BridgeMemory.init();
                    wallet_bridge_replacements = ReplacementMemory.init(); wallet_bridge_provider = ProviderMemory.init();
                    wallet_bridge_activity = ActivityMemory.init(); wallet_refills = memory;
                };
                capabilities = { backend_calls = calls };
                app_calls = { contacts = {
                    contacts_discover_v1 = func(_request : Main.DiscoverContactsRequestV1) : Main.DiscoverContactsResultV1 {
                        Runtime.trap("Refills do not call Contacts");
                    };
                } };
            };
        };
        let icpFee : Expected = { canister = icp; method = "icrc1_fee"; result = #ok(to_candid(10_000 : Nat)) };
        let cyclesFee : Expected = { canister = cyclesLedger; method = "icrc1_fee"; result = #ok(to_candid(100_000_000 : Nat)) };
        let lost : Capabilities.CallResult = #err({ code = "response_lost"; message = "No authoritative reply was returned" });
        let paid : IcrcTypes.TransferResult = #Ok(41);
        let duplicatePaid : IcrcTypes.TransferResult = #Err(#Duplicate({ duplicate_of = 41 }));
        let processing : Types.NotifyTopUpResult = #Err(#Processing);
        let toppedUp : Types.NotifyTopUpResult = #Ok(2_970_000_000_000);

        // Recovery is not a substitute for approval. Merely preparing an action
        // does not authorize its first debit through continue.
        let untouched = Fixture([]);
        let unapproved = request(1, #icp_topup, target);
        let preparedApp = Main.Init(untouched.env);
        assert view(preparedApp.wallet_refill_prepare_v1(unapproved)).phase == #prepared;
        rejected(await* preparedApp.wallet_refill_continue_v1(unapproved.id));
        assert untouched.next == 0;

        // Exact method access to ICP/CMC/TCYCLES is insufficient: reserve the
        // whole route before creating the payment block that CMC will settle.
        let custody = Fixture([]);
        let custodyRequest = request(61, #icp_to_tcycles, owner);
        let custodyApp = Main.Init(custody.env);
        let custodyPrepared = view(custodyApp.wallet_refill_prepare_v1(custodyRequest));
        for (principal in [icp, cmc, cyclesLedger].vals()) {
            custody.excludedCustody := ?principal;
            rejected(await* custodyApp.wallet_refill_execute_v1(custodyRequest.id));
            assert custody.next == 0;
            assert view(custodyApp.wallet_refill_status_v1(custodyRequest.id)) == custodyPrepared;
            let ?saved = Map.get(custody.memory.commands, Blob.compare, custodyRequest.id) else Runtime.trap("Missing custody fixture");
            assert saved.source_args == null and saved.source_block == null;
        };
        // Revocation during the fee await must also stop the subsequent ICP
        // debit while retaining the same resumable request and unfrozen args.
        let custodyRace = Fixture([
            icpFee, icpFee,
            { canister = icp; method = "icrc1_transfer"; result = #ok(to_candid(paid)) },
            { canister = cmc; method = "notify_top_up"; result = #ok(to_candid(toppedUp)) },
        ]);
        let custodyRaceRequest = request(62, #icp_topup, target);
        let custodyRaceApp = Main.Init(custodyRace.env);
        ignore view(custodyRaceApp.wallet_refill_prepare_v1(custodyRaceRequest));
        custodyRace.onNextFee := ?(func() : async* () { custodyRace.excludedCustody := ?cmc });
        assert view(await* custodyRaceApp.wallet_refill_execute_v1(custodyRaceRequest.id)).phase == #transfer_pending;
        assert custodyRace.next == 1;
        let ?blockedPayment = Map.get(custodyRace.memory.commands, Blob.compare, custodyRaceRequest.id) else Runtime.trap("Missing blocked payment");
        assert blockedPayment.source_args == null and blockedPayment.source_block == null;
        custodyRace.excludedCustody := null;
        assert view(await* Main.Init(custodyRace.env).wallet_refill_continue_v1(custodyRaceRequest.id)).phase == #complete;
        assert custodyRace.next == 4;
        let savedPrepared = view(preparedApp.wallet_refill_status_v1(unapproved.id));
        assert view(await* preparedApp.wallet_refill_action_v1(#prepare(unapproved))) == savedPrepared;
        rejected(await* preparedApp.wallet_refill_action_v1(#continue_(unapproved.id)));
        switch (preparedApp.wallet_read_v1(#refill_status(unapproved.id))) {
            case (#refill_status(value)) assert view(value) == savedPrepared;
            case (_) assert false;
        };
        switch (preparedApp.wallet_read_v1(#refills({ before = null; limit = 10; pending_only = false }))) {
            case (#refills(page)) assert page.operations == [savedPrepared] and page.next_cursor == null;
            case (_) assert false;
        };
        rejected(preparedApp.wallet_refill_status_v1("missing"));
        assert untouched.next == 0;

        // Refill history pages are stable under timestamp ties and do not
        // bury older unfinished work behind newer completed entries. Prepared
        // reviews remain discoverable without granting payment approval.
        let history = Fixture([]);
        func seed(id : Nat8, createdAt : Int, phase : RefillMemory.Phase) {
            let kind = if (phase == #withdraw_pending) #tcycles_topup else if (phase == #forward_pending) #icp_to_tcycles else #icp_topup;
            let input = request(id, kind, target);
            ignore view(Journal.prepare(history.memory, owner, input, createdAt));
            let ?command = Map.get(history.memory.commands, Blob.compare, input.id) else Runtime.trap("Missing history fixture");
            command.phase := phase;
            command.updated_at := 9_000 - createdAt;
            if (phase == #withdraw_pending) {
                command.duplicate := true;
                command.source_block := ?81;
            };
            if (phase == #forward_pending) {
                command.forward_timestamp := ?1;
                command.forward_args := ?("old exact transfer bytes" : Blob);
            };
        };
        // Deliberately insert equal timestamps in reverse/mixed ID order.
        seed(44, 300, #withdraw_pending);
        seed(50, 400, #complete);
        seed(43, 300, #complete);
        seed(42, 300, #prepared);
        seed(41, 300, #notify_pending);
        seed(45, 200, #stopped);
        seed(48, 100, #forward_pending);
        seed(46, 100, #notify_pending);
        func page(before : ?Types.Cursor, limit : Nat, pendingOnly : Bool) : Types.Page {
            switch (Main.Init(history.env).wallet_read_v1(#refills({ before; limit; pending_only = pendingOnly }))) {
                case (#refills(value)) value;
                case (_) Runtime.trap("Wrong refill page response");
            };
        };
        func ids(values : [Types.View]) : [Nat8] {
            Array.map<Types.View, Nat8>(values, func(value) { Blob.toArray(value.id)[0] });
        };
        let firstPage = page(null, 2, false);
        assert ids(firstPage.operations) == [50, 41];
        assert firstPage.next_cursor == ?{ created_at = 300; id = request(41, #icp_topup, target).id };
        let secondPage = page(firstPage.next_cursor, 2, false);
        assert ids(secondPage.operations) == [42, 43];
        let thirdPage = page(secondPage.next_cursor, 2, false);
        assert ids(thirdPage.operations) == [44, 45];
        let finalPage = page(thirdPage.next_cursor, 2, false);
        assert ids(finalPage.operations) == [46, 48] and finalPage.next_cursor == null;
        assert ids(page(null, 100, false).operations) == [50, 41, 42, 43, 44, 45, 46, 48];
        let pendingPage = page(null, 2, true);
        assert ids(pendingPage.operations) == [41, 42];
        assert pendingPage.operations[1].phase == #prepared and not pendingPage.operations[1].can_continue;
        rejected(await* Main.Init(history.env).wallet_refill_action_v1(#continue_(pendingPage.operations[1].id)));
        assert history.next == 0;
        let olderPendingPage = page(pendingPage.next_cursor, 2, true);
        assert ids(olderPendingPage.operations) == [44, 46];
        assert not olderPendingPage.operations[0].can_continue;
        let oldestPendingPage = page(olderPendingPage.next_cursor, 2, true);
        assert ids(oldestPendingPage.operations) == [48];
        assert oldestPendingPage.next_cursor == null and not oldestPendingPage.operations[0].can_continue;
        assert ids(page(null, 100, true).operations) == [41, 42, 44, 46, 48];
        // A newly created refill cannot enter a continuation of an older page.
        seed(40, 500, #notify_pending);
        assert ids(page(firstPage.next_cursor, 2, false).operations) == [42, 43];
        assert ids(page(null, 2, true).operations) == [40, 41];
        assert page(?{ created_at = 1; id = request(99, #icp_topup, target).id }, 2, true).operations == [];
        assert history.next == 0 and Map.size(history.memory.commands) == 9;

        // ICP payment uncertainty resolves through an exact duplicate receipt.
        // CMC Processing resumes only notify with the original ledger block.
        let recovery = Fixture([
            icpFee,
            { canister = icp; method = "icrc1_transfer"; result = lost },
            { canister = icp; method = "icrc1_transfer"; result = #ok(to_candid(duplicatePaid)) },
            { canister = cmc; method = "notify_top_up"; result = #ok(to_candid(processing)) },
            { canister = cmc; method = "notify_top_up"; result = #ok(to_candid(toppedUp)) },
        ]);
        let refill = request(2, #icp_topup, target);
        let app = Main.Init(recovery.env);
        ignore view(app.wallet_refill_prepare_v1(refill));
        assert view(await* app.wallet_refill_execute_v1(refill.id)).phase == #transfer_pending;
        let restarted = Main.Init(recovery.env);
        rejected(restarted.wallet_refill_prepare_v1({ refill with target = owner }));
        let pending = view(await* restarted.wallet_refill_continue_v1(refill.id));
        assert pending.phase == #notify_pending and pending.source_block == ?41;
        assert recovery.dispatched[1].args == recovery.dispatched[2].args;
        let ?payment : ?IcrcTypes.TransferArg = from_candid recovery.dispatched[1].args else Runtime.trap("Bad ICP payment");
        assert payment.amount == refill.amount and payment.fee == ?10_000 and payment.memo == ?Journal.TOP_UP_MEMO;
        assert payment.to == { owner = cmc; subaccount = ?Journal.principalSubaccount(target) };
        let complete = view(await* Main.Init(recovery.env).wallet_refill_continue_v1(refill.id));
        assert complete.phase == #complete and complete.credited_cycles == ?2_970_000_000_000;
        assert recovery.dispatched[3].args == recovery.dispatched[4].args;
        let ?notify : ?Types.NotifyTopUpArgs = from_candid recovery.dispatched[4].args else Runtime.trap("Bad top-up notification");
        assert notify.block_index == 41 and notify.canister_id == target;
        assert view(await* Main.Init(recovery.env).wallet_refill_continue_v1(refill.id)) == complete;
        assert view(await* Main.Init(recovery.env).wallet_refill_execute_v1(refill.id)) == complete;
        assert recovery.next == 5;

        // A CMC refund is terminal, includes its receipt and never prompts a
        // second payment or notification to the same failed target.
        let refundResult : Types.NotifyTopUpResult = #Err(#Refunded({ reason = "Invalid top-up target"; block_index = ?58 }));
        let refund = Fixture([
            icpFee,
            { canister = icp; method = "icrc1_transfer"; result = #ok(to_candid(paid)) },
            { canister = cmc; method = "notify_top_up"; result = #ok(to_candid(refundResult)) },
        ]);
        let refundRequest = request(3, #icp_topup, target);
        ignore view(Main.Init(refund.env).wallet_refill_prepare_v1(refundRequest));
        let refunded = view(await* Main.Init(refund.env).wallet_refill_execute_v1(refundRequest.id));
        assert refunded.phase == #refunded and refunded.refund_block == ?58 and refunded.credited_cycles == null;
        assert view(await* Main.Init(refund.env).wallet_refill_continue_v1(refundRequest.id)) == refunded;
        assert refund.next == 3;

        // A successful cycles withdraw proves delivery; Duplicate only proves
        // a burn identity. The management call may still fail/refund afterward.
        let withdrawOk : Types.WithdrawResult = #Ok(61);
        let success = Fixture([cyclesFee, { canister = cyclesLedger; method = "withdraw"; result = #ok(to_candid(withdrawOk)) }]);
        let successfulRequest = request(4, #tcycles_topup, target);
        ignore view(await* Main.Init(success.env).wallet_refill_action_v1(#prepare(successfulRequest)));
        let successful = view(await* Main.Init(success.env).wallet_refill_action_v1(#execute(successfulRequest.id)));
        assert successful.phase == #complete and successful.source_block == ?61;
        assert successful.credited_cycles == ?successfulRequest.amount;
        assert view(await* Main.Init(success.env).wallet_refill_action_v1(#continue_(successfulRequest.id))) == successful;
        let duplicateWithdrawal : Types.WithdrawResult = #Err(#Duplicate({ duplicate_of = 62 }));
        let ambiguous = Fixture([
            cyclesFee,
            { canister = cyclesLedger; method = "withdraw"; result = lost },
            { canister = cyclesLedger; method = "withdraw"; result = #ok(to_candid(duplicateWithdrawal)) },
        ]);
        let ambiguousRequest = request(5, #tcycles_topup, target);
        ignore view(Main.Init(ambiguous.env).wallet_refill_prepare_v1(ambiguousRequest));
        assert view(await* Main.Init(ambiguous.env).wallet_refill_execute_v1(ambiguousRequest.id)).phase == #withdraw_pending;
        let duplicate = view(await* Main.Init(ambiguous.env).wallet_refill_continue_v1(ambiguousRequest.id));
        assert duplicate.phase == #withdraw_pending and duplicate.source_block == ?62 and duplicate.duplicate;
        assert duplicate.credited_cycles == null and duplicate.error != null and not duplicate.can_continue;
        assert view(await* Main.Init(ambiguous.env).wallet_refill_continue_v1(ambiguousRequest.id)) == duplicate;
        assert ambiguous.next == 3;
        assert ambiguous.dispatched[1].args == ambiguous.dispatched[2].args;
        let ?withdraw : ?Types.WithdrawArgs = from_candid ambiguous.dispatched[1].args else Runtime.trap("Bad cycles withdrawal");
        assert withdraw.to == target and withdraw.amount == ambiguousRequest.amount and withdraw.created_at_time != null;

        let failedWithdraw : Types.WithdrawResult = #Err(#FailedToWithdraw({ fee_block = ?63; rejection_code = #DestinationInvalid; rejection_reason = "Destination canister does not exist" }));
        let failed = Fixture([cyclesFee, { canister = cyclesLedger; method = "withdraw"; result = #ok(to_candid(failedWithdraw)) }]);
        let failedRequest = request(6, #tcycles_topup, target);
        ignore view(Main.Init(failed.env).wallet_refill_prepare_v1(failedRequest));
        let failedResult = view(await* Main.Init(failed.env).wallet_refill_execute_v1(failedRequest.id));
        assert failedResult.phase == #refunded and failedResult.credited_cycles == null;
        assert view(await* Main.Init(failed.env).wallet_refill_continue_v1(failedRequest.id)) == failedResult;
        assert failed.next == 2;

        // Protocol failures without refund blocks must not masquerade as a
        // refund payment. Tiny amounts can be entirely consumed by fees.
        let noIcpRefund : Types.NotifyTopUpResult = #Err(#Refunded({ reason = "Payment cannot cover the refund fee"; block_index = null }));
        let noRefund = Fixture([
            icpFee,
            { canister = icp; method = "icrc1_transfer"; result = #ok(to_candid(paid)) },
            { canister = cmc; method = "notify_top_up"; result = #ok(to_candid(noIcpRefund)) },
        ]);
        let noRefundRequest = request(16, #icp_topup, target);
        ignore view(Main.Init(noRefund.env).wallet_refill_prepare_v1(noRefundRequest));
        let noRefundView = view(await* Main.Init(noRefund.env).wallet_refill_execute_v1(noRefundRequest.id));
        assert noRefundView.phase == #stopped and noRefundView.refund_block == null and noRefundView.credited_cycles == null;
        assert noRefundView.error != null and not noRefundView.can_continue;
        assert view(await* Main.Init(noRefund.env).wallet_refill_continue_v1(noRefundRequest.id)) == noRefundView;
        assert noRefund.next == 3;
        let noCyclesRefund : Types.WithdrawResult = #Err(#FailedToWithdraw({ fee_block = null; rejection_code = #DestinationInvalid; rejection_reason = "Failed withdrawal did not leave enough for refund fees" }));
        let noCycles = Fixture([cyclesFee, { canister = cyclesLedger; method = "withdraw"; result = #ok(to_candid(noCyclesRefund)) }]);
        let noCyclesRequest = request(17, #tcycles_topup, target);
        ignore view(Main.Init(noCycles.env).wallet_refill_prepare_v1(noCyclesRequest));
        let noCyclesView = view(await* Main.Init(noCycles.env).wallet_refill_execute_v1(noCyclesRequest.id));
        assert noCyclesView.phase == #stopped and noCyclesView.refund_block == null and noCyclesView.credited_cycles == null;
        assert noCyclesView.error != null and not noCyclesView.can_continue;
        assert view(await* Main.Init(noCycles.env).wallet_refill_continue_v1(noCyclesRequest.id)) == noCyclesView;
        assert noCycles.next == 2;

        // Converting ICP to TCYCLES first credits this Neutron's default
        // account. The CMC binds the payment to that owner, even when the final
        // beneficiary differs. The minted amount is gross of the deposit fee.
        let minted : Types.NotifyMintResult = #Ok({ block_index = 71; minted = 3_100_000_000_000; balance = 6_000_000_000_000 });
        let ownMint = Fixture([
            icpFee,
            { canister = icp; method = "icrc1_transfer"; result = #ok(to_candid(paid)) },
            { canister = cmc; method = "notify_mint_cycles"; result = #ok(to_candid(minted)) },
        ]);
        let ownMintRequest = request(7, #icp_to_tcycles, owner);
        ignore view(Main.Init(ownMint.env).wallet_refill_prepare_v1(ownMintRequest));
        let ownMintResult = view(await* Main.Init(ownMint.env).wallet_refill_execute_v1(ownMintRequest.id));
        assert ownMintResult.phase == #complete and ownMintResult.mint_block == ?71;
        assert ownMintResult.minted_cycles == ?3_100_000_000_000 and ownMintResult.credited_cycles == ?3_099_900_000_000;
        assert view(await* Main.Init(ownMint.env).wallet_refill_continue_v1(ownMintRequest.id)) == ownMintResult;
        assert ownMint.next == 3;
        let ?mintPayment : ?IcrcTypes.TransferArg = from_candid ownMint.dispatched[1].args else Runtime.trap("Bad mint payment");
        assert mintPayment.to == { owner = cmc; subaccount = ?Journal.principalSubaccount(owner) };
        assert mintPayment.memo == ?Journal.MINT_MEMO;
        let ?mintNotification : ?Types.NotifyMintArgs = from_candid ownMint.dispatched[2].args else Runtime.trap("Bad mint notification");
        assert mintNotification.block_index == 41 and mintNotification.to_subaccount == null;
        assert mintNotification.deposit_memo == ?ownMintRequest.id;

        let forwarded : IcrcTypes.TransferResult = #Err(#Duplicate({ duplicate_of = 72 }));
        let forward = Fixture([
            icpFee,
            { canister = icp; method = "icrc1_transfer"; result = #ok(to_candid(paid)) },
            { canister = cmc; method = "notify_mint_cycles"; result = #ok(to_candid(minted)) },
            cyclesFee,
            { canister = cyclesLedger; method = "icrc1_transfer"; result = lost },
            { canister = cyclesLedger; method = "icrc1_transfer"; result = #ok(to_candid(forwarded)) },
        ]);
        let forwardRequest = request(8, #icp_to_tcycles, target);
        ignore view(Main.Init(forward.env).wallet_refill_prepare_v1(forwardRequest));
        let forwardPending = view(await* Main.Init(forward.env).wallet_refill_execute_v1(forwardRequest.id));
        assert forwardPending.phase == #forward_pending and forwardPending.mint_block == ?71;
        assert forwardPending.minted_cycles == ?3_100_000_000_000 and forwardPending.credited_cycles == null;
        let forwardComplete = view(await* Main.Init(forward.env).wallet_refill_continue_v1(forwardRequest.id));
        assert forwardComplete.phase == #complete and forwardComplete.forward_block == ?72;
        assert forwardComplete.credited_cycles == ?3_099_800_000_000;
        assert forward.dispatched[4].args == forward.dispatched[5].args;
        let ?forwardArgs : ?IcrcTypes.TransferArg = from_candid forward.dispatched[4].args else Runtime.trap("Bad mint forwarding");
        assert forwardArgs.amount == 3_099_800_000_000 and forwardArgs.fee == ?100_000_000;
        assert forwardArgs.to == { owner = target; subaccount = null } and forwardArgs.memo == ?forwardRequest.id;
        assert view(await* Main.Init(forward.env).wallet_refill_continue_v1(forwardRequest.id)) == forwardComplete;
        assert forward.next == 6;

        // A thrown asynchronous call after dispatch is ambiguous just like a
        // transport error. A later typed rejection cannot erase that history
        // and turn the original potentially successful debit into a fresh one.
        let insufficient : IcrcTypes.TransferResult = #Err(#InsufficientFunds({ balance = 0 }));
        let throwing = Fixture([
            icpFee,
            { canister = icp; method = "icrc1_transfer"; result = lost },
            { canister = icp; method = "icrc1_transfer"; result = #ok(to_candid(insufficient)) },
        ]);
        throwing.throwNext := true;
        let thrownRequest = request(9, #icp_topup, target);
        ignore view(Main.Init(throwing.env).wallet_refill_prepare_v1(thrownRequest));
        assert view(await* Main.Init(throwing.env).wallet_refill_execute_v1(thrownRequest.id)).phase == #transfer_pending;
        let thrownRetry = view(await* Main.Init(throwing.env).wallet_refill_continue_v1(thrownRequest.id));
        assert thrownRetry.phase == #transfer_pending and thrownRetry.source_block == null;
        assert throwing.dispatched[1].args == throwing.dispatched[2].args;
        assert throwing.next == 3;

        // A fee mismatch is caught before a first debit and is definite. An
        // expired exact retry stays unresolved rather than using a new time.
        let changedFee = Fixture([{ canister = icp; method = "icrc1_fee"; result = #ok(to_candid(20_000 : Nat)) }]);
        let changedFeeRequest = request(10, #icp_topup, target);
        ignore view(Main.Init(changedFee.env).wallet_refill_prepare_v1(changedFeeRequest));
        assert view(await* Main.Init(changedFee.env).wallet_refill_execute_v1(changedFeeRequest.id)).phase == #stopped;
        assert changedFee.next == 1;
        let expired = Fixture([]);
        let expiredRequest = request(11, #icp_topup, target);
        ignore view(Main.Init(expired.env).wallet_refill_prepare_v1(expiredRequest));
        let ?expiredCommand = Map.get(expired.memory.commands, Blob.compare, expiredRequest.id) else Runtime.trap("Missing expired command");
        expiredCommand.phase := #transfer_pending;
        expiredCommand.source_args := ?("retained expired args" : Blob);
        expiredCommand.source_timestamp := ?1;
        expiredCommand.source_uncertain := true;
        let expiredView = view(await* Main.Init(expired.env).wallet_refill_continue_v1(expiredRequest.id));
        assert expiredView.phase == #transfer_pending and expiredView.error != null;
        assert expiredCommand.source_args == ?("retained expired args" : Blob) and expiredCommand.source_timestamp == ?1;
        assert expired.next == 0;

        // Overlapping continuation on the same live instance observes progress
        // and does not dispatch an additional fee query, payment or top-up.
        let overlap = Fixture([
            icpFee,
            { canister = icp; method = "icrc1_transfer"; result = #ok(to_candid(paid)) },
            { canister = cmc; method = "notify_top_up"; result = #ok(to_candid(toppedUp)) },
        ]);
        let overlapRequest = request(12, #icp_topup, target);
        let overlapApp = Main.Init(overlap.env);
        ignore view(overlapApp.wallet_refill_prepare_v1(overlapRequest));
        overlap.onNextFee := ?(func() : async* () {
            assert view(await* overlapApp.wallet_refill_continue_v1(overlapRequest.id)).phase == #transfer_pending;
            assert overlap.next == 1;
        });
        assert view(await* overlapApp.wallet_refill_execute_v1(overlapRequest.id)).phase == #complete;
        assert overlap.next == 3;

        // A runtime restored while a fee query is in flight may progress using
        // the same root. An older fee observation cannot erase the newer
        // payment receipt and its still-pending CMC notification.
        let staleFee = Fixture([
            { canister = icp; method = "icrc1_fee"; result = #ok(to_candid(20_000 : Nat)) },
            icpFee,
            { canister = icp; method = "icrc1_transfer"; result = #ok(to_candid(paid)) },
            { canister = cmc; method = "notify_top_up"; result = #ok(to_candid(processing)) },
            { canister = cmc; method = "notify_top_up"; result = #ok(to_candid(toppedUp)) },
        ]);
        let staleRequest = request(13, #icp_topup, target);
        let staleApp = Main.Init(staleFee.env);
        ignore view(staleApp.wallet_refill_prepare_v1(staleRequest));
        staleFee.onNextFee := ?(func() : async* () {
            let progressed = view(await* Main.Init(staleFee.env).wallet_refill_continue_v1(staleRequest.id));
            assert progressed.phase == #notify_pending and progressed.source_block == ?41;
        });
        let staleComplete = view(await* staleApp.wallet_refill_execute_v1(staleRequest.id));
        assert staleComplete.phase == #complete and staleComplete.source_block == ?41;
        assert staleComplete.credited_cycles == ?2_970_000_000_000 and staleFee.next == 5;

        // Separate identical withdrawals are separate financial intents. Their
        // ledger timestamps stay unique across runtime restoration, even though
        // withdraw has no memo field in which to carry the Wallet request ID.
        let secondWithdrawal : Types.WithdrawResult = #Ok(82);
        let distinct = Fixture([
            cyclesFee,
            { canister = cyclesLedger; method = "withdraw"; result = #ok(to_candid(withdrawOk)) },
            cyclesFee,
            { canister = cyclesLedger; method = "withdraw"; result = #ok(to_candid(secondWithdrawal)) },
        ]);
        let distinctA = request(14, #tcycles_topup, target);
        let distinctB = request(15, #tcycles_topup, target);
        ignore view(Main.Init(distinct.env).wallet_refill_prepare_v1(distinctA));
        ignore view(Main.Init(distinct.env).wallet_refill_prepare_v1(distinctB));
        assert view(await* Main.Init(distinct.env).wallet_refill_execute_v1(distinctA.id)).source_block == ?61;
        assert view(await* Main.Init(distinct.env).wallet_refill_execute_v1(distinctB.id)).source_block == ?82;
        let ?withdrawA : ?Types.WithdrawArgs = from_candid distinct.dispatched[1].args else Runtime.trap("Bad first withdrawal");
        let ?withdrawB : ?Types.WithdrawArgs = from_candid distinct.dispatched[3].args else Runtime.trap("Bad second withdrawal");
        assert ({ withdrawA with created_at_time = null } == { withdrawB with created_at_time = null });
        let ?timestampA = withdrawA.created_at_time else Runtime.trap("Missing first timestamp");
        let ?timestampB = withdrawB.created_at_time else Runtime.trap("Missing second timestamp");
        assert timestampB > timestampA and distinct.dispatched[1].args != distinct.dispatched[3].args;


    };
};
