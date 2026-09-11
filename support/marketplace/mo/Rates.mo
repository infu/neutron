// Proprietary marketplace protocol. All rights reserved.
import Array "mo:core/Array";
import Error "mo:core/Error";
import Nat64 "mo:core/Nat64";
import Principal "mo:core/Principal";
import Store "./Store";
import Types "./Types";
import Journal "./PaymentStore";

module {
    public type AssetClass = { #Cryptocurrency; #FiatCurrency };
    public type Asset = { symbol : Text; class_ : AssetClass };
    public type Request = { base_asset : Asset; quote_asset : Asset; timestamp : ?Nat64 };
    public type Metadata = {
        decimals : Nat32; base_asset_num_received_rates : Nat64; base_asset_num_queried_sources : Nat64;
        quote_asset_num_received_rates : Nat64; quote_asset_num_queried_sources : Nat64;
        standard_deviation : Nat64; forex_timestamp : ?Nat64;
    };
    public type ExchangeRate = { base_asset : Asset; quote_asset : Asset; timestamp : Nat64; rate : Nat64; metadata : Metadata };
    public type ExchangeRateError = {
        #AnonymousPrincipalNotAllowed; #Pending; #CryptoBaseAssetNotFound; #CryptoQuoteAssetNotFound;
        #StablecoinRateNotFound; #StablecoinRateTooFewRates; #StablecoinRateZeroRate; #ForexInvalidTimestamp;
        #ForexBaseAssetNotFound; #ForexQuoteAssetNotFound; #ForexAssetsNotFound; #RateLimited;
        #NotEnoughCycles; #FailedToAcceptCycles; #InconsistentRatesReceived;
        #Other : { code : Nat32; description : Text };
    };
    public type Xrc = actor { get_exchange_rate : shared Request -> async { #Ok : ExchangeRate; #Err : ExchangeRateError } };
    public type Result<T> = { #ok : T; #err : Text };
    public type Client = {
        rate : (Principal, Nat, Request) -> async* Result<ExchangeRate>;
        fee : Principal -> async* Result<Nat>;
    };
    public type RefreshResult = { ledger : Principal; rateUpdated : Bool; feeUpdated : Bool; rate : ?Types.Rate; error : ?Text; feeError : ?Text };
    public func client() : Client {
        {
            rate = func(canister : Principal, cycles : Nat, request : Request) : async* Result<ExchangeRate> {
                let xrc : Xrc = actor (Principal.toText(canister));
                try {
                    switch (await (with cycles) xrc.get_exchange_rate(request)) {
                        case (#Ok(value)) #ok(value);
                        case (#Err(error)) #err(debug_show(error));
                    };
                } catch error { #err(Error.message(error)) };
            };
            fee = func(ledger : Principal) : async* Result<Nat> {
                let token : actor { icrc1_fee : shared query () -> async Nat } = actor (Principal.toText(ledger));
                try { #ok(await token.icrc1_fee()) } catch error { #err(Error.message(error)) };
            };
        };
    };
    public func request(symbol : Text) : Request {
        { base_asset = { symbol; class_ = #Cryptocurrency }; quote_asset = { symbol = "USD"; class_ = #FiatCurrency }; timestamp = null };
    };
    // No age cutoff: the most recent successful observation remains usable on
    // oracle failure. A zero placeholder records diagnostics, never a price.
    public func retain(db : Store.DB, token : Types.TokenConfig, startedAtNs : Int, finishedAtNs : Int, result : Result<ExchangeRate>) : (Bool, ?Types.Rate, ?Text) {
        let current = Store.getRate(db, token.ledger);
        let valid : Result<ExchangeRate> = switch result {
            case (#ok(value)) {
                if (value.base_asset != request(token.rateSymbol).base_asset or value.quote_asset != request(token.rateSymbol).quote_asset) #err("XRC returned a different currency pair")
                else if (value.rate == 0) #err("XRC returned a zero exchange rate")
                else switch current {
                    case (?row) { if (Nat64.toNat(value.timestamp) * 1_000_000_000 < row.observedAtNs) #err("XRC returned an older observation; the newer successful rate is retained") else #ok(value) };
                    case null #ok(value);
                };
            };
            case (#err(error)) #err(error);
        };
        switch valid {
            case (#ok(value)) {
                // A newer request may have failed while this successful call
                // was in flight. Diagnostics cannot supersede a valid price;
                // compare successful observation times above instead.
                let saved = Journal.must(Store.putRate(db, { ledger = token.ledger; symbol = token.rateSymbol;
                    usdRate = Nat64.toNat(value.rate); decimals = value.metadata.decimals;
                    observedAtNs = Nat64.toNat(value.timestamp) * 1_000_000_000; refreshedAtNs = finishedAtNs; lastError = null }));
                (true, ?saved, null);
            };
            case (#err(error)) {
                // An older call's failure must not erase diagnostics from a
                // refresh that completed after that call began.
                switch current {
                    case (?row) if (row.refreshedAtNs > startedAtNs) return (false, current, null);
                    case (_) {};
                };
                let saved = switch current {
                    case (?row) Journal.must(db.rates.update({ row with refreshedAtNs = finishedAtNs; lastError = ?error }));
                    case null Journal.must(Store.putRate(db, { ledger = token.ledger; symbol = token.rateSymbol; usdRate = 0;
                        decimals = 0; observedAtNs = 0; refreshedAtNs = finishedAtNs; lastError = ?error }));
                };
                (false, ?saved, ?error);
            };
        };
    };
    public func refreshWith(db : Store.DB, clock : () -> Int, calls : Client) : async* [RefreshResult] {
        let original = Store.config(db);
        let results = Array.empty<RefreshResult>();
        // Use a local growable buffer only for this three-ledger job; retained
        // observations are committed one ledger at a time across awaits.
        var output = results;
        for (token in original.tokens.vals()) {
            let started = clock();
            let feeResult = await* calls.fee(token.ledger);
            var feeUpdated = false;
            var feeError : ?Text = null;
            switch feeResult {
                case (#ok(fee)) {
                    let latest = Store.config(db);
                    let tokens = Array.map<Types.TokenConfig, Types.TokenConfig>(latest.tokens, func(item) {
                        if (item.ledger == token.ledger and item.fee == token.fee) {
                            feeUpdated := true;
                            { item with fee };
                        } else item;
                    });
                    // Only token network fees change. Protocol cycle fee
                    // coefficients remain exactly the configured schedule.
                    if (feeUpdated) Store.setConfig(db, { latest with tokens });
                };
                case (#err(error)) feeError := ?error;
            };
            let received = await* calls.rate(original.xrc, original.fees.xrc, request(token.rateSymbol));
            let latest = Store.config(db);
            let applicable = latest.xrc == original.xrc and Array.find<Types.TokenConfig>(latest.tokens, func(item) { item.ledger == token.ledger and item.rateSymbol == token.rateSymbol }) != null;
            let (rateUpdated, rate, error) = if (applicable) retain(db, token, started, clock(), received)
                else (false, Store.getRate(db, token.ledger), ?"Oracle configuration changed while the request was running");
            output := Array.concat(output, [{ ledger = token.ledger; rateUpdated; feeUpdated; rate; error; feeError }]);
        };
        output;
    };
    public func refresh(db : Store.DB, clock : () -> Int) : async* [RefreshResult] {
        await* refreshWith(db, clock, client());
    };
}
