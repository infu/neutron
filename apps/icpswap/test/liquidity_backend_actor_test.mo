import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Error "mo:core/Error";
import Map "mo:core/Map";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Text "mo:core/Text";
import Caps "mo:neutron-capabilities";
import Actions "../backend/icpswap/Actions";
import Client "../backend/icpswap/Client";
import Liquidity "../backend/icpswap/Liquidity";
import Wire "../backend/icpswap/LiquidityClient";
import Math "../backend/icpswap/LiquidityMath";
import Memory "../backend/memory/icpswap_actions/v1";
import Types "../backend/icpswap/Types";

// Real service and journal, compiled to an ephemeral IC actor so all wire
// replies go through actual to_candid/from_candid. No external calls occur.
persistent actor Self {
    public func run() : async Text {
        func ok<T>(value : { #ok : T; #err : Text }) : T {
            switch (value) { case (#ok(v)) v; case (#err(e)) Runtime.trap(e) };
        };
        func present<T>(value : ?T) : T {
            switch (value) { case (?v) v; case null Runtime.trap("Missing fixture value") };
        };
        func failed<T>(value : { #ok : T; #err : Text }) : Bool {
            switch (value) { case (#ok(_)) false; case (#err(_)) true };
        };
        let owner = Principal.fromActor(Self);
        let pool = Principal.fromText("rwlgt-iiaaa-aaaaa-aaaaa-cai");
        let token0 : Types.TokenRef = { address = "ryjl3-tyaaa-aaaaa-aaaba-cai"; standard = "ICRC2" };
        let token1 : Types.TokenRef = { address = "xevnm-gaaaa-aaaar-qafnq-cai"; standard = "ICRC2" };
        let registered : Types.PoolData = {
            canisterId = pool; fee = 3000; key = "fixture-pool"; tickSpacing = 60; token0; token1;
        };
        let position : Wire.PositionWithId = {
            id = 7; tickLower = -60; tickUpper = 120; liquidity = 123456;
            tokensOwed0 = 11; tokensOwed1 = 22;
        };
        let mint : Liquidity.Request = {
            pool = Principal.toText(pool); kind = "mint"; position_id = null;
            tick_lower = -60; tick_upper = 120; amount0 = 1000000; amount1 = 2000000;
            liquidity = 0; withdraw_token = ""; withdraw_amount = 0;
        };
        let fundingJson = "{\"requests\":[\"wallet-funding-0\",\"wallet-funding-1\"]}";
        let fundingResult = "{\"walletFunding\":\"confirmed\",\"requestIds\":[\"wallet-funding-0\",\"wallet-funding-1\"]}";

        class Fixture() {
            public var mismatch = false;
            public var token0Standard = "ICRC2";
            public var fee0 = 10000;
            public var unused0 = 250000;
            public var unused1 = 500000;
            public var positions : [Wire.PositionWithId] = [position];
            public var refreshedPosition : ?Wire.Position = null;
            public var loseMethod = "";
            public var loss = "";
            public var pairAmounts : Wire.Amounts = { amount0 = 444; amount1 = 555 };
            public var requests : [Client.CallRequest] = [];
            public var methods : [Text] = [];
            public var advanceWithdrawal = false;
            public var overlappingPrepare : ?(() -> async* Liquidity.Prepared) = null;
            public var overlappingSaved : ?Liquidity.Prepared = null;
            public var reads = 0;
            public var batches = 0;
            public var batchMethods : [[Text]] = [];
            public var failReadMethod = "";
            public var shortReadBatch = false;
            public var throwReadBatch = false;
            public var reverseReadCompletion = false;
            var memory = Memory.init();
            var timestamp : Int = 100;
            func now() : Int { timestamp += 1; timestamp };
            public var journal = Actions.Journal(memory, now, func(_ : Text) : Bool { false });
            public let id = "fixture-operation";
            public var effectId = id;
            func scalar(value : Nat) : Client.CallResult {
                let result : Wire.PoolResult<Nat> = #ok(value);
                #ok(to_candid(result));
            };
            func response(request : Client.CallRequest) : async* Client.CallResult {
                assert (request.cycles == 0);
                methods := Array.concat(methods, [request.method]);
                if (request.method == failReadMethod) {
                    return #err({ code = "unavailable"; message = "Fixture read unavailable" });
                };
                if (request.method == "getPools") {
                    assert (request.canister == Client.swapFactoryPrincipal());
                    reads += 1;
                    let result : Types.PoolsResult = #ok([{ registered with token0 = { token0 with standard = token0Standard } }]);
                    return #ok(to_candid(result));
                };
                assert (request.canister == pool);
                switch (request.method) {
                    case ("metadata") {
                        reads += 1;
                        let data : Types.PoolMetadata = {
                            fee = 3000; key = registered.key; liquidity = 1000000000;
                            sqrtPriceX96 = Math.Q96; tick = 0;
                            token0 = if (mismatch) token1 else ({ token0 with standard = token0Standard }); token1;
                        };
                        let result : Types.PoolMetadataResult = #ok(data);
                        return #ok(to_candid(result));
                    };
                    case ("getTokenAmountState") Runtime.trap("Unexpected metadata method");
                    case ("getCachedTokenFee") {
                        reads += 1;
                        let fees : Types.CachedTokenFee = { token0Fee = fee0; token1Fee = 10000 };
                        return #ok(to_candid(fees));
                    };
                    case ("getAvailabilityState") {
                        reads += 1;
                        let state : Types.AvailabilityState = { available = true; whiteList = [] };
                        return #ok(to_candid(state));
                    };
                    case ("getUserPositionsByPrincipal") {
                        reads += 1;
                        let account : ?Principal = from_candid(request.args);
                        assert (account == ?owner);
                        let result : Wire.PoolResult<[Wire.PositionWithId]> = #ok(positions);
                        return #ok(to_candid(result));
                    };
                    case ("getUserPosition") {
                        reads += 1;
                        let selected : ?Nat = from_candid(request.args);
                        assert (selected == ?7);
                        let value = switch (refreshedPosition) { case (?value) value; case null positions[0] };
                        let result : Wire.PoolResult<Wire.Position> = #ok({
                            tickLower = value.tickLower; tickUpper = value.tickUpper; liquidity = value.liquidity;
                            tokensOwed0 = value.tokensOwed0; tokensOwed1 = value.tokensOwed1;
                        });
                        return #ok(to_candid(result));
                    };
                    case ("getUserUnusedBalance") {
                        // Model an overlapping invocation finishing while the
                        // first invocation is awaiting a read-only reply.
                        switch (overlappingPrepare) {
                            case (?other) {
                                overlappingPrepare := null;
                                overlappingSaved := ?(await* other());
                            };
                            case null {};
                        };
                        reads += 1;
                        let account : ?Principal = from_candid(request.args);
                        assert (account == ?owner);
                        let result : Types.UnusedBalanceResult = #ok({ balance0 = unused0; balance1 = unused1 });
                        return #ok(to_candid(result));
                    };
                    case ("getUserWithdrawQueue") {
                        reads += 1;
                        assert (Blob.equal(request.args, to_candid()));
                        if (advanceWithdrawal) {
                            let item : Wire.WithdrawQueueItem = {
                                txIndex = 88; caller = owner; token = token0; amount = 100000; fee = 10000;
                                from = { owner = pool; subaccount = null };
                                to = { owner; subaccount = null }; memo = null;
                            };
                            let result : Wire.PoolResult<Wire.WithdrawQueue> = #ok({ items = [item]; token0TotalAmount = 100000; token1TotalAmount = 0 });
                            return #ok(to_candid(result));
                        };
                        let result : Wire.PoolResult<Wire.WithdrawQueue> = #ok({ items = []; token0TotalAmount = 0; token1TotalAmount = 0 });
                        return #ok(to_candid(result));
                    };
                    case ("getTransactionsByOwner") {
                        reads += 1;
                        let account : ?Principal = from_candid(request.args);
                        assert (account == ?owner);
                        if (advanceWithdrawal) {
                            // The queued withdrawal debits the pool's unused
                            // balance before its transaction query completes.
                            // CreditCompleted means this debit already occurred.
                            unused0 := 0;
                            let transaction : Wire.Transaction = {
                                id = 88; timestamp = 100; owner; canisterId = pool;
                                action = #Withdraw({
                                    transfer = {
                                        token = Principal.fromText(token0.address); amount = 100000; fee = 10000;
                                        from = { owner = pool; subaccount = null };
                                        to = { owner; subaccount = null }; index = 88; memo = null; standard = "ICRC2";
                                    };
                                    status = #CreditCompleted; err = null;
                                });
                            };
                            let result : Wire.PoolResult<[(Nat, Wire.Transaction)]> = #ok([(88, transaction)]);
                            return #ok(to_candid(result));
                        };
                        let result : Wire.PoolResult<[(Nat, Wire.Transaction)]> = #ok([]);
                        return #ok(to_candid(result));
                    };
                    case (_) {};
                };
                // Inspect the real durable root before accepting every effect.
                // A save performed after this call would fail this assertion.
                let saved = present(journal.raw(effectId));
                assert (saved.state == "execution_requested");
                if (effectId != id) {
                    let source = present(journal.raw(id));
                    assert (source.effects.size() == 1);
                    assert (source.effects[0].key == "deposit0" and source.effects[0].state == "recovery_reserved");
                    assert (source.effects[0].error == effectId);
                    assert (Blob.equal(source.effects[0].args, request.args));
                };
                var retained = false;
                for (effect in saved.effects.vals()) {
                    if (effect.method == request.method and Blob.equal(effect.args, request.args)) {
                        assert (effect.state == "requested");
                        assert (effect.reply == null and effect.completed_at == null);
                        assert (effect.canister == request.canister);
                        retained := true;
                    };
                };
                assert retained;
                requests := Array.concat(requests, [request]);
                if (request.method == loseMethod) {
                    if (loss == "throw") throw Error.reject("The protocol reply was lost after dispatch.");
                    if (loss == "transport") return #err({ code = "reply_lost"; message = "Effect outcome unknown." });
                    if (loss == "malformed") return #ok(to_candid("unrecognized success shape"));
                    if (loss == "raw_malformed") return #ok(Blob.fromArray([0, 1, 2]));
                    if (loss == "decoded") {
                        let result : Wire.PoolResult<Nat> = #err(#InternalError("ledger reply unknown"));
                        return #ok(to_candid(result));
                    };
                };
                if (request.method == "mint") return scalar(42);
                if (request.method == "deposit") {
                    let args : ?{ token : Text; amount : Nat; fee : Nat } = from_candid(request.args);
                    let deposit = present(args);
                    return scalar(deposit.amount - deposit.fee);
                };
                if (request.method == "depositFrom" or request.method == "deposit" or request.method == "withdraw" or request.method == "increaseLiquidity") return scalar(987);
                if (request.method == "decreaseLiquidity" or request.method == "claim") {
                    let result : Wire.PoolResult<Wire.Amounts> = #ok(pairAmounts);
                    return #ok(to_candid(result));
                };
                Runtime.trap("Unexpected protocol method: " # request.method);
            };
            let calls : Caps.BackendCallsV1 = {
                canister_principal = owner;
                can_call = func(_ : Principal, _ : Text) : Bool { true };
                call = response;
                call_batch = func(batch : [Client.CallRequest]) : async* [Client.CallResult] {
                    batches += 1;
                    batchMethods := Array.concat(batchMethods, [Array.map<Client.CallRequest, Text>(batch, func(request) { request.method })]);
                    if (batch.size() == 1) return [await* response(batch[0])];
                    assert (batch.size() == 6);
                    if (throwReadBatch) throw Error.reject("Fixture batch unavailable");
                    let requests = if (reverseReadCompletion) Array.reverse(batch) else batch;
                    var replies : [Client.CallResult] = [];
                    for (request in requests.vals()) replies := Array.concat(replies, [await* response(request)]);
                    if (shortReadBatch) return [];
                    if (reverseReadCompletion) Array.reverse(replies) else replies;
                };
            };
            public var service = Liquidity.Service(calls, journal, now);
            public func prepare(request : Liquidity.Request) : async* Liquidity.Prepared {
                ok(await* service.prepare({ id; input_json = "original-user-intent"; request }));
            };
            public func fund(prepared : Liquidity.Prepared) : Actions.Operation {
                let waiting = ok(journal.update({ id; expected_revision = prepared.operation.revision;
                    state = "funding_requested"; detail = "Wallet requests saved"; result_json = ""; funding_json = fundingJson }));
                ok(journal.update({ id; expected_revision = waiting.revision;
                    state = "funded"; detail = "Exact Wallet requests confirmed"; result_json = fundingResult; funding_json = fundingJson }));
            };
            public func fundOnlyDirectLeg(prepared : Liquidity.Prepared) : Actions.Operation {
                ok(journal.update({ id; expected_revision = prepared.operation.revision;
                    state = "funding_requested"; detail = "Direct transfer confirmed; the other funding leg was rejected";
                    result_json = "{\"funding0\":{\"requestId\":\"wallet-funding-0\",\"state\":\"transferred\"},\"funding1\":{\"requestId\":\"wallet-funding-1\",\"state\":\"rejected\"}}";
                    funding_json = fundingJson }));
            };
            public func restore() {
                let records = Array.fromIter(Map.values(memory.operations));
                let restored : ?[Memory.Operation] = from_candid(to_candid(records));
                memory := Memory.init();
                for (record in present(restored).vals()) ignore Map.insert(memory.operations, Text.compare, record.id, record);
                journal := Actions.Journal(memory, now, func(_ : Text) : Bool { false });
                service := Liquidity.Service(calls, journal, now);
            };
        };

        let identity = Fixture();
        assert (failed(await* identity.service.preview({ mint with pool = "not-a-principal" })));
        assert (identity.reads == 1 and identity.requests.size() == 0);
        identity.mismatch := true;
        assert (failed(await* identity.service.preview(mint)));
        assert (identity.requests.size() == 0);
        identity.mismatch := false;
        assert (failed(await* identity.service.preview({ mint with kind = "close"; position_id = ?404 })));
        assert (failed(await* identity.service.preview({ mint with tick_lower = -59 })));
        assert (identity.requests.size() == 0);

        // A pool snapshot now takes three dependent rounds: canonical factory,
        // independent pool reads, then the actual unused balance. The broker
        // returns replies in request order even if remote completion differs.
        let batched = Fixture();
        batched.reverseReadCompletion := true;
        let batchedPool = ok(await* batched.service.pool(mint.pool));
        assert (batched.batches == 3 and batched.reads == 8);
        assert (batched.batchMethods == [
            ["getPools"],
            ["metadata", "getCachedTokenFee", "getAvailabilityState", "getUserPositionsByPrincipal", "getUserWithdrawQueue", "getTransactionsByOwner"],
            ["getUserUnusedBalance"],
        ]);
        assert (batchedPool.token0 == token0 and batchedPool.fee0 == 10000);
        assert (batchedPool.positions[0].id == 7 and batchedPool.unused0 == 250000);
        assert (batchedPool.protocol_diagnostics == "" and batched.requests.size() == 0);
        let batchedClose = ok(await* batched.service.preview({ mint with kind = "close"; position_id = ?7 }));
        assert (batched.batches == 7);
        assert (batched.batchMethods[6] == ["getUserPosition"]);
        assert (batchedClose.request.liquidity == position.liquidity);
        assert (batched.requests.size() == 0);

        // Every required pool read retains its failure semantics. A partial or
        // lost batch must not produce a plan or reach unused balances/effects.
        for (method in ["metadata", "getCachedTokenFee", "getAvailabilityState", "getUserPositionsByPrincipal", "getUserWithdrawQueue"].vals()) {
            let unavailable = Fixture();
            unavailable.failReadMethod := method;
            assert (failed(await* unavailable.service.preview(mint)));
            assert (unavailable.batches == 2 and unavailable.requests.size() == 0);
            assert (unavailable.journal.list().size() == 0);
        };
        let shortBatch = Fixture();
        shortBatch.shortReadBatch := true;
        assert (failed(await* shortBatch.service.preview(mint)));
        assert (shortBatch.batches == 2 and shortBatch.requests.size() == 0);
        let lostBatch = Fixture();
        lostBatch.throwReadBatch := true;
        assert (failed(await* lostBatch.service.preview(mint)));
        assert (lostBatch.batches == 2 and lostBatch.requests.size() == 0);

        // Optional transaction diagnostics stay partial: queued balances remain
        // reserved and may not suppress funding when transaction state is lost.
        let partial = Fixture();
        partial.advanceWithdrawal := true;
        partial.unused0 := 100000;
        partial.failReadMethod := "getTransactionsByOwner";
        let partialPool = ok(await* partial.service.pool(mint.pool));
        assert (Text.contains(partialPool.protocol_diagnostics, #text("Fixture read unavailable")));
        assert (partialPool.reserved0 == 100000 and partialPool.unused0 == 100000);
        assert (failed(await* partial.service.preview(mint)));
        let partialClose = ok(await* partial.service.preview({ mint with kind = "close"; position_id = ?7 }));
        assert (partialClose.request.liquidity == position.liquidity and partial.requests.size() == 0);

        // The owner list stores owed amounts without refreshing fee growth.
        // Zero stored fees must carry a noncurrent reason, while the existing
        // selected-position preview exposes its freshly queried fee amounts.
        let feeObservation = Fixture();
        feeObservation.positions := [{ position with tokensOwed0 = 0; tokensOwed1 = 0 }];
        let storedZero = ok(await* feeObservation.service.pool(mint.pool));
        assert (storedZero.positions[0].fees0 == 0 and storedZero.positions[0].fees1 == 0);
        assert (not storedZero.positions[0].fees_current);
        assert (Text.contains(storedZero.positions[0].error, #text("stored owed amounts")));
        assert (Text.contains(storedZero.positions[0].error, #text("not a current fee estimate")));
        assert (Array.filter<Text>(feeObservation.methods, func(method) { method == "getUserPosition" }).size() == 0);
        let currentZero = ok(await* feeObservation.service.preview({ mint with kind = "claim"; position_id = ?7 }));
        assert (currentZero.expected_amount0 == 0 and currentZero.expected_amount1 == 0);
        assert (currentZero.baseline_positions[0].fees_current and currentZero.baseline_positions[0].error == "");
        assert (currentZero.baseline_positions[0].fees0 == 0 and currentZero.baseline_positions[0].fees1 == 0);
        assert (Array.filter<Text>(feeObservation.methods, func(method) { method == "getUserPosition" }).size() == 1);
        feeObservation.refreshedPosition := ?position;
        let earnedFees = ok(await* feeObservation.service.preview({ mint with kind = "claim"; position_id = ?7 }));
        assert (earnedFees.expected_amount0 == 11 and earnedFees.expected_amount1 == 22);
        assert (earnedFees.baseline_positions[0].fees_current and earnedFees.baseline_positions[0].error == "");
        assert (earnedFees.baseline_positions[0].fees0 == 11 and earnedFees.baseline_positions[0].fees1 == 22);
        assert (feeObservation.requests.size() == 0);

        // Reservation and balance queries are separate observations. A payout
        // advancing during the read must not expose its earlier, already spent
        // unused balance as reusable liquidity or suppress required funding.
        let payoutRace = Fixture();
        payoutRace.advanceWithdrawal := true;
        payoutRace.unused0 := 100000;
        let afterDebit = ok(await* payoutRace.service.pool(mint.pool));
        assert (afterDebit.unused0 == 0 and afterDebit.reserved0 == 0);
        assert (afterDebit.queued0 == 100000);
        assert (afterDebit.transactions[0].state == "CreditCompleted");
        assert (payoutRace.methods[payoutRace.methods.size() - 2] == "getTransactionsByOwner");
        assert (payoutRace.methods[payoutRace.methods.size() - 1] == "getUserUnusedBalance");
        payoutRace.unused0 := 100000;
        let fundingAfterDebit = ok(await* payoutRace.service.preview({ mint with amount0 = 100000 }));
        assert (fundingAfterDebit.unused0 == 0 and fundingAfterDebit.funding0 == 100000);
        assert (payoutRace.methods[payoutRace.methods.size() - 2] == "getTransactionsByOwner");
        assert (payoutRace.methods[payoutRace.methods.size() - 1] == "getUserUnusedBalance");
        assert (payoutRace.requests.size() == 0);

        let prepareRace = Fixture();
        prepareRace.overlappingPrepare := ?(func() : async* Liquidity.Prepared {
            ok(await* prepareRace.service.prepare({ id = prepareRace.id; input_json = "original-user-intent"; request = mint }));
        });
        let samePreparation = await* prepareRace.prepare(mint);
        assert (samePreparation == present(prepareRace.overlappingSaved));
        assert (prepareRace.journal.list().size() == 1 and prepareRace.requests.size() == 0);

        let success = Fixture();
        let prepared = await* success.prepare(mint);
        assert (prepared.plan.owner == Principal.toText(owner));
        assert (prepared.plan.token0 == token0 and prepared.plan.token1 == token1);
        assert (prepared.plan.funding0 == 750000 and prepared.plan.funding1 == 1500000);
        assert (prepared.plan.expected_liquidity == 167175499);
        assert (prepared.plan.expected_amount0 == 1000000 and prepared.plan.expected_amount1 == 500750);
        assert (not prepared.plan.price_protection);
        assert (failed(await* success.service.execute({ id = success.id; expected_revision = prepared.operation.revision })));
        assert (success.requests.size() == 0);
        let funded = success.fund(prepared);
        let finished = ok(await* success.service.execute({ id = success.id; expected_revision = funded.revision }));
        assert (success.requests.size() == 3);
        assert (success.requests[0] == Wire.depositFromRequest(pool, token0.address, 750000, 10000));
        assert (success.requests[1] == Wire.depositFromRequest(pool, token1.address, 1500000, 10000));
        type MintWire = { token0 : Text; token1 : Text; fee : Nat; tickLower : Int; tickUpper : Int; amount0Desired : Text; amount1Desired : Text };
        let mintArgs : ?MintWire = from_candid(success.requests[2].args);
        assert (mintArgs == ?{ token0 = token0.address; token1 = token1.address; fee = 3000;
            tickLower = -60; tickUpper = 120; amount0Desired = "1000000"; amount1Desired = "2000000" });
        assert (finished.operation.state == "settlement_pending");
        assert (finished.operation.effects[2].state == "succeeded" and finished.operation.effects[2].result_nat == ?42);
        assert (finished.operation.result_json == fundingResult and finished.operation.funding_json == fundingJson);
        success.restore();
        let restored = present(success.service.status(success.id));
        assert (restored == finished);
        ignore ok(await* success.service.execute({ id = success.id; expected_revision = restored.operation.revision }));
        assert (success.requests.size() == 3);
        let reconciled = ok(await* success.service.reconcile(success.id));
        assert (reconciled.pool.queue.size() == 0);
        assert (reconciled.operation.state == "settlement_pending");
        assert (reconciled.operation.result_json == fundingResult);

        // Every ambiguous deposit outcome stops subsequent deposits/mint and
        // remains non-replayable after a fresh journal/service reconstruction.
        for ((method, loss, effects) in [
            ("depositFrom", "throw", 1), ("depositFrom", "transport", 1),
            ("depositFrom", "decoded", 1), ("depositFrom", "malformed", 1),
            ("depositFrom", "raw_malformed", 1),
            ("mint", "throw", 3), ("mint", "transport", 3), ("mint", "malformed", 3),
            ("mint", "raw_malformed", 3),
        ].vals()) {
            let fixture = Fixture();
            fixture.loseMethod := method; fixture.loss := loss;
            let plan = await* fixture.prepare(mint);
            let funding = fixture.fund(plan);
            let unknown = ok(await* fixture.service.execute({ id = fixture.id; expected_revision = funding.revision }));
            assert (unknown.operation.state == "uncertain");
            assert (fixture.requests.size() == effects);
            assert (unknown.operation.effects[effects - 1].state == "uncertain");
            assert (unknown.operation.result_json == fundingResult);
            fixture.restore();
            let saved = present(fixture.service.status(fixture.id));
            assert (saved == unknown);
            assert (fixture.journal.list()[0] == unknown.operation);
            fixture.loseMethod := "";
            ignore ok(await* fixture.service.execute({ id = fixture.id; expected_revision = saved.operation.revision }));
            let current = ok(await* fixture.service.reconcile(fixture.id));
            assert (current.operation.state == "uncertain" and current.pool.queue.size() == 0);
            assert (fixture.requests.size() == effects);
        };

        // Close captures the approved amount, even if the position increases
        // before execution. A newly larger position must not silently enlarge it.
        let close = Fixture();
        let closing = await* close.prepare({ mint with kind = "close"; position_id = ?7; tick_lower = 0; tick_upper = 0 });
        assert (closing.plan.request.liquidity == 123456);
        assert (closing.plan.request.tick_lower == -60 and closing.plan.request.tick_upper == 120);
        close.positions := [{ position with liquidity = 999999 }];
        let closed = ok(await* close.service.execute({ id = close.id; expected_revision = closing.operation.revision }));
        assert (close.requests.size() == 1 and close.requests[0].method == "decreaseLiquidity");
        let decrease : ?{ positionId : Nat; liquidity : Text } = from_candid(close.requests[0].args);
        assert (decrease == ?{ positionId = 7; liquidity = "123456" });
        assert (closed.operation.effects[0].result_amount0 == ?444 and closed.operation.effects[0].result_amount1 == ?555);
        assert (closed.operation.state == "settlement_pending");
        let closeRead = ok(await* close.service.reconcile(close.id));
        assert (closeRead.pool.queue.size() == 0 and closeRead.operation.state == "settlement_pending");
        // Restore the boundary after the successful reply was retained but
        // before the terminal local summary was saved. A full close may have
        // removed the position; that cannot invalidate its retained success.
        ignore ok(close.journal.mark(close.id, "execution_requested", "summary reply lost", ""));
        close.positions := [];
        close.restore();
        let summaryMissing = present(close.journal.get(close.id));
        let readsBeforeSummary = close.reads;
        let restoredClose = ok(await* close.service.execute({ id = close.id; expected_revision = summaryMissing.revision }));
        assert (restoredClose.operation.state == "settlement_pending");
        assert (close.reads == readsBeforeSummary and close.requests.size() == 1);

        let withdraw = Fixture();
        assert (failed(await* withdraw.service.preview({ mint with kind = "withdraw"; withdraw_token = "foreign-token"; withdraw_amount = 100000 })));
        let withdrawing = await* withdraw.prepare({ mint with kind = "withdraw"; withdraw_token = token0.address; withdraw_amount = 100000 });
        assert (withdrawing.plan.owner == Principal.toText(owner));
        let withdrawn = ok(await* withdraw.service.execute({ id = withdraw.id; expected_revision = withdrawing.operation.revision }));
        assert (withdraw.requests.size() == 1 and withdraw.requests[0].method == "withdraw");
        let withdrawArgs : ?{ token : Text; amount : Nat; fee : Nat } = from_candid(withdraw.requests[0].args);
        assert (withdrawArgs == ?{ token = token0.address; amount = 100000; fee = 10000 });
        // No recipient is exposed in the request: pool withdrawal uses the
        // broker caller, the same owner asserted by all account observations.
        assert (Blob.equal(withdraw.requests[0].args, to_candid({ token = token0.address; amount = 100000 : Nat; fee = 10000 : Nat })));
        assert (withdrawn.operation.state == "settlement_pending");

        // Only the exact successful 0/0 claim reply proves no transfer was
        // scheduled. Nonzero replies and empty queues do not prove settlement.
        for ((amount0, amount1) in [(0, 0), (444, 0), (0, 555)].vals()) {
            let claim = Fixture();
            claim.pairAmounts := { amount0; amount1 };
            let claiming = await* claim.prepare({ mint with kind = "claim"; position_id = ?7 });
            let claimed = ok(await* claim.service.execute({ id = claim.id; expected_revision = claiming.operation.revision }));
            let expected = if (amount0 == 0 and amount1 == 0) "complete" else "settlement_pending";
            assert (claimed.operation.state == expected and claim.requests.size() == 1);
            assert (present(claim.journal.get(claim.id)).state == expected);
            assert (claimed.operation.effects[0].result_amount0 == ?amount0 and claimed.operation.effects[0].result_amount1 == ?amount1);
            // Simulate a release-202 journal and restore with the same typed
            // plan and reply. Reconciliation fixes its local status, no replay.
            ignore ok(claim.journal.mark(claim.id, "settlement_pending", "old generic pending detail", ""));
            claim.restore();
            let observed = present(claim.service.status(claim.id));
            assert (observed.operation.state == expected and observed.plan == claiming.plan);
            let recovered = ok(await* claim.service.reconcile(claim.id));
            assert (recovered.operation.state == expected and recovered.pool.queue.size() == 0);
            assert (present(claim.journal.get(claim.id)).state == expected);
            ignore ok(await* claim.service.execute({ id = claim.id; expected_revision = recovered.operation.revision }));
            assert (claim.requests.size() == 1);
        };

        let unknownClaim = Fixture();
        unknownClaim.pairAmounts := { amount0 = 0; amount1 = 0 };
        unknownClaim.loseMethod := "claim"; unknownClaim.loss := "throw";
        let unknownPlan = await* unknownClaim.prepare({ mint with kind = "claim"; position_id = ?7 });
        let unresolvedClaim = ok(await* unknownClaim.service.execute({ id = unknownClaim.id; expected_revision = unknownPlan.operation.revision }));
        assert (unresolvedClaim.operation.state == "uncertain");
        assert ((ok(await* unknownClaim.service.reconcile(unknownClaim.id))).operation.state == "uncertain");
        assert (unknownClaim.requests.size() == 1);

        // Recover a direct-funded pool subaccount after only that Wallet leg
        // succeeded. Recovery credits the exact original gross transfer using
        // the current fee; it must not request another Wallet transfer or mint.
        let recovery = Fixture();
        recovery.token0Standard := "ICRC1";
        let recoverySource = await* recovery.prepare(mint);
        let partlyFunded = recovery.fundOnlyDirectLeg(recoverySource);
        assert (partlyFunded.state == "funding_requested");
        recovery.fee0 := 20000;
        assert (failed(await* recovery.service.execute({ id = recovery.id; expected_revision = partlyFunded.revision })));
        assert (recovery.requests.size() == 0);
        let recover = ok(await* recovery.service.recoveryPrepare({ id = "recover-0"; input_json = "recover original token0 transfer"; source_id = recovery.id; token_index = 0 }));
        assert (recover.plan.source_id == recovery.id and recover.plan.token_index == 0);
        assert (recover.plan.pool == mint.pool and recover.plan.owner == Principal.toText(owner));
        assert (recover.plan.token == { token0 with standard = "ICRC1" });
        assert (recover.plan.gross_amount == 760000 and recover.plan.fee == 20000 and recover.plan.credit_amount == 740000);
        assert (recover.operation.funding_json == "");
        recovery.effectId := "recover-0";
        let recovered = ok(await* recovery.service.recoveryExecute({ id = "recover-0"; expected_revision = recover.operation.revision }));
        assert (recovered.operation.state == "protocol_complete");
        assert (recovered.operation.effects[0].result_nat == ?740000);
        assert (recovery.requests.size() == 1 and recovery.requests[0].method == "deposit");
        assert (recovery.requests[0] == Wire.depositRequest(pool, token0.address, 760000, 20000));
        let reservedSource = present(recovery.service.status(recovery.id));
        assert (reservedSource.operation.state == "stopped");
        assert (reservedSource.operation.effects.size() == 1);
        assert (reservedSource.operation.effects[0].key == "deposit0" and reservedSource.operation.effects[0].state == "recovered");
        assert (reservedSource.operation.funding_json == partlyFunded.funding_json and reservedSource.operation.result_json == partlyFunded.result_json);
        recovery.restore();
        assert (present(recovery.service.recoveryStatus("recover-0")) == recovered);
        ignore ok(await* recovery.service.recoveryExecute({ id = "recover-0"; expected_revision = recovered.operation.revision }));
        assert (failed(await* recovery.service.recoveryPrepare({ id = "recover-duplicate"; input_json = "second ID, same transfer"; source_id = recovery.id; token_index = 0 })));
        let sourceAfterRestore = present(recovery.service.status(recovery.id));
        ignore await* recovery.service.execute({ id = recovery.id; expected_revision = sourceAfterRestore.operation.revision });
        assert (recovery.requests.size() == 1);

        // A changed recovery fee is a known pre-dispatch failure: a new quote
        // may use a new recovery ID because neither source nor target was sent.
        let changedFee = Fixture();
        changedFee.token0Standard := "ICRC1";
        let feeSource = await* changedFee.prepare(mint);
        let fullyFunded = changedFee.fund(feeSource);
        changedFee.fee0 := 15000;
        assert (failed(await* changedFee.service.execute({ id = changedFee.id; expected_revision = fullyFunded.revision })));
        let oldRecovery = ok(await* changedFee.service.recoveryPrepare({ id = "fee-old"; input_json = "fee 15000"; source_id = changedFee.id; token_index = 0 }));
        changedFee.fee0 := 20000;
        assert (failed(await* changedFee.service.recoveryExecute({ id = "fee-old"; expected_revision = oldRecovery.operation.revision })));
        assert (changedFee.requests.size() == 0 and present(changedFee.journal.get(changedFee.id)).effects.size() == 0);
        assert (present(changedFee.service.recoveryStatus("fee-old")).operation.effects.size() == 0);
        let newRecovery = ok(await* changedFee.service.recoveryPrepare({ id = "fee-new"; input_json = "fee 20000"; source_id = changedFee.id; token_index = 0 }));
        assert (newRecovery.plan.gross_amount == 760000 and newRecovery.plan.fee == 20000);
        changedFee.effectId := "fee-new";
        ignore ok(await* changedFee.service.recoveryExecute({ id = "fee-new"; expected_revision = newRecovery.operation.revision }));
        assert (changedFee.requests.size() == 1);
        // The earlier reviewed quote cannot draw the same subaccount later,
        // even if its old fee becomes current again.
        changedFee.fee0 := 15000;
        ignore await* changedFee.service.recoveryExecute({ id = "fee-old"; expected_revision = oldRecovery.operation.revision });
        assert (changedFee.requests.size() == 1);

        for (loss in ["throw", "transport", "decoded", "malformed", "raw_malformed"].vals()) {
            let unknownRecovery = Fixture();
            unknownRecovery.token0Standard := "ICRC1";
            let source = await* unknownRecovery.prepare(mint);
            ignore unknownRecovery.fundOnlyDirectLeg(source);
            unknownRecovery.fee0 := 20000;
            let first = ok(await* unknownRecovery.service.recoveryPrepare({ id = "recovery-first"; input_json = "first recovery"; source_id = unknownRecovery.id; token_index = 0 }));
            // Both previews may exist before either dispatches. The source key
            // still must permit only one of them to send the deposit.
            let rival = ok(await* unknownRecovery.service.recoveryPrepare({ id = "recovery-rival"; input_json = "rival recovery"; source_id = unknownRecovery.id; token_index = 0 }));
            unknownRecovery.effectId := "recovery-first";
            unknownRecovery.loseMethod := "deposit"; unknownRecovery.loss := loss;
            let unknown = ok(await* unknownRecovery.service.recoveryExecute({ id = "recovery-first"; expected_revision = first.operation.revision }));
            assert (unknown.operation.state == "uncertain" and unknown.operation.effects[0].state == "uncertain");
            assert (unknownRecovery.requests.size() == 1);
            let blockedSource = present(unknownRecovery.service.status(unknownRecovery.id));
            assert (blockedSource.operation.effects[0].state == "recovery_reserved");
            unknownRecovery.restore();
            assert (present(unknownRecovery.service.recoveryStatus("recovery-first")) == unknown);
            assert (unknownRecovery.journal.list().size() == 3);
            unknownRecovery.loseMethod := "";
            ignore ok(await* unknownRecovery.service.recoveryExecute({ id = "recovery-first"; expected_revision = unknown.operation.revision }));
            assert (failed(await* unknownRecovery.service.recoveryExecute({ id = "recovery-rival"; expected_revision = rival.operation.revision })));
            assert (failed(await* unknownRecovery.service.recoveryPrepare({ id = "recovery-third"; input_json = "another recovery"; source_id = unknownRecovery.id; token_index = 0 })));
            // Restore the original fee so this assertion reaches the retained
            // reservation, rather than only stopping at the fee-change check.
            unknownRecovery.fee0 := 10000;
            let original = present(unknownRecovery.service.status(unknownRecovery.id));
            ignore await* unknownRecovery.service.execute({ id = unknownRecovery.id; expected_revision = original.operation.revision });
            assert (unknownRecovery.requests.size() == 1);
        };
        "liquidity service preserves canonical plans, funding and non-replayable effects";
    };
};
