// Proprietary marketplace protocol. All rights reserved.
import Array "mo:core/Array";
import Error "mo:core/Error";
import Int "mo:core/Int";
import Principal "mo:core/Principal";
import Sha256 "mo:sha2/Sha256";
import Store "./Store";
import Types "./Types";
import Journal "./PaymentStore";
import State "./PaymentState";
import Rates "./Rates";
import Withdrawals "./Withdrawals";

module {
    public let dayNs : Int = 86_400_000_000_000;
    public func dayStart(now : Int) : Int { assert now >= 0; now - now % dayNs };
    public func rateKey(day : Int) : Text { "xrc:" # Int.toText(dayStart(day) / dayNs) };
    public func forwardKey(ledger : Principal, day : Int) : Text {
        "forward:" # Principal.toText(ledger) # ":" # Int.toText(dayStart(day) / dayNs);
    };
    public func cursorKey(ledger : Principal) : Text { "forward-current:" # Principal.toText(ledger) };
    public type WithdrawalDriver = {
        run : Nat64 -> async* Withdrawals.Result<Types.Withdrawal>;
        isActive : Nat64 -> Bool;
    };
    public type ForwardResult = { job : Types.Job; withdrawal : ?Types.Withdrawal; error : ?Text };
    public type Report = { dayStartNs : Int; skippedActive : Bool; rateJob : ?Types.Job; rates : [Rates.RefreshResult]; forwards : [ForwardResult]; errors : [Text] };

    // Main owns the IC Timer registration/rearming. This domain retains work
    // identity and progress across upgrades; no timer ID is treated as proof
    // that either a price refresh or a financial transfer completed.
    public class Engine(db : Store.DB, withdrawals : WithdrawalDriver, marketplace : Principal, clock : () -> Int, rateClient : Rates.Client) {
        var active = false;
        public func isActive() : Bool { active };
        public func tick() : async* Report {
            let day = dayStart(clock());
            if (active) return { dayStartNs = day; skippedActive = true; rateJob = null; rates = []; forwards = []; errors = [] };
            active := true;
            try {
                let report = await async { await* drive(day) };
                active := false;
                report;
            } catch error {
                active := false;
                { dayStartNs = day; skippedActive = false; rateJob = Store.getJob(db, rateKey(day)); rates = []; forwards = [];
                  errors = ["Daily work was interrupted; saved jobs retain their original identities: " # Error.message(error)] };
            };
        };
        func ensure(key : Text, kind : { #xrc; #forward }, ledger : ?Principal, day : Int) : Types.Job {
            switch (Store.getJob(db, key)) {
                case (?job) job;
                case null Journal.must(Store.insertJob(db, { key; kind; ledger; scheduledAtNs = day; state = #scheduled;
                    operationId = null; attempts = 0; lastError = null; updatedAtNs = clock() }));
            };
        };
        func saveForward(job : Types.Job) : Types.Job {
            let saved = Journal.must(db.jobs.update(job));
            let ledger = Journal.found(job.ledger);
            // One indexed cursor per ledger avoids rescanning an ever-growing
            // daily history. Its operation points at the same frozen transfer.
            ignore Journal.must(Store.putJob(db, { saved with key = cursorKey(ledger) }));
            saved;
        };
        func waiting(job : Types.Job, error : Text) : ForwardResult {
            { job = saveForward({ job with state = #waiting; lastError = ?error; updatedAtNs = clock() });
              withdrawal = switch (job.operationId) { case null null; case (?id) db.withdrawals.get(id) }; error = ?error };
        };
        func configured(ledger : Principal) : ?Types.TokenConfig {
            Array.find<Types.TokenConfig>(Store.config(db).tokens, func(token) { token.ledger == ledger });
        };
        func canRetire(job : Types.Job) : Bool {
            // A no-effect job can carry its still-available allocation into the
            // next day's aggregate. Unknown/success-unfinalized transfers must
            // retain their original withdrawal and its reservation instead.
            switch (job.operationId) {
                case null true;
                case (?id) {
                    let withdrawal = Journal.found(db.withdrawals.get(id));
                    switch (withdrawal.currentAttempt) {
                        case null true;
                        case (?attemptId) State.canReplaceAttempt(Journal.evidence(Journal.found(db.attempts.get(attemptId))));
                    };
                };
            };
        };
        func currentForward(ledger : Principal, day : Int) : Types.Job {
            switch (Store.getJob(db, cursorKey(ledger))) {
                case (?cursor) if (cursor.scheduledAtNs < day and cursor.state != #complete) {
                    let prior = Journal.found(Store.getJob(db, forwardKey(ledger, cursor.scheduledAtNs)));
                    if (not canRetire(prior)) return prior;
                    // No ledger effect is being replayed: this never-dispatched
                    // or explicitly rejected job leaves its funds available.
                    ignore Journal.must(db.jobs.update({ prior with state = #complete;
                        lastError = ?"No transfer completed; available allocation carried into the next daily job"; updatedAtNs = clock() }));
                };
                case (_) {};
            };
            ensure(forwardKey(ledger, day), #forward, ?ledger, day);
        };
        func forward(job : Types.Job) : async* ForwardResult {
            if (job.state == #complete) return { job; withdrawal = switch (job.operationId) { case null null; case (?id) db.withdrawals.get(id) }; error = null };
            let ledger = Journal.found(job.ledger);
            let withdrawal = switch (job.operationId) {
                case (?id) {
                    let saved = Journal.found(db.withdrawals.get(id));
                    if (withdrawals.isActive(id)) return { job; withdrawal = ?saved; error = null };
                    switch (saved.currentAttempt) {
                        case (?attemptId) {
                            let evidence = Journal.evidence(Journal.found(db.attempts.get(attemptId)));
                            if (State.next(evidence) == #review_required) {
                                return waiting(job, "The original forwarding outcome is unresolved and requires review; its reservation and exact transfer arguments are retained");
                            };
                            // A verified BadFee rejection permits a successor
                            // with the same total debit and destination. The
                            // ledger fee belongs only to this burn allocation.
                            switch (configured(ledger)) {
                                case (?token) {
                                    if (State.canReplaceAttempt(evidence) and token.fee != saved.fee) {
                                        switch (Withdrawals.prepare(db, { saved with fee = token.fee; updatedAtNs = clock() })) {
                                            case (#ok(updated)) updated;
                                            case (#err(error)) return waiting(job, error);
                                        };
                                    } else saved;
                                };
                                case (_) saved;
                            };
                        };
                        case null saved;
                    };
                };
                case null {
                    let ?token = configured(ledger) else return waiting(job, "This token is no longer configured; its burn allocation is retained");
                    let ?to = token.burnAccount else return waiting(job, "No burn forwarding destination is configured; the allocation is retained");
                    let available = switch (Store.getCredit(db, ledger, marketplace, true)) { case null 0; case (?credit) credit.available };
                    if (available <= token.fee) return waiting(job, "The burn allocation does not yet exceed its transfer fee");
                    let now = clock();
                    let intentHash = Sha256.fromBlob(#sha256, to_candid("neutron.marketplace.forward.v1", marketplace, job.key, ledger, to, available));
                    switch (Withdrawals.prepare(db, { owner = marketplace; requestId = job.key; intentHash; ledger; to;
                        totalDebit = available; fee = token.fee; isBurn = true; state = #prepared; currentAttempt = null;
                        createdAtNs = now; updatedAtNs = now; finalizedAtNs = null; lastError = null })) {
                        case (#ok(prepared)) prepared;
                        case (#err(error)) return waiting(job, error);
                    };
                };
            };
            let dispatched = saveForward({ job with operationId = ?withdrawal.id; state = #running; attempts = job.attempts + 1; lastError = null; updatedAtNs = clock() });
            let result = await* withdrawals.run(withdrawal.id);
            let current = Journal.found(db.jobs.get(dispatched.id));
            switch result {
                case (#err(error)) waiting(current, error);
                case (#ok(observed)) {
                    let done = observed.state == #complete;
                    let saved = saveForward({ current with state = if (done) #complete else #waiting; lastError = observed.lastError; updatedAtNs = clock() });
                    { job = saved; withdrawal = ?observed; error = observed.lastError };
                };
            };
        };
        func refresh(day : Int) : async* (Types.Job, [Rates.RefreshResult]) {
            let job = ensure(rateKey(day), #xrc, null, day);
            // Exactly one completed refresh attempt per UTC day. Failure keeps
            // the last successful price usable; it does not start a costly
            // oracle polling loop. A interrupted running read can resume.
            if (job.state == #complete or job.state == #failed) return (job, []);
            ignore Journal.must(db.jobs.update({ job with state = #running; attempts = job.attempts + 1; lastError = null; updatedAtNs = clock() }));
            let results = await* Rates.refreshWith(db, clock, rateClient);
            let errors = Array.filter<Rates.RefreshResult>(results, func(result) { result.error != null or result.feeError != null });
            let current = Journal.found(db.jobs.get(job.id));
            let completed = Journal.must(db.jobs.update({ current with state = if (errors.size() == 0) #complete else #failed;
                lastError = if (errors.size() == 0) null else ?"Some daily rate or ledger-fee reads failed; prior successful prices remain usable"; updatedAtNs = clock() }));
            (completed, results);
        };
        func drive(day : Int) : async* Report {
            let (rateJob, rates) = await* refresh(day);
            var forwards : [ForwardResult] = [];
            // Configured tokens are the canonical accepted ledgers. No wallet
            // balance sweep occurs: only the marketplace's isBurn credit is
            // reserved by the same engine used for individual withdrawals.
            for (token in Store.config(db).tokens.vals()) {
                let result = await* forward(currentForward(token.ledger, day));
                forwards := Array.concat(forwards, [result]);
            };
            { dayStartNs = day; skippedActive = false; rateJob = ?rateJob; rates; forwards; errors = [] };
        };
    };
}
