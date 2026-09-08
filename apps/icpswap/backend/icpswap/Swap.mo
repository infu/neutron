/// Swap arithmetic and validation.
///
/// Pure: no calls, no state, no capability handle. Everything here is decided
/// before a single message leaves this Neutron, which is what makes it testable
/// against captured mainnet numbers.
///
/// The three quantities that decide whether a swap succeeds or costs the owner
/// money are computed here: the direction, the minimum output, and the amount
/// the Wallet must be asked to allow.
import Float "mo:core/Float";
import Nat "mo:core/Nat";
import Text "mo:core/Text";
import Market "./Market";
import Types "./Types";

module {

    /// Slippage is carried the way ICPSwap carries it: an integer in
    /// thousandths of a percent, so 500 is 0.5%.
    public let SLIPPAGE_SCALE : Nat = 100_000;

    /// ICPSwap's own default (`constants/mint.ts`), and its 50% ceiling.
    public let DEFAULT_SLIPPAGE : Nat = 500;
    public let MAX_SLIPPAGE : Nat = 50_000;

    /// Price impact at or above which a swap is refused outright. ICPSwap
    /// blocks at 15% unless "expert mode" is on; this app has no expert mode,
    /// because a market terminal that lets you lose 15% by accident is not one.
    public let BLOCKED_PRICE_IMPACT : Float = 0.15;

    /// Above this the UI must warn, matching ICPSwap's "Swap Anyway" tier.
    public let WARN_PRICE_IMPACT : Float = 0.05;

    /// Fee tiers ICPSwap deploys, best first by typical liquidity. Their own
    /// app only ever queries the middle one; quoting all three costs three
    /// cheap queries and can only improve the price.
    public let FEE_TIERS : [Nat] = [3_000, 500, 10_000];

    /// A swap the caller has asked for, before any pool has been consulted.
    public type SwapIntent = {
        input_address : Text;
        output_address : Text;
        amount_in : Nat;
        slippage : Nat;
    };

    /// Everything read from the pool and the two ledgers for one quote.
    public type QuoteInputs = {
        /// Canonical ordering as the pool reports it, not as the caller asked.
        token0_address : Text;
        token1_address : Text;
        /// The pool's own cached ledger fees.
        cached_fee0 : Nat;
        cached_fee1 : Nat;
        /// What the ledgers say right now, when anyone can tell us.
        ///
        /// Token ledgers belong to the Wallet, so this app cannot read
        /// `icrc1_fee` itself. Left `null` the cache is trusted, and a stale
        /// cache surfaces later as a ledger `BadFee` from inside the swap —
        /// with the funds untouched, because that ledger call is atomic. Supply
        /// these and the mismatch is refused before anything is sent.
        live_fee_in : ?Nat;
        live_fee_out : ?Nat;
        /// `quote` output for `amount_in`, in output base units.
        quoted_out : Nat;
        /// Pool mid price, for price impact. Zero disables the check.
        sqrt_price_x96 : Nat;
        decimals_in : Nat;
        decimals_out : Nat;
    };

    /// Why a swap cannot be offered. Every one of these is a refusal to send a
    /// message, not an error returned by one.
    public type SwapRejection = {
        #amount_zero;
        #amount_below_fee : { amount_in : Nat; fee : Nat };
        #slippage_out_of_range : { slippage : Nat };
        #same_token;
        #no_quote;
        #minimum_is_zero;
        #fee_cache_stale : { side : Text; cached : Nat; live : Nat };
        #price_impact_too_high : { impact : Float };
    };

    public type SwapPlan = {
        /// True when the input token is the pool's `token0`.
        zero_for_one : Bool;
        amount_in : Nat;
        /// Gross output minimum enforced by the swap, before withdrawal fee.
        amount_out_minimum : Nat;
        /// What the pool quoted, gross of the output ledger fee.
        quoted_out : Nat;
        /// Estimated net output if the quoted swap and outgoing transfer settle.
        expected_out : Nat;
        /// The agreed ledger fees, passed verbatim to `depositFromAndSwap`.
        token_in_fee : Nat;
        token_out_fee : Nat;
        /// What to ask the Wallet to allow. The Wallet adds the transfer fee
        /// itself, so this is the bare input amount.
        funding_amount : Nat;
        /// What the owner's balance must cover: the swap, the pool's transfer
        /// fee, and the approval's own fee.
        total_debit : Nat;
        price_impact : Float;
        warn : Bool;
    };

    /// Convert a rejection into something a person or an agent can act on.
    public func describeRejection(rejection : SwapRejection) : Text {
        switch (rejection) {
            case (#amount_zero) "Enter an amount greater than zero.";
            case (#amount_below_fee(detail)) {
                "Amount " # Nat.toText(detail.amount_in)
                # " does not cover the ledger fee of " # Nat.toText(detail.fee)
                # ".";
            };
            case (#slippage_out_of_range(detail)) {
                "Slippage " # Nat.toText(detail.slippage)
                # " is outside the allowed range (1 to "
                # Nat.toText(MAX_SLIPPAGE) # ", in thousandths of a percent).";
            };
            case (#same_token) "Choose two different tokens.";
            case (#no_quote) {
                "This pool cannot price that amount. Try a smaller one.";
            };
            case (#minimum_is_zero) {
                "The amount is too small to protect against slippage.";
            };
            case (#fee_cache_stale(detail)) {
                "The pool's cached " # detail.side # " fee ("
                # Nat.toText(detail.cached) # ") disagrees with the ledger ("
                # Nat.toText(detail.live)
                # "). Swapping now would fail; try again later.";
            };
            case (#price_impact_too_high(detail)) {
                "Price impact of " # Float.toText(detail.impact * 100.0)
                # "% is too high for this pool at that size.";
            };
        };
    };

    /// Compare the pool's cached fee against the ledger's, when we have both.
    ///
    /// The pool rejects a fee that disagrees with its cache and then hands the
    /// same number to the ledger, which rejects a mismatch of its own — so
    /// there is no value to send when the two disagree, only a choice of which
    /// end fails. Refusing is the only correct move, and it needs the live fee.
    func checkFee(side : Text, cached : Nat, live : ?Nat) : ?SwapRejection {
        switch (live) {
            case null null;
            case (?value) {
                if (value == cached) null else {
                    ?#fee_cache_stale({ side; cached; live = value });
                };
            };
        };
    };

    /// The minimum output a swap must return, given a quote and a slippage
    /// tolerance.
    ///
    /// This mirrors ICPSwap's `Trade.minimumAmountOut` exactly:
    /// `floor(quoted * SCALE / (SCALE + slippage))`, i.e. `quoted / (1 + s)`.
    /// For positive slippage, `quoted * (1 - s)` would produce a slightly
    /// smaller minimum; keep the established ICPSwap convention.
    public func amountOutMinimum(quoted_out : Nat, slippage : Nat) : Nat {
        if (quoted_out == 0) return 0;
        (quoted_out * SLIPPAGE_SCALE) / (SLIPPAGE_SCALE + slippage);
    };

    /// The most of `balance` that can be swapped in one go.
    ///
    /// Two ledger fees are withheld, not one: the Wallet's `icrc2_approve`
    /// costs one, and the pool's `transfer_from` consumes another out of the
    /// allowance. Withholding only one produces a "max" that always fails.
    public func maxSpendable(balance : Nat, fee : Nat) : Nat {
        let reserved = fee * 2;
        if (balance <= reserved) 0 else balance - reserved;
    };

    /// True when the pool quotes the input token as `token0`.
    public func zeroForOne(input_address : Text, token0_address : Text) : Bool {
        Market.lower(input_address) == Market.lower(token0_address);
    };

    /// Price impact against the pool's mid price, as a fraction.
    ///
    /// Returns 0.0 when the mid price is unusable rather than inventing a
    /// number — a missing impact must never read as a good one.
    public func priceImpact(
        amount_in : Nat,
        quoted_out : Nat,
        sqrt_price_x96 : Nat,
        decimals_in : Nat,
        decimals_out : Nat,
        zero_for_one : Bool,
    ) : Float {
        if (sqrt_price_x96 == 0 or amount_in == 0 or quoted_out == 0) {
            return 0.0;
        };
        // `priceFromSqrt` gives token0 priced in token1.
        let (dec0, dec1) = if (zero_for_one) {
            (decimals_in, decimals_out);
        } else { (decimals_out, decimals_in) };
        let price0In1 = Market.priceFromSqrt(sqrt_price_x96, dec0, dec1);
        if (price0In1 <= 0.0 or Float.isNaN(price0In1)) return 0.0;

        let rate = if (zero_for_one) price0In1 else 1.0 / price0In1;
        let scaleIn = Float.pow(10.0, Float.fromInt(decimals_in));
        let scaleOut = Float.pow(10.0, Float.fromInt(decimals_out));
        let midOut = (Float.fromInt(amount_in) / scaleIn) * rate * scaleOut;
        if (midOut <= 0.0 or Float.isNaN(midOut)) return 0.0;

        let impact = (midOut - Float.fromInt(quoted_out)) / midOut;
        if (Float.isNaN(impact) or impact < 0.0) 0.0 else impact;
    };

    /// Decide whether a swap can be offered, and on what terms.
    ///
    /// Every refusal happens here, before any value moves. The fee comparison
    /// is the load-bearing one: the pool checks our fee against its own cache
    /// and then hands the same number to the ledger, so a disagreement between
    /// the two means the swap fails at one end or the other whichever value we
    /// send. Refusing is the only correct move.
    public func plan(
        intent : SwapIntent,
        inputs : QuoteInputs,
    ) : Types.Result<SwapPlan> {
        if (intent.amount_in == 0) return #err(describeRejection(#amount_zero));
        if (intent.slippage == 0 or intent.slippage > MAX_SLIPPAGE) {
            return #err(
                describeRejection(#slippage_out_of_range({ slippage = intent.slippage }))
            );
        };
        if (Market.lower(intent.input_address) == Market.lower(intent.output_address)) {
            return #err(describeRejection(#same_token));
        };

        let zero_for_one = zeroForOne(intent.input_address, inputs.token0_address);
        let (cached_in, cached_out) = if (zero_for_one) {
            (inputs.cached_fee0, inputs.cached_fee1);
        } else { (inputs.cached_fee1, inputs.cached_fee0) };

        switch (checkFee("input", cached_in, inputs.live_fee_in)) {
            case (?rejection) return #err(describeRejection(rejection));
            case null {};
        };
        switch (checkFee("output", cached_out, inputs.live_fee_out)) {
            case (?rejection) return #err(describeRejection(rejection));
            case null {};
        };

        if (intent.amount_in <= cached_in) {
            return #err(
                describeRejection(
                    #amount_below_fee({
                        amount_in = intent.amount_in;
                        fee = cached_in;
                    })
                )
            );
        };

        // The pool returns `ok 0` for dust rather than an error, so a zero
        // quote has to be rejected here or it renders as a valid swap.
        if (inputs.quoted_out == 0) return #err(describeRejection(#no_quote));

        let minimum = amountOutMinimum(inputs.quoted_out, intent.slippage);
        if (minimum == 0) return #err(describeRejection(#minimum_is_zero));

        let impact = priceImpact(
            intent.amount_in,
            inputs.quoted_out,
            inputs.sqrt_price_x96,
            inputs.decimals_in,
            inputs.decimals_out,
            zero_for_one,
        );
        if (impact >= BLOCKED_PRICE_IMPACT) {
            return #err(describeRejection(#price_impact_too_high({ impact })));
        };

        // `depositFromAndSwap` returns the swap amount gross of the output
        // ledger fee, which the withdrawal then pays. Report the net.
        let expected_out = if (inputs.quoted_out > cached_out) {
            inputs.quoted_out - cached_out;
        } else { 0 };

        #ok({
            zero_for_one;
            amount_in = intent.amount_in;
            amount_out_minimum = minimum;
            quoted_out = inputs.quoted_out;
            expected_out;
            token_in_fee = cached_in;
            token_out_fee = cached_out;
            funding_amount = intent.amount_in;
            total_debit = intent.amount_in + cached_in * 2;
            price_impact = impact;
            warn = impact >= WARN_PRICE_IMPACT;
        });
    };

    /// What a failed swap means for the owner's funds.
    ///
    /// This is the most consequential judgement in the app, because it decides
    /// whether a retry is safe. The pool reports every failure as an `#err`,
    /// but they are not equivalent: a ledger error the pool *received* means
    /// the transfer never happened, while a ledger call that *threw* may have
    /// moved the tokens before the reply was lost — leaving the pool holding
    /// them with no credit, remediable only by an ICPSwap admin.
    public type FailureKind = {
        /// Nothing moved. Safe to correct the input and try again.
        #clean;
        /// The pool could not draw the input. Fund the allowance and retry.
        #allowance_shortfall;
        /// Funds may have moved without confirmation. Do not retry.
        #ambiguous;
    };

    /// Error text the pool produces when it is certain no value moved.
    ///
    /// These are either the pool's own pre-deposit guards, or a ledger error
    /// the pool received as a reply — a reply means the ledger call completed
    /// atomically, so nothing is in flight.
    let CLEAN_MARKERS : [Text] = [
        "Wrong fee cache",
        "Amount in cannot be 0",
        "Input amount should be greater than fee",
        "BadFee",
        "InsufficientFunds",
        "TooOld",
        "CreatedInFuture",
        "TemporarilyUnavailable",
        "BadBurn",
        "GenericError",
    ];

    let ALLOWANCE_MARKERS : [Text] = [
        "InsufficientAllowance",
        "insufficient allowance",
        "AllowanceChanged",
    ];

    /// Classify a failure the pool returned. A failure at the transport layer
    /// never reaches here — no reply at all is always `#ambiguous`.
    public func classifyFailure(message : Text) : FailureKind {
        // These happen after depositFrom succeeded. The pool schedules a
        // refund, whose ledger result is not confirmed by this error reply.
        // Inspect them first because a nested error may contain ledger words.
        if (Text.contains(message, #text "Slippage check failed") or
            Text.contains(message, #text "Swap trapped") or
            Text.contains(message, #text "Swap failed:")) return #ambiguous;
        for (marker in ALLOWANCE_MARKERS.vals()) {
            if (Text.contains(message, #text marker)) return #allowance_shortfall;
        };
        for (marker in CLEAN_MARKERS.vals()) {
            if (Text.contains(message, #text marker)) return #clean;
        };
        // An unrecognised deposit-stage error is the dangerous shape: the
        // pool's `transfer_from` threw and the transfer may have landed.
        #ambiguous;
    };

    public func failureText(kind : FailureKind) : Text {
        switch (kind) {
            case (#clean) "failed";
            case (#allowance_shortfall) "planned";
            case (#ambiguous) "ambiguous";
        };
    };

    /// Whether an existing allowance covers a planned swap.
    ///
    /// ICRC-2 debits the allowance by amount **and** fee, so covering only
    /// `amount_in` is short by exactly one fee — the mistake ICPSwap's own app
    /// hides behind a 1000x over-approval.
    ///
    /// This app cannot read an allowance: `icrc2_allowance` is a ledger method
    /// and ledgers belong to the Wallet. The arithmetic is kept here because it
    /// is what the funding request must satisfy, and because getting it wrong
    /// by one fee is the single most likely way a swap silently fails.
    public func allowanceCovers(allowance : Nat, plan_ : SwapPlan) : Bool {
        allowance >= plan_.amount_in + plan_.token_in_fee;
    };

    /// Amounts cross the ICPSwap wire as decimal text, not as `nat`.
    public func toAmountText(value : Nat) : Text {
        Nat.toText(value);
    };

    /// Parse an amount the caller supplied as text, rejecting anything that is
    /// not a plain decimal integer.
    public func parseAmount(value : Text) : ?Nat {
        var total : Nat = 0;
        var seen = false;
        for (char in value.chars()) {
            let digit : Nat = switch (char) {
                case ('0') 0;
                case ('1') 1;
                case ('2') 2;
                case ('3') 3;
                case ('4') 4;
                case ('5') 5;
                case ('6') 6;
                case ('7') 7;
                case ('8') 8;
                case ('9') 9;
                case (_) return null;
            };
            if (total > 10_000_000_000_000_000_000_000_000_000) return null;
            total := total * 10 + digit;
            seen := true;
        };
        if (seen) ?total else null;
    };

    /// Clamp a caller-supplied slippage into the allowed band, falling back to
    /// the default when it is absent or nonsensical.
    public func normalizeSlippage(value : ?Nat) : Nat {
        switch (value) {
            case null DEFAULT_SLIPPAGE;
            case (?raw) {
                if (raw == 0) DEFAULT_SLIPPAGE else if (raw > MAX_SLIPPAGE) MAX_SLIPPAGE else raw;
            };
        };
    };

    /// The pool key ICPSwap builds for a pair, used for display and for
    /// matching a pool the caller named.
    public func poolKey(token0 : Text, token1 : Text, fee : Nat) : Text {
        Market.lower(token0) # "_" # Market.lower(token1) # "_" # Nat.toText(fee);
    };

};
