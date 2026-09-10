// Proprietary marketplace protocol. All rights reserved.
import Ledger "./Ledger";

module {
    public type Status = { #prepared; #dispatched; #outcome_unknown; #no_effect; #succeeded };
    public type Evidence = {
        status : Status; hadUnknown : Bool; block : ?Nat; duplicate : Bool;
        ledgerError : ?Ledger.TransferFromError; transportError : ?Text;
    };
    public type NextAction = {
        #none; #await_current_call; #funding_required; #review_fee;
        #wait_ledger_time : Nat64; #review_terms; #retry_same_attempt; #review_required;
    };
    public let initial : Evidence = {
        status = #prepared; hadUnknown = false; block = null; duplicate = false;
        ledgerError = null; transportError = null;
    };
    public func dispatched(prior : Evidence) : Evidence {
        if (prior.status == #succeeded) return prior;
        { prior with status = #dispatched };
    };
    // Merge by retained attempt identity in the caller. Evidence is monotonic:
    // no later error can turn success into failure, and no rejection erases an
    // earlier uncertain effect. Duplicate names the original successful block.
    public func observe(prior : Evidence, outcome : Ledger.Outcome) : Evidence {
        if (prior.status == #succeeded) return prior;
        switch (outcome) {
            case (#unknown(message)) {
                { prior with status = #outcome_unknown; hadUnknown = true; transportError = ?message };
            };
            case (#response(#Ok(block))) {
                { prior with status = #succeeded; block = ?block; duplicate = false; ledgerError = null; transportError = null };
            };
            case (#response(#Err(#Duplicate(receipt)))) {
                { prior with status = #succeeded; block = ?receipt.duplicate_of; duplicate = true; ledgerError = null; transportError = null };
            };
            case (#response(#Err(error))) {
                // Unknown GenericError semantics are not a proof of nonexecution.
                let uncertain = prior.hadUnknown or (switch error { case (#GenericError(_)) true; case (_) false });
                { prior with status = if (uncertain) #outcome_unknown else #no_effect;
                    hadUnknown = uncertain; ledgerError = ?error; transportError = null };
            };
        };
    };
    public func next(evidence : Evidence) : NextAction {
        switch (evidence.status) {
            case (#succeeded) #none;
            case (#prepared) #retry_same_attempt;
            case (#dispatched) #await_current_call;
            case (#outcome_unknown) {
                switch (evidence.ledgerError) {
                    case (?#TooOld) #review_required;
                    case (?#BadFee(_)) #review_required;
                    case (_) #retry_same_attempt;
                };
            };
            case (#no_effect) {
                switch (evidence.ledgerError) {
                    case (?#InsufficientFunds(_)) #funding_required;
                    case (?#InsufficientAllowance(_)) #funding_required;
                    case (?#BadFee(_)) #review_fee;
                    case (?#CreatedInFuture(value)) #wait_ledger_time(value.ledger_time);
                    case (?#TooOld) #review_terms;
                    case (?#BadBurn(_)) #review_terms;
                    case (_) #retry_same_attempt;
                };
            };
        };
    };
    public func canReplaceAttempt(evidence : Evidence) : Bool {
        evidence.status == #no_effect and not evidence.hadUnknown;
    };
}
