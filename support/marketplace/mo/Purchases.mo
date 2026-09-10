// Proprietary marketplace protocol. All rights reserved.
import Error "mo:core/Error";
import Nat64 "mo:core/Nat64";
import Set "mo:core/Set";
import Sha256 "mo:sha2/Sha256";
import Store "./Store";
import Types "./Types";
import Ledger "./Ledger";
import State "./PaymentState";
import Journal "./PaymentStore";

module {
    public type Result<T> = { #ok : T; #err : Text };
    public func spenderSubaccount(marketplace : Principal, order : Types.CreateOrder) : Blob {
        Sha256.fromBlob(#sha256, to_candid("neutron.marketplace.purchase.spender.v1", marketplace,
            order.owner, order.requestId, order.intentHash, order.quoteCommitment, order.ledger,
            order.amount, order.fee, order.affiliate, order.rateId, order.items));
    };
    public func prepare(db : Store.DB, proposed : Types.CreateOrder) : Result<Types.Order> {
        if (proposed.affiliate == ?proposed.owner) return #err("You cannot use your own affiliate code");
        var total = 0;
        let apps = Set.empty<Text>();
        for (item in proposed.items.vals()) {
            if (Set.contains(apps, TextCompare, item.appId)) return #err("The purchase contains a duplicate app");
            Set.add(apps, TextCompare, item.appId);
            if (item.developerAtoms + item.affiliateAtoms + item.burnAtoms != item.paidAtoms) return #err("Purchase allocations do not match its reviewed amount");
            if (proposed.affiliate == null and item.affiliateAtoms != 0) return #err("Purchase has an affiliate allocation without an affiliate");
            total += item.paidAtoms;
        };
        if (total != proposed.amount) return #err("Purchase items do not sum to its reviewed amount");
        switch (Store.getOrder(db, proposed.owner, proposed.requestId)) {
            case null #ok(Journal.must(Store.insertOrder(db, { proposed with state = #prepared; currentAttempt = null; finalizedAtNs = null; lastError = null })));
            case (?saved) {
                if (saved.intentHash != proposed.intentHash) return #err("This purchase ID already belongs to a different intent");
                if (saved.state == #complete) return #ok(saved);
                if (saved.quoteCommitment == proposed.quoteCommitment) return #ok(saved);
                switch (saved.currentAttempt) {
                    case (?id) {
                        let attempt = Journal.found(db.attempts.get(id));
                        if (not State.canReplaceAttempt(Journal.evidence(attempt))) {
                            return #err("The original purchase outcome is unresolved; reconcile its exact saved payment before accepting changed terms");
                        };
                    };
                    case null {};
                };
                // Retain currentAttempt as the predecessor; run creates the next
                // ordinal only after this known no-effect state permits it.
                #ok(Journal.must(db.orders.update({ proposed with id = saved.id; createdAtNs = saved.createdAtNs;
                    currentAttempt = saved.currentAttempt; state = #prepared; finalizedAtNs = null; lastError = null })));
            };
        };
    };
    private func TextCompare(a : Text, b : Text) : { #less; #equal; #greater } {
        if (a < b) #less else if (a == b) #equal else #greater;
    };
    public class Engine(db : Store.DB, client : Ledger.Client, marketplace : Principal, clock : () -> Int,
                        onFinalized : (Types.Order, ?Nat, Int) -> ()) {
        let active = Set.empty<Nat64>();
        public func isActive(id : Nat64) : Bool { Set.contains(active, Nat64.compare, id) };
        public func run(id : Nat64) : async* Result<Types.Order> {
            let ?initial = db.orders.get(id) else return #err("Purchase not found");
            if (initial.state == #complete or isActive(id)) return #ok(initial);
            Set.add(active, Nat64.compare, id);
            // Catch traps in the inner message, including a local finalization
            // trap after the ledger has committed. Driver liveness is disposable;
            // exact attempts and acquisition reservations are not.
            try {
                let result = await async { await* drive(id) };
                Set.remove(active, Nat64.compare, id);
                result;
            } catch error {
                Set.remove(active, Nat64.compare, id);
                #err("Purchase processing was interrupted; retain this ID and inspect its saved outcome: " # Error.message(error));
            };
        };
        func claim(order : Types.Order, now : Int) : Result<()> {
            // Validate the entire basket before touching claims. Preparation and
            // an allowance-required reply leave no locks on unbought apps.
            for (item in order.items.vals()) {
                switch (Store.getEntitlement(db, order.owner, item.appId)) {
                    case (?_) return #err("Ownership changed; review the remaining unowned apps before payment");
                    case null {};
                };
                switch (Store.getClaim(db, order.owner, item.appId)) {
                    case (?other) if (other.orderId != order.id) {
                        return #err("Another purchase is already acquiring " # item.appId # "; resume order " # Nat64.toText(other.orderId));
                    };
                    case (_) {};
                };
            };
            for (item in order.items.vals()) {
                switch (Store.getClaim(db, order.owner, item.appId)) {
                    case null ignore Journal.must(Store.insertClaim(db, { owner = order.owner; appId = item.appId; orderId = order.id; createdAtNs = now }));
                    case (?_) {};
                };
            };
            #ok(());
        };
        func releaseClaims(order : Types.Order) {
            for (item in order.items.vals()) {
                switch (Store.getClaim(db, order.owner, item.appId)) {
                    case (?value) if (value.orderId == order.id) { ignore Journal.must(db.claims.delete(value.id)) };
                    case (_) {};
                };
            };
        };
        func finalise(orderId : Nat64, attemptId : ?Nat64, block : ?Nat) : Types.Order {
            let order = Journal.found(db.orders.get(orderId));
            if (order.finalizedAtNs != null or order.state == #complete) return order;
            assert order.currentAttempt == attemptId;
            if (order.amount > 0) {
                let attempt = Journal.found(db.attempts.get(Journal.found(attemptId)));
                assert attempt.state == #succeeded and attempt.block == block;
            };
            let now = clock();
            for (item in order.items.vals()) {
                let held = Journal.found(Store.getClaim(db, order.owner, item.appId));
                assert held.orderId == order.id;
                assert Store.getEntitlement(db, order.owner, item.appId) == null;
            };
            for (item in order.items.vals()) {
                Journal.addCredit(db, order.ledger, item.publisher, false, item.developerAtoms, now);
                switch (order.affiliate) {
                    case (?beneficiary) Journal.addCredit(db, order.ledger, beneficiary, false, item.affiliateAtoms, now);
                    case null assert item.affiliateAtoms == 0;
                };
                Journal.addCredit(db, order.ledger, marketplace, true, item.burnAtoms, now);
                ignore Journal.must(Store.insertEntitlement(db, { owner = order.owner; appId = item.appId; orderId = order.id;
                    kind = if (item.priceUsdMicros == 0) #free else #paid; acquiredAtNs = now }));
            };
            onFinalized(order, block, now);
            releaseClaims(order);
            Journal.must(db.orders.update({ order with state = #complete; finalizedAtNs = ?now; updatedAtNs = now; lastError = null }));
        };
        func needsNewAttempt(order : Types.Order, old : Types.Attempt) : Bool {
            if (old.state != #no_effect or old.hadUnknown) return false;
            if (old.request.spenderSubaccount != ?spenderSubaccount(marketplace, order)) return true;
            switch (Journal.evidence(old).ledgerError) { case (?#TooOld) true; case (_) false };
        };
        func makeAttempt(order : Types.Order, old : ?Types.Attempt, now : Int) : Types.Attempt {
            let ordinal : Nat64 = switch old { case null 0; case (?value) value.ordinal + 1 };
            let request : Types.LedgerRequest = {
                kind = #transfer_from; ledger = order.ledger; spenderSubaccount = ?spenderSubaccount(marketplace, order);
                fromAccount = { owner = order.owner; subaccount = null }; to = { owner = marketplace; subaccount = null };
                amount = order.amount; fee = order.fee;
                memo = Sha256.fromBlob(#sha256, to_candid("neutron.marketplace.purchase.payment.v1", marketplace, order.owner, order.requestId, order.quoteCommitment, ordinal));
                createdAtTimeNs = Journal.timestamp(now);
            };
            let attemptId = Journal.must(db.attempts.insert({ owner = order.owner; operationKind = #purchase; operationId = order.id;
                ordinal; request; state = #prepared; hadUnknown = false; block = null; duplicate = false;
                lastLedgerError = null; lastError = null; createdAtNs = now; updatedAtNs = now }));
            Journal.found(db.attempts.get(attemptId));
        };
        func drive(id : Nat64) : async* Result<Types.Order> {
            let order = Journal.found(db.orders.get(id));
            if (order.state == #complete) return #ok(order);
            let prior = switch (order.currentAttempt) { case null null; case (?attemptId) ?Journal.found(db.attempts.get(attemptId)) };
            switch prior {
                case (?attempt) if (attempt.state == #succeeded) return #ok(finalise(id, ?attempt.id, attempt.block));
                case (_) {};
            };
            let now = clock();
            switch (claim(order, now)) { case (#err(error)) return #err(error); case (_) {} };
            if (order.amount == 0) return #ok(finalise(id, order.currentAttempt, null));
            let chosen = switch prior {
                case null makeAttempt(order, null, now);
                case (?attempt) { if (needsNewAttempt(order, attempt)) makeAttempt(order, ?attempt, now) else attempt };
            };
            let attempt = Journal.markDispatched(db, chosen, now);
            ignore Journal.must(db.orders.update({ order with currentAttempt = ?attempt.id; state = #dispatched; updatedAtNs = now; lastError = null }));
            let outcome = await* client.transferFrom(attempt.request.ledger, Journal.transferFromArgs(attempt.request));
            let observed = Journal.observe(db, attempt.id, outcome, clock());
            let current = Journal.found(db.orders.get(id));
            if (current.state == #complete or current.currentAttempt != ?attempt.id) return #ok(current);
            switch (observed.state) {
                case (#succeeded) {
                    // Commit the ledger's successful reply before ownership,
                    // credits or ranking writes can trap. A later continuation
                    // finalizes this retained block without another collection.
                    #ok(await async { finalise(id, ?observed.id, observed.block) });
                };
                case (#no_effect) {
                    releaseClaims(current);
                    let funding = switch (Journal.evidence(observed).ledgerError) {
                        case (?#InsufficientFunds(_)) true; case (?#InsufficientAllowance(_)) true; case (_) false;
                    };
                    #ok(Journal.must(db.orders.update({ current with state = if (funding) #funding_required else #failed;
                        updatedAtNs = clock(); lastError = observed.lastError })));
                };
                case (_) #ok(Journal.must(db.orders.update({ current with state = #outcome_unknown; updatedAtNs = clock(); lastError = observed.lastError })));
            };
        };
    };
}
