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
import Accounting "./Accounting";

module {
    public type Result<T> = { #ok : T; #err : Text };
    public func prepare(db : Store.DB, proposed : Types.CreateWithdrawal) : Result<Types.Withdrawal> {
        switch (Accounting.netPayout(proposed.totalDebit, proposed.fee)) { case (#err(error)) return #err(error); case (_) {} };
        switch (proposed.to.subaccount) { case (?sub) if (sub.size() != 32) return #err("A ledger subaccount must contain exactly 32 bytes"); case (_) {} };
        switch (Store.getWithdrawal(db, proposed.owner, proposed.requestId)) {
            case null #ok(Journal.must(Store.insertWithdrawal(db, { proposed with state = #prepared; currentAttempt = null; finalizedAtNs = null; lastError = null })));
            case (?saved) {
                if (saved.intentHash != proposed.intentHash or saved.ledger != proposed.ledger or saved.to != proposed.to or saved.totalDebit != proposed.totalDebit or saved.isBurn != proposed.isBurn) {
                    return #err("This withdrawal ID already belongs to a different intent");
                };
                if (saved.state == #complete or saved.fee == proposed.fee) return #ok(saved);
                switch (saved.currentAttempt) {
                    case (?id) if (not State.canReplaceAttempt(Journal.evidence(Journal.found(db.attempts.get(id))))) {
                        return #err("The original withdrawal outcome is unresolved; reconcile its exact saved transfer before accepting changed fees");
                    };
                    case (_) {};
                };
                #ok(Journal.must(db.withdrawals.update({ saved with fee = proposed.fee; state = #prepared; updatedAtNs = proposed.updatedAtNs; lastError = null })));
            };
        };
    };
    public class Engine(db : Store.DB, client : Ledger.Client, marketplace : Principal, clock : () -> Int) {
        let active = Set.empty<Nat64>();
        public func isActive(id : Nat64) : Bool { Set.contains(active, Nat64.compare, id) };
        public func run(id : Nat64) : async* Result<Types.Withdrawal> {
            let ?initial = db.withdrawals.get(id) else return #err("Withdrawal not found");
            if (initial.state == #complete or isActive(id)) return #ok(initial);
            Set.add(active, Nat64.compare, id);
            try {
                let result = await async { await* drive(id) };
                Set.remove(active, Nat64.compare, id);
                result;
            } catch error {
                Set.remove(active, Nat64.compare, id);
                #err("Withdrawal processing was interrupted; retain this ID and inspect its saved outcome: " # Error.message(error));
            };
        };
        func credit(withdrawal : Types.Withdrawal) : ?Types.Credit {
            Store.getCredit(db, withdrawal.ledger, withdrawal.owner, withdrawal.isBurn);
        };
        func reserve(withdrawal : Types.Withdrawal, now : Int) : Result<()> {
            let ?current = credit(withdrawal) else return #err("No earnings are available for this token");
            switch (Accounting.reserve({ available = current.available; reserved = current.reserved }, withdrawal.totalDebit)) {
                case (#err(error)) #err(error);
                case (#ok(value)) {
                    ignore Journal.must(db.credits.update({ current with available = value.available; reserved = value.reserved; updatedAtNs = now }));
                    #ok(());
                };
            };
        };
        func release(withdrawal : Types.Withdrawal, now : Int) {
            let current = Journal.found(credit(withdrawal));
            let restored = switch (Accounting.release({ available = current.available; reserved = current.reserved }, withdrawal.totalDebit)) {
                case (#ok(value)) value; case (#err(_)) { assert false; Accounting.empty };
            };
            ignore Journal.must(db.credits.update({ current with available = restored.available; reserved = restored.reserved; updatedAtNs = now }));
        };
        func finalise(id : Nat64, attemptId : Nat64) : Types.Withdrawal {
            let withdrawal = Journal.found(db.withdrawals.get(id));
            if (withdrawal.finalizedAtNs != null or withdrawal.state == #complete) return withdrawal;
            assert withdrawal.currentAttempt == ?attemptId;
            let attempt = Journal.found(db.attempts.get(attemptId));
            assert attempt.state == #succeeded and attempt.block != null;
            let current = Journal.found(credit(withdrawal));
            let consumed = switch (Accounting.consume({ available = current.available; reserved = current.reserved }, withdrawal.totalDebit)) {
                case (#ok(value)) value; case (#err(_)) { assert false; Accounting.empty };
            };
            let now = clock();
            ignore Journal.must(db.credits.update({ current with available = consumed.available; reserved = consumed.reserved; updatedAtNs = now }));
            Journal.must(db.withdrawals.update({ withdrawal with state = #complete; finalizedAtNs = ?now; updatedAtNs = now; lastError = null }));
        };
        func needsNewAttempt(withdrawal : Types.Withdrawal, old : Types.Attempt) : Bool {
            if (old.state != #no_effect or old.hadUnknown) return false;
            if (old.request.fee != withdrawal.fee) return true;
            switch (Journal.evidence(old).ledgerError) { case (?#TooOld) true; case (_) false };
        };
        func makeAttempt(withdrawal : Types.Withdrawal, old : ?Types.Attempt, now : Int) : Types.Attempt {
            let ordinal : Nat64 = switch old { case null 0; case (?value) value.ordinal + 1 };
            let net = switch (Accounting.netPayout(withdrawal.totalDebit, withdrawal.fee)) { case (#ok(value)) value; case (#err(_)) { assert false; 0 } };
            let request : Types.LedgerRequest = {
                kind = #transfer; ledger = withdrawal.ledger; spenderSubaccount = null;
                fromAccount = { owner = marketplace; subaccount = null }; to = withdrawal.to; amount = net; fee = withdrawal.fee;
                memo = Sha256.fromBlob(#sha256, to_candid("neutron.marketplace.withdrawal.v1", marketplace, withdrawal.owner, withdrawal.requestId, withdrawal.intentHash, ordinal));
                createdAtTimeNs = Journal.timestamp(now);
            };
            let attemptId = Journal.must(db.attempts.insert({ owner = withdrawal.owner; operationKind = #withdrawal; operationId = withdrawal.id;
                ordinal; request; state = #prepared; hadUnknown = false; block = null; duplicate = false;
                lastLedgerError = null; lastError = null; createdAtNs = now; updatedAtNs = now }));
            Journal.found(db.attempts.get(attemptId));
        };
        func drive(id : Nat64) : async* Result<Types.Withdrawal> {
            let withdrawal = Journal.found(db.withdrawals.get(id));
            if (withdrawal.state == #complete) return #ok(withdrawal);
            let prior = switch (withdrawal.currentAttempt) { case null null; case (?attemptId) ?Journal.found(db.attempts.get(attemptId)) };
            switch prior { case (?attempt) if (attempt.state == #succeeded) return #ok(finalise(id, attempt.id)); case (_) {} };
            let now = clock();
            let reservationNeeded = switch prior { case null true; case (?attempt) attempt.state == #no_effect };
            if (reservationNeeded) {
                switch (reserve(withdrawal, now)) { case (#err(error)) return #err(error); case (_) {} };
            };
            let chosen = switch prior {
                case null makeAttempt(withdrawal, null, now);
                case (?attempt) { if (needsNewAttempt(withdrawal, attempt)) makeAttempt(withdrawal, ?attempt, now) else attempt };
            };
            let attempt = Journal.markDispatched(db, chosen, now);
            ignore Journal.must(db.withdrawals.update({ withdrawal with currentAttempt = ?attempt.id; state = #dispatched; updatedAtNs = now; lastError = null }));
            let outcome = await* client.transfer(attempt.request.ledger, Journal.transferArgs(attempt.request));
            let observed = Journal.observe(db, attempt.id, outcome, clock());
            let current = Journal.found(db.withdrawals.get(id));
            if (current.state == #complete or current.currentAttempt != ?attempt.id) return #ok(current);
            switch (observed.state) {
                case (#succeeded) {
                    // Keep the returned block even if local accounting traps.
                    // Resumption consumes the existing reservation once; the
                    // already-successful transfer is never dispatched again.
                    #ok(await async { finalise(id, observed.id) });
                };
                case (#no_effect) {
                    release(current, clock());
                    #ok(Journal.must(db.withdrawals.update({ current with state = #failed; updatedAtNs = clock(); lastError = observed.lastError })));
                };
                case (_) #ok(Journal.must(db.withdrawals.update({ current with state = #outcome_unknown; updatedAtNs = clock(); lastError = observed.lastError })));
            };
        };
    };
}
