import Test "mo:test";
import Principal "mo:core/Principal";
import Runtime "mo:core/Runtime";
import Pricing "../mo/Pricing";
import Accounting "../mo/Accounting";

persistent actor {
    func unwrap<T>(value : { #ok : T; #err : Text }) : T {
        switch value { case (#ok(result)) result; case (#err(error)) Runtime.trap(error) };
    };
    public func checkout_discount_and_splits() : async Test.Metrics {
        Test.test(func () {
            let buyer = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
            let publisher = Principal.fromText("mxzaz-hqaaa-aaaar-qaada-cai");
            let affiliate = Principal.fromText("xevnm-gaaaa-aaaar-qafnq-cai");
            let items = [{ appId = "paid"; publisher; usdMicros = 10_000_000 }];
            let rate = ?{ rate = 100_000_000; decimals = 8; observedAt = 0 : Nat64 };
            let quote = unwrap(Pricing.priceCart(items, buyer, ?affiliate, 6, rate));
            assert quote.subtotalUsdMicros == 10_000_000;
            assert quote.discountUsdMicros == 1_000_000;
            assert quote.paymentAtoms == 9_000_000;
            assert quote.split == { affiliate = 2_700_000; developer = 2_700_000; burn = 3_600_000 };
            let normal = unwrap(Pricing.priceCart(items, buyer, null, 6, rate));
            assert normal.split == { affiliate = 0; developer = 3_000_000; burn = 7_000_000 };
            switch (Pricing.priceCart(items, buyer, ?buyer, 6, rate)) { case (#err(_)) {}; case (_) assert false };
        });
    };
    public func integer_rates_and_free_without_oracle() : async Test.Metrics {
        Test.test(func () {
            let owner = Principal.fromText("ryjl3-tyaaa-aaaaa-aaaba-cai");
            let btc = unwrap(Pricing.usdToAtoms(1_000_000, 8, { rate = 70_000_000_000_000; decimals = 9; observedAt = 1 }));
            assert btc == 1_429;
            let usdcDepeg = unwrap(Pricing.usdToAtoms(1_000_000, 6, { rate = 900_000_000; decimals = 9; observedAt = 1 }));
            assert usdcDepeg == 1_111_112;
            let free = unwrap(Pricing.priceCart([{ appId = "free"; publisher = owner; usdMicros = 0 }], owner, null, 6, null));
            assert free.paymentAtoms == 0 and free.split.burn == 0;
            assert Pricing.validateListingPrice(999_999) == #err("App prices must be free or between $1 and $50");
            assert Pricing.validateListingPrice(50_000_001) == #err("App prices must be free or between $1 and $50");
            assert Pricing.validateListingPrice(1_000_000) == #ok(());
            assert Pricing.validateListingPrice(50_000_000) == #ok(());
        });
    };
    public func credit_reservation_preserves_later_earnings() : async Test.Metrics {
        Test.test(func () {
            let funded = Accounting.credit(Accounting.empty, 1_000);
            let first = unwrap(Accounting.reserve(funded, 600));
            assert Accounting.liabilities(first) == 1_000;
            switch (Accounting.reserve(first, 401)) { case (#err(_)) {}; case (_) assert false };
            let earned = Accounting.credit(first, 100);
            let confirmed = unwrap(Accounting.consume(earned, 600));
            assert confirmed == { available = 500; reserved = 0 };
            let second = unwrap(Accounting.reserve(confirmed, 400));
            let released = unwrap(Accounting.release(second, 400));
            assert released == confirmed;
            assert unwrap(Accounting.netPayout(400, 10)) == 390;
            switch (Accounting.netPayout(10, 10)) { case (#err(_)) {}; case (_) assert false };
        });
    };
}
