import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Map "mo:core/Map";
import Nat "mo:core/Nat";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Bridge "../../backend/bridge/Journal";
import Memory "../../backend/memory/wallet_bridge/v1";
import ReplacementMemory "../../backend/memory/wallet_bridge_replacements/v1";
import Capabilities "../../backend/capabilities/Types";
import Minter "../../backend/bridge/Minter";
import Ledger "../../backend/bridge/Ledger";

// Compile and execute in the IC runtime: the fixture exchanges actual Candid
// and suspends at an actor await before exposing each delayed response.
persistent actor {
    public func tick() : async () {};

    public func run() : async () {
        func ok<T>(result : Bridge.Result<T>) : T {
            switch (result) { case (#ok(value)) value; case (#err(error)) Runtime.trap(error) };
        };
        func err<T>(result : Bridge.Result<T>) : Bool {
            switch (result) { case (#err(_)) true; case (_) false };
        };
        func id(value : Nat8) : Blob { Blob.fromArray(Array.tabulate<Nat8>(16, func(_) { value })) };
        let owner = Principal.fromText("aaaaa-aa");
        let ledger = Principal.fromText("xevnm-gaaaa-aaaar-qafnq-cai");
        let address = "0x1111111111111111111111111111111111111111";
        let helper = "0x2222222222222222222222222222222222222222";
        let token = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
        let a = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let b = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        let c = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
        let d = "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
        let e = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
        let info : Minter.Info = {
            minter_address = ?address;
            smart_contract_address = null;
            eth_helper_contract_address = null;
            erc20_helper_contract_address = null;
            deposit_with_subaccount_helper_contract_address = ?helper;
            supported_ckerc20_tokens = ?[{ erc20_contract_address = token; ledger_canister_id = ledger }];
            cketh_ledger_id = ?Principal.fromText("ss2fx-dyaaa-aaaar-qacoq-cai");
        };
        func mintEvents(hash : Text) : [Minter.Event] { [
            { timestamp = 0; payload = ?#AcceptedErc20Deposit({ transaction_hash = hash; block_number = 100; log_index = 3; from_address = address; value = 42; principal = owner; subaccount = null; erc20_contract_address = token }) },
            { timestamp = 1; payload = ?#MintedCkErc20({ event_source = { transaction_hash = hash; log_index = 3 }; erc20_contract_address = token; mint_block_index = 999 }) },
        ] };
        func ledgerReply(amount : Nat) : Ledger.Reply {
            let block : Ledger.Value = #Map([
                ("btype", #Text("1mint")),
                ("tx", #Map([("amt", #Nat(amount)), ("to", #Array([#Blob(Principal.toBlob(owner))]))])),
            ]);
            { blocks = [{ id = 999; block }]; archived_blocks = [] };
        };
        class Fixture() {
            public let memory = Memory.init();
            public let replacements = ReplacementMemory.init();
            public var events : [Minter.Event] = [];
            public var blockAmount : Nat = 42;
            public var eventsFailure = false;
            public var ledgerQueries = 0;
            public var onEventsReply : () -> () = func() {};
            public var onLedgerReply : () -> () = func() {};
            public let calls : Capabilities.BackendCalls = {
                canister_principal = owner;
                owns_principal = func(_ : Principal) : Bool { true };
                can_call = func(_ : Principal, _ : Text) { true };
                call = func(request : Capabilities.CallRequest) : async* Capabilities.CallResult {
                    switch (request.method) {
                        case ("get_minter_info") #ok(to_candid (info));
                        case ("get_events") {
                            let args = switch (from_candid request.args : ?{ start : Nat64; length : Nat64 }) {
                                case (?value) value;
                                case null Runtime.trap("Invalid get_events arguments");
                            };
                            let start = Nat64.toNat(args.start);
                            let count = if (start >= events.size()) 0 else Nat.min(Nat64.toNat(args.length), events.size() - start);
                            let selected = Array.tabulate<Minter.Event>(count, func(index) { events[start + index] });
                            let reply : Capabilities.CallResult = if (eventsFailure) #err({ code = "unavailable"; message = "Old event response failed" }) else #ok(to_candid ({ events = selected; total_event_count = Nat64.fromNat(events.size()) } : Minter.Events));
                            await tick();
                            let hook = onEventsReply;
                            onEventsReply := func() {};
                            hook();
                            reply;
                        };
                        case ("icrc3_get_blocks") {
                            ledgerQueries += 1;
                            let reply : Capabilities.CallResult = #ok(to_candid (ledgerReply(blockAmount)));
                            await tick();
                            let hook = onLedgerReply;
                            onLedgerReply := func() {};
                            hook();
                            reply;
                        };
                        case (_) Runtime.trap("Unexpected replacement fixture call");
                    };
                };
                call_batch = func(_ : [Capabilities.CallRequest]) : async* [Capabilities.CallResult] { Runtime.trap("Unexpected batch") };
            };
            public let service = Bridge.ServiceWithReplacements(memory, replacements, calls);
            public func prepare(value : Nat8) : async* Bridge.Intent {
                ok(await* service.prepare({ id = id(value); ledger; source = #external; account = address; amount = 42; subaccount = null }));
            };
            public func submit(intent : Bridge.Intent, step : Memory.StepKind, hash : Text) : Bridge.Intent {
                let claimed = ok(service.claim({ id = intent.id; revision = intent.revision; step; operation_id = null }));
                ok(service.recordStep({ id = intent.id; revision = claimed.revision; step; transaction_hash = ?hash; state = #submitted; error = null }));
            };
        };

        // Replacing a deposit discards the old transaction's event cursor and
        // incomplete proof, while preserving its immutable public operation hash.
        let first = Fixture();
        let original = first.submit(await* first.prepare(1), #deposit, a);
        first.events := mintEvents(a);
        first.blockAmount := 43;
        let wrongLedger = ok(await* first.service.refresh({ id = original.id; event_page_length = 100 }));
        assert wrongLedger.event_cursor == 2;
        assert wrongLedger.accepted_deposit != null and wrongLedger.mint != null and wrongLedger.error != null;
        let replaceB = { id = original.id; revision = wrongLedger.revision; step = #deposit; original_transaction_hash = a; previous_transaction_hash = a; transaction_hash = b; state = #confirmed; error = null };
        let replaced = ok(first.service.recordReplacement(replaceB));
        assert replaced.steps[2].transaction_hash == ?a;
        assert replaced.steps[2].state == #confirmed;
        assert first.service.effectiveHash(original.id, #deposit) == ?b;
        assert replaced.event_cursor == 0 and replaced.accepted_deposit == null and replaced.mint == null and replaced.error == null;
        assert replaced.revision == wrongLedger.revision + 1;
        // A lost update reply reloads status before retrying. Stale CAS is
        // rejected; replay at the current revision neither appends nor rewinds.
        assert err(first.service.recordReplacement(replaceB));
        assert ok(first.service.recordReplacement({ replaceB with revision = replaced.revision })) == replaced;
        let firstAncestry = switch (Map.get(first.replacements.replacements, Blob.compare, original.id)) { case (?value) value; case null Runtime.trap("Missing replacement ancestry") };
        assert firstAncestry.size() == 1;
        assert firstAncestry[0].original_transaction_hash == a and firstAncestry[0].previous_transaction_hash == a and firstAncestry[0].transaction_hash == b;
        assert err(first.service.recordReplacement({ replaceB with transaction_hash = c }));
        assert err(first.service.recordReplacement({ replaceB with revision = replaced.revision; transaction_hash = c }));
        assert err(first.service.recordReplacement({ replaceB with revision = replaced.revision; original_transaction_hash = b; previous_transaction_hash = b; transaction_hash = c }));
        let ignoredOld = ok(await* first.service.refresh({ id = original.id; event_page_length = 100 }));
        assert ignoredOld.accepted_deposit == null and ignoredOld.mint == null;
        assert ignoredOld.event_cursor == 2 and first.ledgerQueries == 1;
        first.events := Array.concat(mintEvents(a), mintEvents(b));
        first.blockAmount := 42;
        let complete = ok(await* first.service.refresh({ id = original.id; event_page_length = 100 }));
        assert complete.steps[2].transaction_hash == ?a;
        assert complete.event_cursor == 4;
        assert complete.mint == ?{ ledger_block_index = 999; event_index = 3; verified_ledger = true };
        assert first.ledgerQueries == 2;
        assert ok(first.service.recordReplacement({ replaceB with revision = complete.revision })) == complete;

        // Both roots survive service restoration. Ancestry is durable data;
        // no transient map is allowed to determine the effective transaction.
        let retainedMemory : Memory.Mem = first.memory;
        let retainedReplacements : ReplacementMemory.Mem = first.replacements;
        let restored = Bridge.ServiceWithReplacements(retainedMemory, retainedReplacements, first.calls);
        assert ok(restored.status(original.id)) == complete;
        assert restored.effectiveHash(original.id, #deposit) == ?b;
        assert ok(restored.recordReplacement({ replaceB with revision = complete.revision })) == complete;
        assert Map.get(retainedReplacements.replacements, Blob.compare, original.id) == ?firstAncestry;

        // More than one replacement retains every ancestor. Originals,
        // historical replacements and the current hash each identify one step.
        let lineage = Fixture();
        let lineageOriginal = lineage.submit(await* lineage.prepare(2), #deposit, a);
        let lineageB = ok(lineage.service.recordReplacement({ id = lineageOriginal.id; revision = lineageOriginal.revision; step = #deposit; original_transaction_hash = a; previous_transaction_hash = a; transaction_hash = b; state = #submitted; error = null }));
        let lineageC = ok(lineage.service.recordReplacement({ id = lineageOriginal.id; revision = lineageB.revision; step = #deposit; original_transaction_hash = a; previous_transaction_hash = b; transaction_hash = c; state = #confirmed; error = null }));
        assert lineageC.steps[2].transaction_hash == ?a;
        assert lineage.service.effectiveHash(lineageOriginal.id, #deposit) == ?c;
        let ancestry = switch (Map.get(lineage.replacements.replacements, Blob.compare, lineageOriginal.id)) { case (?value) value; case null Runtime.trap("Missing multi-replacement ancestry") };
        assert ancestry.size() == 2;
        assert ancestry[0].transaction_hash == b and ancestry[1].previous_transaction_hash == b and ancestry[1].transaction_hash == c;
        assert err(lineage.service.recordReplacement({ id = lineageOriginal.id; revision = lineageC.revision; step = #deposit; original_transaction_hash = a; previous_transaction_hash = c; transaction_hash = b; state = #submitted; error = null }));
        let competing = lineage.submit(await* lineage.prepare(3), #deposit, d);
        let unrecorded = await* lineage.prepare(4);
        let unrecordedClaim = ok(lineage.service.claim({ id = unrecorded.id; revision = unrecorded.revision; step = #deposit; operation_id = null }));
        for (reserved in [a, b, c].vals()) {
            assert err(lineage.service.recordReplacement({ id = competing.id; revision = competing.revision; step = #deposit; original_transaction_hash = d; previous_transaction_hash = d; transaction_hash = reserved; state = #submitted; error = null }));
            assert err(lineage.service.recordStep({ id = unrecorded.id; revision = unrecordedClaim.revision; step = #deposit; transaction_hash = ?reserved; state = #submitted; error = null }));
        };
        assert err(lineage.service.recordStep({ id = unrecorded.id; revision = unrecordedClaim.revision; step = #deposit; transaction_hash = ?"0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"; state = #submitted; error = null }));
        assert ok(lineage.service.status(competing.id)) == competing;
        assert ok(lineage.service.status(unrecorded.id)) == unrecordedClaim;

        // The same reservation holds across distinct steps of a single intent.
        let steps = Fixture();
        let reset = steps.submit(await* steps.prepare(5), #reset_approval, a);
        let resetB = ok(steps.service.recordReplacement({ id = reset.id; revision = reset.revision; step = #reset_approval; original_transaction_hash = a; previous_transaction_hash = a; transaction_hash = b; state = #confirmed; error = null }));
        let approval = ok(steps.service.claim({ id = reset.id; revision = resetB.revision; step = #approval; operation_id = null }));
        for (reserved in [a, b].vals()) {
            assert err(steps.service.recordStep({ id = reset.id; revision = approval.revision; step = #approval; transaction_hash = ?reserved; state = #submitted; error = null }));
        };
        let approvalD = ok(steps.service.recordStep({ id = reset.id; revision = approval.revision; step = #approval; transaction_hash = ?d; state = #submitted; error = null }));
        for (reserved in [a, b].vals()) {
            assert err(steps.service.recordReplacement({ id = reset.id; revision = approvalD.revision; step = #approval; original_transaction_hash = d; previous_transaction_hash = d; transaction_hash = reserved; state = #submitted; error = null }));
        };
        let approvalE = ok(steps.service.recordReplacement({ id = reset.id; revision = approvalD.revision; step = #approval; original_transaction_hash = d; previous_transaction_hash = d; transaction_hash = e; state = #confirmed; error = null }));
        assert steps.service.effectiveHash(reset.id, #reset_approval) == ?b;
        assert steps.service.effectiveHash(reset.id, #approval) == ?e;
        assert approvalE.steps[0].transaction_hash == ?a and approvalE.steps[1].transaction_hash == ?d;

        // A refresh suspended on the old hash cannot restore its accepted
        // event, mint or error after replacement. Both cursors are deliberately
        // zero so a cursor-only race guard cannot accidentally pass this test.
        for (oldReplyFails in [false, true].vals()) {
            let overlap = Fixture();
            let before = overlap.submit(await* overlap.prepare(6), #deposit, a);
            overlap.events := mintEvents(a);
            overlap.eventsFailure := oldReplyFails;
            overlap.onEventsReply := func() {
                ignore ok(overlap.service.recordReplacement({ id = before.id; revision = before.revision; step = #deposit; original_transaction_hash = a; previous_transaction_hash = a; transaction_hash = b; state = #submitted; error = null }));
            };
            let after = ok(await* overlap.service.refresh({ id = before.id; event_page_length = 100 }));
            assert overlap.service.effectiveHash(before.id, #deposit) == ?b;
            assert after.revision == before.revision + 1;
            assert after.event_cursor == 0 and after.accepted_deposit == null and after.mint == null and after.error == null;
            assert overlap.ledgerQueries == 0;
        };
        // Also cover replacement while the exact IC mint block is in flight;
        // neither a successful nor a failed old verification can commit later.
        for (oldBlockAmount in ([42, 43] : [Nat]).vals()) {
            let overlap = Fixture();
            let before = overlap.submit(await* overlap.prepare(7), #deposit, a);
            overlap.events := mintEvents(a);
            overlap.blockAmount := oldBlockAmount;
            overlap.onLedgerReply := func() {
                let latest = ok(overlap.service.status(before.id));
                ignore ok(overlap.service.recordReplacement({ id = before.id; revision = latest.revision; step = #deposit; original_transaction_hash = a; previous_transaction_hash = a; transaction_hash = b; state = #submitted; error = null }));
            };
            let after = ok(await* overlap.service.refresh({ id = before.id; event_page_length = 100 }));
            assert overlap.service.effectiveHash(before.id, #deposit) == ?b;
            assert after.event_cursor == 0 and after.accepted_deposit == null and after.mint == null and after.error == null;
            assert after.steps[2].transaction_hash == ?a and after.steps[2].state == #submitted;
        };
    };
};
