// Proprietary marketplace protocol. All rights reserved.
import Array "mo:core/Array";
import Int "mo:core/Int";
import Nat64 "mo:core/Nat64";
import Runtime "mo:core/Runtime";
import Store "./Store";
import Types "./Types";
import Ledger "./Ledger";
import State "./PaymentState";

module {
    public func must<T>(result : { #ok : T; #err : Types.Error }) : T {
        switch result { case (#ok(value)) value; case (#err(error)) Runtime.trap("Marketplace accounting write failed: " # debug_show(error)) };
    };
    public func found<T>(value : ?T) : T {
        switch value { case (?row) row; case null Runtime.trap("Marketplace financial record is missing") };
    };
    public func timestamp(now : Int) : Nat64 {
        if (now < 0) Runtime.trap("Invalid ledger timestamp");
        Nat64.fromNat(Int.abs(now));
    };
    public func evidence(attempt : Types.Attempt) : State.Evidence {
        let decoded : ?Ledger.TransferFromError = switch (attempt.lastLedgerError) {
            case null null;
            case (?bytes) from_candid(bytes);
        };
        let malformed = attempt.lastLedgerError != null and decoded == null;
        { status = if (malformed and attempt.state != #succeeded) #outcome_unknown else attempt.state;
          hadUnknown = attempt.hadUnknown or malformed; block = attempt.block; duplicate = attempt.duplicate;
          ledgerError = decoded; transportError = attempt.lastError };
    };
    public func observe(db : Store.DB, id : Nat64, outcome : Ledger.Outcome, now : Int) : Types.Attempt {
        let current = found(db.attempts.get(id));
        let merged = State.observe(evidence(current), outcome);
        switch outcome {
            case (#response(#Err(#BadFee(value)))) {
                let config = Store.config(db);
                let tokens = Array.map<Types.TokenConfig, Types.TokenConfig>(config.tokens, func(token) {
                    // This updates only the observed token-ledger network fee.
                    // Saved payment args and fixed protocol cycle tariffs never
                    // change, and a newer config observation wins the CAS.
                    if (token.ledger == current.request.ledger and token.fee == current.request.fee) ({ token with fee = value.expected_fee })
                    else token;
                });
                Store.setConfig(db, { config with tokens });
            };
            case (_) {};
        };
        must(db.attempts.update({ current with state = merged.status; hadUnknown = merged.hadUnknown;
            block = merged.block; duplicate = merged.duplicate; updatedAtNs = now;
            lastLedgerError = switch (merged.ledgerError) { case null null; case (?error) ?to_candid(error) };
            lastError = switch (merged.transportError) { case (?error) ?error; case null switch (merged.ledgerError) { case null null; case (?error) ?debug_show(error) } };
        }));
    };
    public func markDispatched(db : Store.DB, attempt : Types.Attempt, now : Int) : Types.Attempt {
        must(db.attempts.update({ attempt with state = #dispatched; updatedAtNs = now;
            // A retained dispatched attempt without an active driver can follow a
            // lost callback or upgrade. Its original effect is already unknown.
            hadUnknown = attempt.hadUnknown or attempt.state == #dispatched or attempt.state == #outcome_unknown;
        }));
    };
    public func transferFromArgs(request : Types.LedgerRequest) : Ledger.TransferFromArgs {
        assert request.kind == #transfer_from;
        { spender_subaccount = request.spenderSubaccount; from = request.fromAccount; to = request.to;
          amount = request.amount; fee = ?request.fee; memo = ?request.memo; created_at_time = ?request.createdAtTimeNs };
    };
    public func transferArgs(request : Types.LedgerRequest) : Ledger.TransferArgs {
        assert request.kind == #transfer;
        { from_subaccount = request.fromAccount.subaccount; to = request.to; amount = request.amount;
          fee = ?request.fee; memo = ?request.memo; created_at_time = ?request.createdAtTimeNs };
    };
    public func addCredit(db : Store.DB, ledger : Principal, owner : Principal, isBurn : Bool, amount : Nat, now : Int) {
        if (amount == 0) return;
        switch (db.credits.by_beneficiary.lookup((ledger, owner, isBurn))) {
            case (?credit) ignore must(db.credits.update({ credit with available = credit.available + amount; updatedAtNs = now }));
            case null ignore must(db.credits.insert({ ledger; owner; isBurn; available = amount; reserved = 0; updatedAtNs = now }));
        };
    };
}
