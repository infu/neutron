import Array "mo:core/Array";
import Blob "mo:core/Blob";
import Reply "../backend/icpswap/ProtocolReply";
import Types "../backend/icpswap/Types";

// Actual IC Candid encoding checks the independent reader against Motoko's
// wire format. The local PocketIC runner executes this without network calls.
persistent actor {
    public func run() : async Text {
        func unknown<T>(outcome : Reply.Outcome<T>) : Bool {
            switch (outcome) { case (#unknown(_)) true; case (_) false };
        };
        type AmountResult = { #ok : Reply.Amounts; #err : Types.SwapError };
        let large : Nat = 123456789012345678901234567890123456789012345678901234567890;
        for (value in [0,1,127,128,16383,16384,large].vals()) {
            let result : Types.NatResult = #ok(value);
            assert (Reply.decodeNat(to_candid(result)) == #ok(value));
        };
        let amounts = { amount0 = large; amount1 = 0 };
        let result : AmountResult = #ok(amounts);
        assert (Reply.decodeAmounts(to_candid(result)) == #ok(amounts));
        for ((error, expected) in [
            (#CommonError : Types.SwapError, "common error"),
            (#InsufficientFunds : Types.SwapError, "insufficient funds"),
            (#InternalError("失敗 🐟") : Types.SwapError, "internal error: 失敗 🐟"),
            (#UnsupportedToken("ckUSDC") : Types.SwapError, "unsupported token: ckUSDC"),
        ].vals()) {
            let natResult : Types.NatResult = #err(error);
            let amountResult : AmountResult = #err(error);
            assert (Reply.decodeNat(to_candid(natResult)) == #rejected(expected));
            assert (Reply.decodeAmounts(to_candid(amountResult)) == #rejected(expected));
        };

        // Narrow variants and wider records are Candid-compatible replies.
        let narrow : { #ok : Nat } = #ok(77);
        assert (Reply.decodeNat(to_candid(narrow)) == #ok(77));
        let narrowError : { #err : { #InternalError : Text } } = #err(#InternalError("pool detail"));
        assert (Reply.decodeNat(to_candid(narrowError)) == #rejected("internal error: pool detail"));
        let wide : { #ok : { amount0 : Nat; amount1 : Nat; note : Text; spare : Nat; absent : Null } } = #ok({
            amount0 = 10; amount1 = 20; note = "extra field"; spare = large; absent = null;
        });
        assert (Reply.decodeAmounts(to_candid(wide)) == #ok({ amount0 = 10; amount1 = 20 }));
        let withComposite : { #ok : { amount0 : Nat; amount1 : Nat; extra : {} } } = #ok({ amount0 = 10; amount1 = 20; extra = {} });
        assert (unknown(Reply.decodeAmounts(to_candid(withComposite))));

        // Wrong success payloads, labels, argument counts and Candid text are
        // unknown; they must never manufacture a financial success/rejection.
        assert (unknown(Reply.decodeNat(to_candid("not a result"))));
        assert (unknown(Reply.decodeNat(to_candid(77 : Nat))));
        assert (unknown(Reply.decodeNat(to_candid())));
        assert (unknown(Reply.decodeNat(to_candid(narrow, narrow))));
        let wrongPayload : { #ok : Text } = #ok("77");
        assert (unknown(Reply.decodeNat(to_candid(wrongPayload))));
        let wrongError : { #err : { #InternalError : Nat } } = #err(#InternalError(77));
        assert (unknown(Reply.decodeNat(to_candid(wrongError))));
        let missingAmount : { #ok : { amount0 : Nat } } = #ok({ amount0 = 1 });
        assert (unknown(Reply.decodeAmounts(to_candid(missingAmount))));
        let wrongAmount : { #ok : { amount0 : Nat; amount1 : Text } } = #ok({ amount0 = 1; amount1 = "2" });
        assert (unknown(Reply.decodeAmounts(to_candid(wrongAmount))));

        let utf8 : { #err : { #InternalError : Text } } = #err(#InternalError("x"));
        let encoded = Blob.toArray(to_candid(utf8));
        let badUtf8 = Blob.fromArray(Array.tabulate<Nat8>(encoded.size(), func(index) {
            if (index + 1 == encoded.size()) 255 else encoded[index];
        }));
        assert (unknown(Reply.decodeNat(badUtf8)));
        let badTextLength = Blob.fromArray(Array.tabulate<Nat8>(encoded.size(), func(index) {
            if (index + 2 == encoded.size()) 127 else encoded[index];
        }));
        assert (unknown(Reply.decodeNat(badTextLength)));
        var size = 0;
        while (size < encoded.size()) {
            assert (unknown(Reply.decodeNat(Blob.fromArray(Array.tabulate<Nat8>(size, func(index) { encoded[index] })))));
            size += 1;
        };
        "Nat/amounts, all errors, Candid subtyping, malformed bytes, UTF-8, and truncated lengths";
    };
};
