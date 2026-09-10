import Test "mo:test";
import PaymentState "../mo/PaymentState";
import Ledger "../mo/Ledger";

persistent actor {
    public func unknown_never_becomes_safe_to_replace() : async Test.Metrics {
        Test.test(func () {
            let pending = PaymentState.dispatched(PaymentState.initial);
            let lost = PaymentState.observe(pending, #unknown("reply lost after ledger committed"));
            let old = PaymentState.observe(lost, #response(#Err(#TooOld)));
            assert old.hadUnknown and old.status == #outcome_unknown;
            assert not PaymentState.canReplaceAttempt(old);
            assert PaymentState.next(old) == #review_required;
            let fee = PaymentState.observe(lost, #response(#Err(#BadFee({ expected_fee = 20 }))));
            assert fee.status == #outcome_unknown and not PaymentState.canReplaceAttempt(fee);
            let duplicate = PaymentState.observe(fee, #response(#Err(#Duplicate({ duplicate_of = 123 }))));
            assert duplicate.status == #succeeded and duplicate.block == ?123 and duplicate.duplicate;
            let lateError = PaymentState.observe(duplicate, #response(#Err(#InsufficientFunds({ balance = 0 }))));
            assert lateError == duplicate;
        });
    };
    public func definite_rejections_and_complete_are_distinct() : async Test.Metrics {
        Test.test(func () {
            let allowance = PaymentState.observe(PaymentState.initial, #response(#Err(#InsufficientAllowance({ allowance = 0 }))));
            assert PaymentState.next(allowance) == #funding_required;
            assert PaymentState.canReplaceAttempt(allowance);
            let future = PaymentState.observe(PaymentState.initial, #response(#Err(#CreatedInFuture({ ledger_time = 456 }))));
            assert PaymentState.next(future) == #wait_ledger_time(456);
            let temporary = PaymentState.observe(PaymentState.initial, #response(#Err(#TemporarilyUnavailable)));
            assert PaymentState.next(temporary) == #retry_same_attempt;
            let unknownGeneric = PaymentState.observe(PaymentState.initial, #response(#Err(#GenericError({ error_code = 99; message = "undocumented" }))));
            assert unknownGeneric.hadUnknown;
            let ok = PaymentState.observe(PaymentState.initial, #response(#Ok(7)));
            assert ok.status == #succeeded and ok.block == ?7;
            assert PaymentState.next(ok) == #none;
        });
    };
}
