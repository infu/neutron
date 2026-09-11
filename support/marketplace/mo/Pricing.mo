// Proprietary marketplace protocol. All rights reserved.
import Array "mo:core/Array";
import Nat "mo:core/Nat";
import Principal "mo:core/Principal";

module {
    public type Result<T> = { #ok : T; #err : Text };
    public type Terms = { discountBps : Nat; affiliateBps : Nat; developerBps : Nat };
    public type Rate = { rate : Nat; decimals : Nat; observedAt : Nat64 };
    public type Split = { affiliate : Nat; developer : Nat; burn : Nat };
    public type Item = { appId : Text; publisher : Principal; usdMicros : Nat };
    public type DeveloperCredit = { appId : Text; publisher : Principal; amount : Nat };
    public type Line = { appId : Text; publisher : Principal; usdMicros : Nat; paidAtoms : Nat; developerAtoms : Nat; affiliateAtoms : Nat; burnAtoms : Nat };
    public type Price = {
        subtotalUsdMicros : Nat; discountUsdMicros : Nat; paidUsdMicros : Nat;
        paymentAtoms : Nat; split : Split; developerCredits : [DeveloperCredit]; lines : [Line];
    };
    public let usdScale : Nat = 1_000_000;
    public let discountBps : Nat = 1_000;
    public let affiliateBps : Nat = 3_000;
    public let developerBps : Nat = 3_000;
    public func validateListingPrice(usdMicros : Nat) : Result<()> {
        if (usdMicros != 0 and (usdMicros < usdScale or usdMicros > 50 * usdScale)) {
            return #err("App prices must be free or between $1 and $50");
        };
        #ok(());
    };
    public func ceilDiv(numerator : Nat, denominator : Nat) : Nat {
        assert denominator > 0;
        let quotient = numerator / denominator;
        quotient + (if (numerator % denominator == 0) 0 else 1);
    };
    public func usdToAtoms(usdMicros : Nat, tokenDecimals : Nat, rate : Rate) : Result<Nat> {
        if (usdMicros == 0) return #ok(0);
        if (rate.rate == 0) return #err("No successful exchange rate is available for this payment token");
        #ok(ceilDiv(usdMicros * (10 ** (tokenDecimals + rate.decimals)), usdScale * rate.rate));
    };
    public let defaultTerms : Terms = { discountBps; affiliateBps; developerBps };
    public func validateTerms(terms : Terms) : Result<()> {
        if (terms.discountBps > 10_000 or terms.affiliateBps + terms.developerBps > 10_000) return #err("Revenue percentages exceed the amount available");
        #ok(());
    };
    public func split(amount : Nat, hasAffiliate : Bool) : Split { splitWithTerms(amount, hasAffiliate, defaultTerms) };
    public func splitWithTerms(amount : Nat, hasAffiliate : Bool, terms : Terms) : Split {
        assert terms.discountBps <= 10_000 and terms.affiliateBps + terms.developerBps <= 10_000;
        let affiliate = if (hasAffiliate) amount * terms.affiliateBps / 10_000 else 0;
        let developer = amount * terms.developerBps / 10_000;
        { affiliate; developer; burn = amount - affiliate - developer };
    };
    // Discounts apply to actual sale proceeds. Payment atoms are allocated in
    // canonical app order; the last paid item receives the remainder. Each line
    // rounds its commission down and allocates its remainder to burning. Free
    // items never receive money, and every line and basket conserve token atoms.
    public func priceCart(items : [Item], buyer : Principal, affiliate : ?Principal, tokenDecimals : Nat, rate : ?Rate) : Result<Price> {
        priceCartWithTerms(items, buyer, affiliate, tokenDecimals, rate, defaultTerms);
    };
    public func priceCartWithTerms(items : [Item], buyer : Principal, affiliate : ?Principal, tokenDecimals : Nat, rate : ?Rate, terms : Terms) : Result<Price> {
        switch (validateTerms(terms)) { case (#err(error)) return #err(error); case (_) {} };
        if (affiliate == ?buyer) return #err("You cannot use your own affiliate code");
        let sorted = Array.sort<Item>(items, func(a, b) { TextCompare(a.appId, b.appId) });
        var subtotal = 0;
        var previous : ?Text = null;
        var lastPaid : ?Text = null;
        for (item in sorted.vals()) {
            if (previous == ?item.appId) return #err("The purchase contains a duplicate app");
            previous := ?item.appId;
            switch (validateListingPrice(item.usdMicros)) { case (#err(error)) return #err(error); case (_) {} };
            subtotal += item.usdMicros;
            if (item.usdMicros > 0) lastPaid := ?item.appId;
        };
        let discount = if (affiliate == null) 0 else subtotal * terms.discountBps / 10_000;
        let paid = subtotal - discount;
        let atoms = if (paid == 0) 0 else {
            let ?observation = rate else return #err("No successful exchange rate is available for this payment token");
            switch (usdToAtoms(paid, tokenDecimals, observation)) { case (#ok(value)) value; case (#err(error)) return #err(error) };
        };
        var remaining = atoms;
        var developerTotal = 0;
        var affiliateTotal = 0;
        var burnTotal = 0;
        let lines = Array.map<Item, Line>(sorted, func(item) {
            let paidAtoms = if (item.usdMicros == 0 or subtotal == 0) 0
                else if (lastPaid == ?item.appId) remaining
                else atoms * item.usdMicros / subtotal;
            remaining -= paidAtoms;
            let allocation = splitWithTerms(paidAtoms, affiliate != null, terms);
            developerTotal += allocation.developer;
            affiliateTotal += allocation.affiliate;
            burnTotal += allocation.burn;
            { appId = item.appId; publisher = item.publisher; usdMicros = item.usdMicros; paidAtoms;
              developerAtoms = allocation.developer; affiliateAtoms = allocation.affiliate; burnAtoms = allocation.burn };
        });
        assert remaining == 0;
        let credits = Array.map<Line, DeveloperCredit>(lines, func(line) {
            { appId = line.appId; publisher = line.publisher; amount = line.developerAtoms };
        });
        let allocation = { developer = developerTotal; affiliate = affiliateTotal; burn = burnTotal };
        assert developerTotal + affiliateTotal + burnTotal == atoms;
        #ok({ subtotalUsdMicros = subtotal; discountUsdMicros = discount; paidUsdMicros = paid; paymentAtoms = atoms; split = allocation; developerCredits = credits; lines });
    };
    private func TextCompare(a : Text, b : Text) : { #less; #equal; #greater } {
        if (a < b) #less else if (a == b) #equal else #greater;
    };
}
