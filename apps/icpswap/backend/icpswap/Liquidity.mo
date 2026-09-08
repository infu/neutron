// ICPSwap v3 owner liquidity operations. All protocol traffic uses the existing
// broker; token-ledger access and funding remain Wallet responsibilities.
import Array "mo:core/Array";
import Error "mo:core/Error";
import Principal "mo:core/Principal";
import Capabilities "mo:neutron-capabilities";
import Actions "./Actions";
import Client "./Client";
import LiquidityClient "./LiquidityClient";
import Math "./LiquidityMath";
import Types "./Types";
module {
    public type Result<T> = { #ok : T; #err : Text };
    public type Request = {
        pool : Text; kind : Text; position_id : ?Nat; tick_lower : Int; tick_upper : Int;
        amount0 : Nat; amount1 : Nat; liquidity : Nat; withdraw_token : Text; withdraw_amount : Nat;
    };
    public type Position = {
        id : Nat; tick_lower : Int; tick_upper : Int; liquidity : Nat;
        amount0 : Nat; amount1 : Nat; fees0 : Nat; fees1 : Nat;
        fees_current : Bool; error : Text;
    };
    public type QueueItem = {
        transaction_id : Nat; token : Text; amount : Nat; fee : Nat; recipient : Text;
    };
    public type Transaction = {
        id : Nat; kind : Text; state : Text; token : ?Text; amount : Nat; error : Text;
        unused_reserved : Bool; support_required : Bool;
    };
    public type PoolView = {
        pool : Text; key : Text; owner : Text; token0 : Types.TokenRef; token1 : Types.TokenRef;
        fee : Nat; tick_spacing : Int; tick : Int; sqrt_price_x96 : Nat; liquidity : Nat;
        fee0 : Nat; fee1 : Nat; available : Bool; unused0 : Nat; unused1 : Nat;
        queued0 : Nat; queued1 : Nat; positions : [Position]; queue : [QueueItem];
        reserved0 : Nat; reserved1 : Nat; transactions : [Transaction];
        protocol_diagnostics : Text; observed_at : Int;
    };
    public type Plan = {
        request : Request; pool : Text; owner : Text; token0 : Types.TokenRef; token1 : Types.TokenRef;
        fee : Nat; tick_spacing : Int; tick : Int; sqrt_price_x96 : Nat;
        fee0 : Nat; fee1 : Nat; funding0 : Nat; funding1 : Nat;
        expected_amount0 : Nat; expected_amount1 : Nat; expected_liquidity : Nat;
        unused0 : Nat; unused1 : Nat; baseline_positions : [Position]; observed_at : Int;
        price_protection : Bool; detail : Text;
    };
    public type PrepareRequest = { id : Text; input_json : Text; request : Request };
    public type ExecuteRequest = { id : Text; expected_revision : Nat };
    public type Prepared = { operation : Actions.Operation; plan : Plan };
    public type Reconciliation = { operation : Actions.Operation; plan : Plan; pool : PoolView };
    public type RecoveryPrepareRequest = { id : Text; input_json : Text; source_id : Text; token_index : Nat };
    public type RecoveryPlan = {
        source_id : Text; token_index : Nat; pool : Text; owner : Text; token : Types.TokenRef;
        gross_amount : Nat; fee : Nat; credit_amount : Nat; observed_at : Int;
    };
    public type RecoveryPrepared = { operation : Actions.Operation; plan : RecoveryPlan };

    func subtract(a : Nat, b : Nat) : Nat = if (a > b) a - b else 0;
    func sameToken(a : Types.TokenRef, b : Types.TokenRef) : Bool = a.address == b.address and a.standard == b.standard;
    func outcome<T>(result : LiquidityClient.Outcome<T>) : Result<T> {
        switch (result) { case (#ok(v)) #ok(v); case (#rejected(e)) #err(e); case (#unknown(e)) #err(e) };
    };
    public class Service(calls : Capabilities.BackendCallsV1, journal : Actions.Journal, now : () -> Int) {
        func call(request : Client.CallRequest) : async* Result<Client.CallResult> {
            try {
                let replies = await* calls.call_batch([request]);
                if (replies.size() != 1) return #err("The protocol returned no usable reply.");
                #ok(replies[0]);
            } catch (error) { #err(Error.message(error)) };
        };
        public func pools() : async* Result<[Types.PoolData]> {
            switch (await* call(Client.poolsRequest(Client.swapFactoryPrincipal()))) {
                case (#err(e)) #err(e); case (#ok(reply)) Client.decodePools(reply);
            };
        };
        func verified(poolText : Text) : async* Result<Types.PoolData> {
            switch (await* pools()) {
                case (#err(e)) #err(e);
                case (#ok(values)) {
                    for (value in values.vals()) {
                        if (Principal.toText(value.canisterId) == poolText) return #ok(value);
                    };
                    #err("The pool is absent from the ICPSwap factory registry.");
                };
            };
        };
        public func pool(poolText : Text) : async* Result<PoolView> {
            let registered = switch (await* verified(poolText)) { case (#err(e)) return #err(e); case (#ok(v)) v };
            let poolId = registered.canisterId;
            let metadata = switch (await* call(Client.poolMetadataRequest(poolId))) {
                case (#err(e)) return #err(e);
                case (#ok(reply)) switch (Client.decodePoolMetadata(reply)) { case (#err(e)) return #err(e); case (#ok(v)) v };
            };
            if (not sameToken(registered.token0, metadata.token0) or not sameToken(registered.token1, metadata.token1) or
                registered.fee != metadata.fee or registered.key != metadata.key) {
                return #err("Pool metadata disagrees with the factory's canonical token order or fee.");
            };
            let fees = switch (await* call(Client.cachedTokenFeeRequest(poolId))) {
                case (#err(e)) return #err(e);
                case (#ok(reply)) switch (Client.decodeCachedTokenFee(reply)) { case (#err(e)) return #err(e); case (#ok(v)) v };
            };
            let availability = switch (await* call(Client.availabilityRequest(poolId))) {
                case (#err(e)) return #err(e);
                case (#ok(reply)) switch (Client.decodeAvailability(reply)) { case (#err(e)) return #err(e); case (#ok(v)) v };
            };
            var available = availability.available;
            for (owner in availability.whiteList.vals()) {
                if (Principal.equal(owner, calls.canister_principal)) available := true;
            };
            let owned = switch (await* call(LiquidityClient.positionsRequest(poolId, calls.canister_principal))) {
                case (#err(e)) return #err(e);
                case (#ok(reply)) switch (outcome(LiquidityClient.decodePositions(reply))) { case (#err(e)) return #err(e); case (#ok(v)) v };
            };
            let queue = switch (await* call(LiquidityClient.withdrawQueueRequest(poolId))) {
                case (#err(e)) return #err(e);
                case (#ok(reply)) switch (outcome(LiquidityClient.decodeWithdrawQueue(reply))) { case (#err(e)) return #err(e); case (#ok(v)) v };
            };
            var diagnostics = "";
            let transactions : [Transaction] = switch (await* call(LiquidityClient.transactionsRequest(poolId, calls.canister_principal))) {
                case (#err(e)) { diagnostics := "Could not read protocol transactions: " # e; [] };
                case (#ok(reply)) switch (LiquidityClient.decodeTransactions(reply)) {
                    case (#ok(v)) Array.map<LiquidityClient.TransactionSummary, Transaction>(LiquidityClient.summarizeTransactions(v), func(tx) {
                        { id = tx.id; kind = tx.kind; state = tx.state;
                          token = switch (tx.token) { case null null; case (?p) ?Principal.toText(p) };
                          amount = tx.amount; error = tx.error; unused_reserved = tx.unused_reserved; support_required = tx.support_required };
                    });
                    case (#rejected(e)) { diagnostics := "Could not read protocol transactions: " # e; [] };
                    case (#unknown(e)) { diagnostics := "Could not read protocol transactions: " # e; [] };
                };
            };
            var reserved0 = 0;
            var reserved1 = 0;
            for (tx in transactions.vals()) {
                if (tx.unused_reserved) switch (tx.token) {
                    case (?token) {
                        if (token == registered.token0.address) reserved0 += tx.amount;
                        if (token == registered.token1.address) reserved1 += tx.amount;
                    };
                    case null {};
                };
            };
            // On a partial diagnostic read, preserve all observed queued gross
            // amounts as potentially still reserved rather than using them.
            if (diagnostics != "") { reserved0 := queue.token0TotalAmount; reserved1 := queue.token1TotalAmount };
            // Observe the actual balance after reservation state. Otherwise a
            // payout can debit an earlier balance and advance to CreditCompleted
            // between queries, falsely making that old balance look available.
            // Separate protocol queries are observations, not an atomic snapshot.
            let unused = switch (await* call(Client.unusedBalanceRequest(poolId, calls.canister_principal))) {
                case (#err(e)) return #err(e);
                case (#ok(reply)) switch (Client.decodeUnusedBalance(reply)) { case (#err(e)) return #err(e); case (#ok(v)) v };
            };
            let positions = Array.map<LiquidityClient.PositionWithId, Position>(owned, func(value) {
                let amounts = Math.amounts(value.liquidity, metadata.sqrtPriceX96, value.tickLower, value.tickUpper, false);
                let (amount0, amount1, error) = switch (amounts) {
                    case (#ok(v)) (v.amount0, v.amount1, ""); case (#err(e)) (0, 0, e);
                };
                { id = value.id; tick_lower = value.tickLower; tick_upper = value.tickUpper;
                  liquidity = value.liquidity; amount0; amount1; fees0 = value.tokensOwed0; fees1 = value.tokensOwed1;
                  fees_current = false; error };
            });
            #ok({ pool = poolText; key = registered.key; owner = Principal.toText(calls.canister_principal);
                token0 = registered.token0; token1 = registered.token1; fee = registered.fee;
                tick_spacing = registered.tickSpacing; tick = metadata.tick; sqrt_price_x96 = metadata.sqrtPriceX96;
                liquidity = metadata.liquidity; fee0 = fees.token0Fee; fee1 = fees.token1Fee; available;
                unused0 = unused.balance0; unused1 = unused.balance1;
                queued0 = queue.token0TotalAmount; queued1 = queue.token1TotalAmount;
                reserved0; reserved1; transactions;
                queue = Array.map<LiquidityClient.WithdrawQueueItem, QueueItem>(queue.items, func(item) {
                    { transaction_id = item.txIndex; token = item.token.address; amount = item.amount;
                      fee = item.fee; recipient = Principal.toText(item.to.owner) };
                }); positions; protocol_diagnostics = diagnostics; observed_at = now() });
        };
        public func preview(request : Request) : async* Result<Plan> {
            let current = switch (await* pool(request.pool)) { case (#err(e)) return #err(e); case (#ok(v)) v };
            if (not current.available) return #err("This pool is not available to this Neutron.");
            if (current.protocol_diagnostics != "" and (request.kind == "mint" or request.kind == "increase" or request.kind == "withdraw")) {
                return #err("Could not establish which unused funds are already reserved by protocol operations. Refresh the pool diagnostics before using or funding that balance.");
            };
            var effective = request;
            var amount0 = 0;
            var amount1 = 0;
            var liquidity = 0;
            var funding0 = 0;
            var funding1 = 0;
            var selected : ?Position = null;
            if (request.kind == "increase" or request.kind == "decrease" or request.kind == "close" or request.kind == "claim") {
                let positionId = switch (request.position_id) { case null return #err("A position ID is required."); case (?v) v };
                for (position in current.positions.vals()) { if (position.id == positionId) selected := ?position };
                let owned = switch (selected) { case null return #err("This Neutron does not own the selected position."); case (?v) v };
                let fresh = switch (await* call(LiquidityClient.positionRequest(Principal.fromText(current.pool), positionId))) {
                    case (#err(e)) return #err(e);
                    case (#ok(reply)) switch (outcome(LiquidityClient.decodePosition(reply))) { case (#err(e)) return #err(e); case (#ok(v)) v };
                };
                selected := ?{ owned with liquidity = fresh.liquidity; tick_lower = fresh.tickLower; tick_upper = fresh.tickUpper;
                    fees0 = fresh.tokensOwed0; fees1 = fresh.tokensOwed1; fees_current = true };
                effective := { request with tick_lower = fresh.tickLower; tick_upper = fresh.tickUpper };
            };
            if (request.kind == "mint" or request.kind == "increase") {
                if (current.tick_spacing <= 0 or effective.tick_lower % current.tick_spacing != 0 or effective.tick_upper % current.tick_spacing != 0) {
                    return #err("Position ticks must align with the factory's tick spacing.");
                };
                let expected = switch (Math.preview(request.amount0, request.amount1, current.sqrt_price_x96, effective.tick_lower, effective.tick_upper)) {
                    case (#err(e)) return #err(e); case (#ok(v)) v;
                };
                if (expected.liquidity == 0) return #err("These amounts would create zero liquidity at the observed pool price.");
                amount0 := expected.amount0; amount1 := expected.amount1; liquidity := expected.liquidity;
                funding0 := subtract(request.amount0, subtract(current.unused0, current.reserved0));
                funding1 := subtract(request.amount1, subtract(current.unused1, current.reserved1));
                for ((token, deficit, fee) in [(current.token0, funding0, current.fee0), (current.token1, funding1, current.fee1)].vals()) {
                    if (deficit > 0) {
                        if (token.standard != "ICRC2" and token.standard != "ICRC1" and token.standard != "ICP") {
                            return #err("Wallet funding is unavailable for the pool token standard " # token.standard # ".");
                        };
                        if (token.standard == "ICRC2" and deficit <= fee) {
                            return #err("ICPSwap depositFrom requires a positive funding deficit greater than the token fee.");
                        };
                    };
                };
            } else if (request.kind == "decrease" or request.kind == "close" or request.kind == "claim") {
                let position = switch (selected) { case null return #err("Missing owned position."); case (?v) v };
                if (request.kind == "claim") {
                    amount0 := position.fees0; amount1 := position.fees1;
                } else {
                    liquidity := if (request.kind == "close") position.liquidity else request.liquidity;
                    if (liquidity == 0 or liquidity > position.liquidity) return #err("The removal amount must be positive and no greater than the owned position's liquidity.");
                    effective := { effective with liquidity };
                    let principalAmounts = switch (Math.amounts(liquidity, current.sqrt_price_x96, position.tick_lower, position.tick_upper, false)) {
                        case (#err(e)) return #err(e); case (#ok(v)) v;
                    };
                    // ICPSwap partial removal also collects all current fees.
                    amount0 := principalAmounts.amount0 + position.fees0; amount1 := principalAmounts.amount1 + position.fees1;
                };
            } else if (request.kind == "withdraw") {
                let (available, fee) = if (request.withdraw_token == current.token0.address) {
                    (subtract(current.unused0, current.reserved0), current.fee0);
                } else if (request.withdraw_token == current.token1.address) {
                    (subtract(current.unused1, current.reserved1), current.fee1);
                } else return #err("Withdrawal token must be one of the verified pool tokens.");
                if (request.withdraw_amount <= fee or request.withdraw_amount > available) return #err("The gross unused withdrawal must exceed its fee and fit the balance not reserved by the withdrawal queue.");
                if (request.withdraw_token == current.token0.address) amount0 := request.withdraw_amount else amount1 := request.withdraw_amount;
            } else return #err("Unknown liquidity operation kind.");
            #ok({ request = effective; pool = current.pool; owner = current.owner; token0 = current.token0; token1 = current.token1;
                fee = current.fee; tick_spacing = current.tick_spacing; tick = current.tick; sqrt_price_x96 = current.sqrt_price_x96;
                fee0 = current.fee0; fee1 = current.fee1; funding0; funding1;
                expected_amount0 = amount0; expected_amount1 = amount1; expected_liquidity = liquidity;
                unused0 = current.unused0; unused1 = current.unused1; baseline_positions = current.positions;
                observed_at = current.observed_at; price_protection = false;
                detail = "Expected amounts reflect the observed pool state. ICPSwap liquidity methods have no price minimum or deadline. Desired amounts cap input consumption. Protocol success does not prove a refund or withdrawal reached Wallet." });
        };
        public func status(id : Text) : ?Prepared {
            let saved = switch (journal.raw(id)) { case null return null; case (?v) v };
            if (saved.plan_blob.size() == 0) return null;
            let plan : ?Plan = from_candid(saved.plan_blob);
            switch (plan) { case null null; case (?v) ?{ operation = Actions.view(saved); plan = v } };
        };
        public func prepare(request : PrepareRequest) : async* Result<Prepared> {
            switch (status(request.id)) {
                case (?prior) {
                    if (prior.operation.input_json != request.input_json) return #err("This operation ID already belongs to another intent.");
                    return #ok(prior);
                };
                case null {};
            };
            let observed = await* preview(request.request);
            // Another preparation of this ID can complete while the read-only
            // preview awaits replies. Return its exact retained plan rather
            // than comparing two independently timed observations as intents.
            switch (status(request.id)) {
                case (?prior) {
                    if (prior.operation.input_json != request.input_json) return #err("This operation ID already belongs to another intent.");
                    return #ok(prior);
                };
                case null {};
            };
            let plan = switch (observed) { case (#err(e)) return #err(e); case (#ok(v)) v };
            // input_json remains the original caller intent; effective close
            // liquidity and canonical pool metadata live in the typed plan.
            let operation = switch (journal.beginTyped({ id = request.id; input_json = request.input_json;
                plan_json = ""; funding_json = "" }, to_candid(plan))) {
                case (#err(e)) return #err(e); case (#ok(v)) v;
            };
            #ok({ operation; plan });
        };
        func dispatch(id : Text, key : Text, request : Client.CallRequest, pairResult : Bool) : async* Result<()> {
            let prior = switch (journal.raw(id)) { case null return #err("Unknown operation ID."); case (?v) v };
            for (effect in prior.effects.vals()) {
                if (effect.key == key) {
                    if (effect.state == "succeeded") return #ok(());
                    return #err("The saved protocol effect has no confirmed successful reply. It will not be replayed.");
                };
            };
            switch (journal.dispatch(id, prior.revision, key, request)) { case (#err(e)) return #err(e); case (#ok(_)) {} };
            let rawReply = switch (await* call(request)) {
                case (#err(e)) { ignore journal.finish(id, key, "uncertain", null, e); return #err(e) };
                case (#ok(v)) v;
            };
            let replyBlob = switch (rawReply) { case (#ok(bytes)) ?bytes; case (#err(_)) null };
            let result : LiquidityClient.Outcome<()> = if (pairResult) {
                switch (LiquidityClient.decodeAmounts(rawReply)) { case (#ok(_)) #ok(()); case (#rejected(e)) #rejected(e); case (#unknown(e)) #unknown(e) };
            } else {
                switch (LiquidityClient.decodeNat(rawReply)) { case (#ok(_)) #ok(()); case (#rejected(e)) #rejected(e); case (#unknown(e)) #unknown(e) };
            };
            switch (result) {
                case (#ok(_)) { ignore journal.finish(id, key, "succeeded", replyBlob, ""); #ok(()) };
                case (#rejected(e)) {
                    // A pool deposit may catch an uncertain ledger reply and
                    // return #err even though that transfer actually happened.
                    let uncertain = request.method == "deposit" or request.method == "depositFrom";
                    ignore journal.finish(id, key, if (uncertain) "uncertain" else "failed", replyBlob,
                        e # " Inspect retained funding and pool-unused balances before another action."); #err(e);
                };
                case (#unknown(e)) { ignore journal.finish(id, key, "uncertain", replyBlob, e); #err(e) };
            };
        };
        public func execute(request : ExecuteRequest) : async* Result<Prepared> {
            let saved = switch (status(request.id)) { case null return #err("Unknown liquidity operation ID."); case (?v) v };
            if (saved.operation.revision != request.expected_revision) return #err("Operation revision changed; read the saved operation.");
            if (saved.operation.state == "protocol_complete" or saved.operation.state == "settlement_pending" or saved.operation.state == "uncertain" or saved.operation.state == "stopped") return #ok(saved);
            // A close can remove the position before the final local summary
            // is saved. Its retained successful reply must win over a later
            // ownership read reporting that the closed position is absent.
            for (effect in saved.operation.effects.vals()) {
                if (effect.key == "liquidity" and effect.state == "succeeded") {
                    ignore journal.mark(request.id, "settlement_pending",
                        "The retained protocol reply confirms this operation. Any refund or withdrawal remains separate from Wallet settlement.", "");
                    return switch (status(request.id)) { case (?value) #ok(value); case null #err("Saved operation disappeared.") };
                };
            };
            if (saved.operation.state == "funding_requested") return #err("Reconcile the exact saved Wallet funding requests before continuing.");
            let plan = saved.plan;
            if ((plan.funding0 > 0 or plan.funding1 > 0) and saved.operation.state == "prepared") {
                return #err("Save and complete the exact Wallet funding requests before pool deposits.");
            };
            let current = switch (await* pool(plan.pool)) { case (#err(e)) return #err(e); case (#ok(v)) v };
            if (not sameToken(current.token0, plan.token0) or not sameToken(current.token1, plan.token1) or current.fee != plan.fee) return #err("The pool identity differs from the saved plan.");
            if (not current.available) return #err("This pool is currently unavailable.");
            if (current.fee0 != plan.fee0 or current.fee1 != plan.fee1) return #err("Pool token fees changed. Existing funding IDs remain saved; review recovery before preparing new funding.");
            let poolId = Principal.fromText(plan.pool);
            let intent = plan.request;
            if (current.protocol_diagnostics != "" and (intent.kind == "mint" or intent.kind == "increase" or intent.kind == "withdraw")) {
                return #err("Could not establish the current unused-fund reservations. No additional protocol effect was dispatched; retain the existing funding requests and refresh diagnostics.");
            };
            if (intent.kind == "mint" or intent.kind == "increase") {
                var remaining0 = plan.funding0;
                var remaining1 = plan.funding1;
                for (effect in saved.operation.effects.vals()) {
                    if (effect.state == "succeeded" and effect.key == "deposit0") remaining0 := 0;
                    if (effect.state == "succeeded" and effect.key == "deposit1") remaining1 := 0;
                };
                if (subtract(current.unused0, current.reserved0) + remaining0 < intent.amount0 or
                    subtract(current.unused1, current.reserved1) + remaining1 < intent.amount1) {
                    return #err("Pool-unused funds changed or are now reserved by another payout. The saved funding amount will not be increased automatically; inspect this operation and unused funds before continuing.");
                };
            };
            if (intent.kind == "withdraw") {
                let available = if (intent.withdraw_token == plan.token0.address) subtract(current.unused0, current.reserved0)
                    else subtract(current.unused1, current.reserved1);
                if (intent.withdraw_amount > available) return #err("The saved withdrawal now exceeds unreserved pool-unused funds. No withdrawal was dispatched.");
            };
            if (intent.kind != "mint" and intent.kind != "withdraw") {
                let positionId = switch (intent.position_id) { case null return #err("Saved position is missing."); case (?v) v };
                var owned = false;
                for (position in current.positions.vals()) {
                    if (position.id == positionId and position.tick_lower == intent.tick_lower and position.tick_upper == intent.tick_upper and
                        ((intent.kind != "decrease" and intent.kind != "close") or position.liquidity >= intent.liquidity)) owned := true;
                };
                if (not owned) return #err("The saved position or removal amount no longer matches this Neutron's owned position.");
            };
            if (intent.kind == "mint" or intent.kind == "increase") {
                for ((key, token, amount, fee) in [("deposit0", plan.token0, plan.funding0, plan.fee0), ("deposit1", plan.token1, plan.funding1, plan.fee1)].vals()) {
                    if (amount > 0) {
                        let deposit = if (token.standard == "ICRC2") LiquidityClient.depositFromRequest(poolId, token.address, amount, fee)
                            else LiquidityClient.depositRequest(poolId, token.address, amount + fee, fee);
                        switch (await* dispatch(request.id, key, deposit, false)) {
                            case (#err(_)) return switch (status(request.id)) { case (?v) #ok(v); case null #err("Saved operation disappeared.") };
                            case (#ok(_)) {};
                        };
                    };
                };
            };
            let methodRequest = if (intent.kind == "mint") LiquidityClient.mintRequest(poolId, {
                token0 = plan.token0.address; token1 = plan.token1.address; fee = plan.fee;
                tickLower = intent.tick_lower; tickUpper = intent.tick_upper; amount0Desired = intent.amount0; amount1Desired = intent.amount1;
            }) else if (intent.kind == "withdraw") {
                LiquidityClient.withdrawRequest(poolId, intent.withdraw_token, intent.withdraw_amount,
                    if (intent.withdraw_token == plan.token0.address) plan.fee0 else plan.fee1);
            } else {
                let positionId = switch (intent.position_id) { case null return #err("Saved position is missing."); case (?v) v };
                if (intent.kind == "increase") LiquidityClient.increaseRequest(poolId, positionId, intent.amount0, intent.amount1)
                else if (intent.kind == "claim") LiquidityClient.claimRequest(poolId, positionId)
                else LiquidityClient.decreaseRequest(poolId, positionId, intent.liquidity);
            };
            switch (await* dispatch(request.id, "liquidity", methodRequest, intent.kind == "decrease" or intent.kind == "close" or intent.kind == "claim")) {
                case (#err(_)) {};
                case (#ok(_)) {
                    ignore journal.mark(request.id, "settlement_pending",
                        "The protocol confirmed the liquidity operation. Any refunds or withdrawals settle asynchronously; inspect positions, unused funds and protocol payout records. Wallet receipt is not yet independently verified.", "");
                };
            };
            switch (status(request.id)) { case (?v) #ok(v); case null #err("Saved operation disappeared.") };
        };
        public func reconcile(id : Text) : async* Result<Reconciliation> {
            let saved = switch (status(id)) { case null return #err("Unknown liquidity operation ID."); case (?v) v };
            let current = switch (await* pool(saved.plan.pool)) { case (#err(e)) return #err(e); case (#ok(v)) v };
            // A vanished queue item or position delta is not a ledger receipt,
            // nor proof that a timed-out non-idempotent call may be replayed.
            let latest = switch (status(id)) { case null return #err("Saved operation disappeared."); case (?v) v };
            #ok({ operation = latest.operation; plan = latest.plan; pool = current });
        };
        public func recoveryStatus(id : Text) : ?RecoveryPrepared {
            let saved = switch (journal.raw(id)) { case null return null; case (?v) v };
            if (saved.plan_blob.size() == 0) return null;
            let plan : ?RecoveryPlan = from_candid(saved.plan_blob);
            switch (plan) { case null null; case (?v) ?{ operation = Actions.view(saved); plan = v } };
        };
        public func recoveryPrepare(request : RecoveryPrepareRequest) : async* Result<RecoveryPrepared> {
            if (request.id == request.source_id) return #err("Recovery needs its own operation ID while retaining the source funding identity.");
            switch (recoveryStatus(request.id)) {
                case (?prior) {
                    if (prior.operation.input_json != request.input_json or prior.plan.source_id != request.source_id or prior.plan.token_index != request.token_index) return #err("Recovery ID belongs to another saved intent.");
                    return #ok(prior);
                };
                case null {};
            };
            if (request.token_index > 1) return #err("Token index must identify canonical pool token 0 or 1.");
            let source = switch (status(request.source_id)) { case null return #err("The original liquidity operation is unavailable."); case (?v) v };
            if (source.plan.request.kind != "mint" and source.plan.request.kind != "increase") return #err("This source operation did not plan a pool deposit.");
            if (source.operation.funding_json == "") return #err("No exact Wallet funding requests were saved for the source operation.");
            let key = if (request.token_index == 0) "deposit0" else "deposit1";
            for (effect in source.operation.effects.vals()) {
                if (effect.key == key) return #err("The original deposit already has a retained dispatch or recovery. Reconcile it without replaying the call.");
            };
            let token = if (request.token_index == 0) source.plan.token0 else source.plan.token1;
            let amount = if (request.token_index == 0) source.plan.funding0 else source.plan.funding1;
            let oldFee = if (request.token_index == 0) source.plan.fee0 else source.plan.fee1;
            if (amount == 0 or (token.standard != "ICRC1" and token.standard != "ICP")) return #err("The selected leg did not use a direct-funded pool subaccount.");
            let current = switch (await* pool(source.plan.pool)) { case (#err(e)) return #err(e); case (#ok(v)) v };
            let currentToken = if (request.token_index == 0) current.token0 else current.token1;
            if (not sameToken(currentToken, token)) return #err("Pool token identity changed from the saved source funding.");
            let fee = if (request.token_index == 0) current.fee0 else current.fee1;
            let gross = amount + oldFee;
            if (gross <= fee) return #err("The retained direct funding does not exceed the current pool deposit fee. It cannot be credited by this protocol call.");
            let plan : RecoveryPlan = { source_id = request.source_id; token_index = request.token_index;
                pool = source.plan.pool; owner = source.plan.owner; token;
                gross_amount = gross; fee; credit_amount = gross - fee; observed_at = current.observed_at };
            switch (recoveryStatus(request.id)) {
                case (?prior) {
                    if (prior.operation.input_json != request.input_json or prior.plan.source_id != request.source_id or prior.plan.token_index != request.token_index) return #err("Recovery ID belongs to another saved intent.");
                    return #ok(prior);
                };
                case null {};
            };
            let operation = switch (journal.beginTyped({ id = request.id; input_json = request.input_json; plan_json = ""; funding_json = "" }, to_candid(plan))) {
                case (#err(e)) return #err(e); case (#ok(v)) v;
            };
            #ok({ operation; plan });
        };
        public func recoveryExecute(request : ExecuteRequest) : async* Result<RecoveryPrepared> {
            let saved = switch (recoveryStatus(request.id)) { case null return #err("Unknown deposit recovery ID."); case (?v) v };
            if (saved.operation.revision != request.expected_revision) return #err("Recovery revision changed; read the saved recovery.");
            if (saved.operation.state == "protocol_complete" or saved.operation.state == "uncertain" or saved.operation.state == "stopped") return #ok(saved);
            let plan = saved.plan;
            let key = if (plan.token_index == 0) "deposit0" else "deposit1";
            // A completed recovery reply can be summarized without repeating
            // the credit, regardless of later pool balance or fee changes.
            for (effect in saved.operation.effects.vals()) {
                if (effect.key == "recover_deposit") {
                    if (effect.state == "succeeded") {
                        ignore journal.finishRecovery(plan.source_id, key, request.id,
                            switch (journal.raw(request.id)) { case (?v) v.effects[0].reply; case null null });
                        ignore journal.mark(request.id, "protocol_complete", "The original direct-funded subaccount was credited to pool-unused funds. No new Wallet transfer was requested. Withdraw unused funds separately.", "");
                    };
                    return switch (recoveryStatus(request.id)) { case (?v) #ok(v); case null #err("Saved recovery disappeared.") };
                };
            };
            let source = switch (status(plan.source_id)) { case null return #err("Original liquidity operation is unavailable."); case (?v) v };
            let token = if (plan.token_index == 0) source.plan.token0 else source.plan.token1;
            let originalAmount = if (plan.token_index == 0) source.plan.funding0 + source.plan.fee0 else source.plan.funding1 + source.plan.fee1;
            if (not sameToken(plan.token, token) or plan.pool != source.plan.pool or originalAmount != plan.gross_amount) return #err("Recovery differs from the retained original direct-funding plan.");
            let current = switch (await* pool(plan.pool)) { case (#err(e)) return #err(e); case (#ok(v)) v };
            let currentFee = if (plan.token_index == 0) current.fee0 else current.fee1;
            let currentToken = if (plan.token_index == 0) current.token0 else current.token1;
            if (not sameToken(currentToken, plan.token)) return #err("The pool token no longer matches the saved direct funding.");
            if (currentFee != plan.fee) return #err("The recovery fee changed. Review a new recovery quote; the original Wallet transfer must not be repeated.");
            if (not current.available) return #err("The pool is currently unavailable for deposit recovery.");
            let recoveryNow = switch (recoveryStatus(request.id)) { case null return #err("Recovery disappeared."); case (?v) v };
            if (recoveryNow.operation.revision != request.expected_revision) return #ok(recoveryNow);
            let deposit = LiquidityClient.depositRequest(Principal.fromText(plan.pool), plan.token.address, plan.gross_amount, plan.fee);
            let sourceNow = switch (journal.get(plan.source_id)) { case null return #err("Original operation disappeared."); case (?v) v };
            switch (journal.reserveRecovery(plan.source_id, sourceNow.revision, key, request.id, deposit)) { case (#err(e)) return #err(e); case (#ok(_)) {} };
            switch (await* dispatch(request.id, "recover_deposit", deposit, false)) {
                case (#err(_)) {};
                case (#ok(_)) {
                    let recovery = switch (journal.raw(request.id)) { case null return #err("Recovery disappeared."); case (?v) v };
                    ignore journal.finishRecovery(plan.source_id, key, request.id, recovery.effects[0].reply);
                    ignore journal.mark(request.id, "protocol_complete", "The original direct-funded subaccount was credited to pool-unused funds. No new Wallet transfer was requested. Withdraw unused funds separately.", "");
                };
            };
            switch (recoveryStatus(request.id)) { case (?v) #ok(v); case null #err("Saved recovery disappeared.") };
        };
    };
};
