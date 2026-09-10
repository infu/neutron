import Array "mo:core/Array";
import Cycles "mo:core/Cycles";
import Error "mo:core/Error";
import Int "mo:core/Int";
import Nat "mo:core/Nat";
import Time "mo:core/Time";

// PocketIC only. Wire-compatible with the XRC's public Candid interface.
persistent actor class Oracle() {
    // Motoko's trailing-underscore escape maps this field to Candid `class`.
    public type XrcAsset = { symbol : Text; class_ : { #Cryptocurrency; #FiatCurrency } };
    public type Request = { base_asset : XrcAsset; quote_asset : XrcAsset; timestamp : ?Nat64 };
    public type ExchangeRateError = {
        #AnonymousPrincipalNotAllowed; #Pending; #CryptoBaseAssetNotFound;
        #CryptoQuoteAssetNotFound; #StablecoinRateNotFound; #StablecoinRateTooFewRates;
        #StablecoinRateZeroRate; #ForexInvalidTimestamp; #ForexBaseAssetNotFound;
        #ForexQuoteAssetNotFound; #ForexAssetsNotFound; #RateLimited;
        #NotEnoughCycles; #FailedToAcceptCycles; #InconsistentRatesReceived;
        #Other : { code : Nat32; description : Text };
    };
    public type ExchangeRate = {
        base_asset : XrcAsset; quote_asset : XrcAsset; timestamp : Nat64; rate : Nat64;
        metadata : {
            decimals : Nat32; base_asset_num_received_rates : Nat64;
            base_asset_num_queried_sources : Nat64; quote_asset_num_received_rates : Nat64;
            quote_asset_num_queried_sources : Nat64; standard_deviation : Nat64;
            forex_timestamp : ?Nat64;
        };
    };
    public type Rate = { symbol : Text; rate : Nat64; decimals : Nat32 };
    public type Behavior = { #normal; #error : ExchangeRateError; #reject : Text };

    var rates : [Rate] = [
        { symbol = "ICP"; rate = 500_000_000; decimals = 8 },
        { symbol = "BTC"; rate = 6_000_000_000_000; decimals = 8 },
        { symbol = "USDC"; rate = 100_000_000; decimals = 8 },
    ];
    var behavior : Behavior = #normal;
    var calls : Nat = 0;
    var cyclesReceived : Nat = 0;
    var charge : Nat = 20_000_000;

    public shared func configure(values : [Rate]) : async () { rates := values };
    public shared func setBehavior(value : Behavior) : async () { behavior := value };
    public shared func setCharge(value : Nat) : async () { charge := value };
    public shared query func stats() : async { calls : Nat; cyclesReceived : Nat } { { calls; cyclesReceived } };

    public shared func get_exchange_rate(request : Request) : async { #Ok : ExchangeRate; #Err : ExchangeRateError } {
        calls += 1;
        if (Cycles.available() < charge) return #Err(#NotEnoughCycles);
        cyclesReceived += Cycles.accept<system>(charge);
        switch (behavior) {
            case (#error(value)) return #Err(value);
            case (#reject(message)) throw Error.reject(message);
            case (#normal) {};
        };
        if (request.quote_asset.symbol != "USD") return #Err(#ForexQuoteAssetNotFound);
        let value = switch (Array.find<Rate>(rates, func(rate) { rate.symbol == request.base_asset.symbol })) {
            case (?rate) rate;
            case null return #Err(#CryptoBaseAssetNotFound);
        };
        let timestamp = switch (request.timestamp) {
            case (?value) value;
            case null Nat.toNat64(Int.abs(Time.now()) / 1_000_000_000);
        };
        #Ok({
            base_asset = request.base_asset; quote_asset = request.quote_asset;
            timestamp; rate = value.rate;
            metadata = {
                decimals = value.decimals; base_asset_num_received_rates = 5;
                base_asset_num_queried_sources = 5; quote_asset_num_received_rates = 5;
                quote_asset_num_queried_sources = 5; standard_deviation = 0;
                forex_timestamp = ?timestamp;
            };
        })
    };
};
