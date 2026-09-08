// Swap arithmetic, checked against numbers a real swap would carry.
//
// The reference figures come from the live ICP/ckUSDC 0.3% pool
// (mohjv-bqaaa-aaaag-qjyia-cai) read on 2026-09-03: a 1 ICP quote of
// 2_486_235 ckUSDC, cached ledger fees of 10_000 on both sides.
import Float "mo:core/Float";
import Nat "mo:core/Nat";
import Runtime "mo:core/Runtime";
import Swap "../backend/icpswap/Swap";

func check(name : Text, actual : Nat, expected : Nat) {
    if (actual != expected) {
        Runtime.trap(
            name # ": expected " # Nat.toText(expected) # " got " # Nat.toText(actual)
        );
    };
};

func checkBool(name : Text, actual : Bool, expected : Bool) {
    if (actual != expected) Runtime.trap(name # ": wrong");
};

// --- amountOutMinimum --------------------------------------------------------
// ICPSwap computes out / (1 + s) with floor division. A naive out * (1 - s)
// gives a smaller minimum; keep the established ICPSwap convention.
check("minimum matches the ICPSwap formula",
    Swap.amountOutMinimum(2_486_235, 500),
    (2_486_235 * 100_000) / 100_500);
check("minimum at 0.5%", Swap.amountOutMinimum(2_486_235, 500), 2_473_865);
check("minimum floors", Swap.amountOutMinimum(1_000, 500), 995);
check("minimum of zero is zero", Swap.amountOutMinimum(0, 500), 0);
check("no slippage keeps the quote", Swap.amountOutMinimum(1_000, 0), 1_000);
check("dust yields no minimum", Swap.amountOutMinimum(1, 50_000), 0);

// --- maxSpendable ------------------------------------------------------------
// Two fees are withheld: the approval's own, and the one the pool's
// transfer_from consumes out of the allowance.
check("max withholds two fees", Swap.maxSpendable(100_000_000, 10_000), 99_980_000);
check("max cannot go negative", Swap.maxSpendable(10_000, 10_000), 0);
check("max at exactly two fees", Swap.maxSpendable(20_000, 10_000), 0);

// --- direction ---------------------------------------------------------------
checkBool("input as token0 is zeroForOne",
    Swap.zeroForOne("ryjl3-tyaaa-aaaaa-aaaba-cai", "ryjl3-tyaaa-aaaaa-aaaba-cai"), true);
checkBool("input as token1 is not zeroForOne",
    Swap.zeroForOne("xevnm-gaaaa-aaaar-qafnq-cai", "ryjl3-tyaaa-aaaaa-aaaba-cai"), false);

// --- slippage bounds ---------------------------------------------------------
check("absent slippage uses the default", Swap.normalizeSlippage(null), 500);
check("zero slippage uses the default", Swap.normalizeSlippage(?0), 500);
check("excess slippage is clamped", Swap.normalizeSlippage(?999_999), 50_000);
check("valid slippage is kept", Swap.normalizeSlippage(?1_000), 1_000);

// --- planning against the real pool ------------------------------------------
let inputs : Swap.QuoteInputs = {
    token0_address = "ryjl3-tyaaa-aaaaa-aaaba-cai";
    token1_address = "xevnm-gaaaa-aaaar-qafnq-cai";
    cached_fee0 = 10_000;
    cached_fee1 = 10_000;
    live_fee_in = ?10_000;
    live_fee_out = ?10_000;
    quoted_out = 2_486_235;
    sqrt_price_x96 = 12_511_329_982_852_664_487_742_853_417;
    decimals_in = 8;
    decimals_out = 6;
};
let intent : Swap.SwapIntent = {
    input_address = "ryjl3-tyaaa-aaaaa-aaaba-cai";
    output_address = "xevnm-gaaaa-aaaar-qafnq-cai";
    amount_in = 100_000_000;
    slippage = 500;
};

switch (Swap.plan(intent, inputs)) {
    case (#err(message)) Runtime.trap("plan rejected a good swap: " # message);
    case (#ok(value)) {
        checkBool("plan direction", value.zero_for_one, true);
        check("plan minimum", value.amount_out_minimum, 2_473_865);
        // depositFromAndSwap reports gross of the output ledger fee.
        check("plan reports the net output", value.expected_out, 2_476_235);
        // Wallet adds the transfer fee, so the ask is the bare amount.
        check("plan funding is the bare amount", value.funding_amount, 100_000_000);
        // The balance must cover the swap, the approval fee and the pull fee.
        check("plan total debit", value.total_debit, 100_020_000);
        if (value.price_impact > 0.01) {
            Runtime.trap("price impact should be small at this size");
        };
        // ICRC-2 debits amount AND fee, so the amount alone is short by one.
        checkBool("an allowance of exactly the amount is short",
            Swap.allowanceCovers(100_000_000, value), false);
        checkBool("amount plus fee is enough",
            Swap.allowanceCovers(100_010_000, value), true);
        checkBool("a larger allowance is fine",
            Swap.allowanceCovers(500_000_000, value), true);
    };
};

// A stale fee cache must refuse rather than pick a side: matching the cache
// fails at the ledger, matching the ledger fails at the pool.
switch (Swap.plan(intent, { inputs with live_fee_in = ?20_000 })) {
    case (#ok(_)) Runtime.trap("plan accepted a stale input fee cache");
    case (#err(_)) {};
};
switch (Swap.plan(intent, { inputs with live_fee_out = ?5_000 })) {
    case (#ok(_)) Runtime.trap("plan accepted a stale output fee cache");
    case (#err(_)) {};
};

// With no live fee available — the shape this app actually runs in, since
// ledgers belong to the Wallet — the pool's cache is trusted and the plan
// proceeds. Supplying a live fee later only adds an earlier refusal.
switch (Swap.plan(intent, { inputs with live_fee_in = null; live_fee_out = null })) {
    case (#err(message)) Runtime.trap("plan needs a live fee it cannot read: " # message);
    case (#ok(value)) check("plan without live fees", value.amount_out_minimum, 2_473_865);
};

// --- failure classification --------------------------------------------------
// This decides whether a retry is safe, so each shape is pinned.
func checkKind(name : Text, message : Text, expected : Swap.FailureKind) {
    if (Swap.classifyFailure(message) != expected) {
        Runtime.trap(name # ": misclassified");
    };
};
checkKind("allowance shortfall",
    "swap: internal error: #InsufficientAllowance { allowance = 0 }", #allowance_shortfall);
checkKind("stale fee cache is clean",
    "swap: internal error: Wrong fee cache (expected: 10000, received: 20000)", #clean);
checkKind("slippage failure awaits refund settlement",
    "swap: internal error: Slippage check failed: minimum amount requirement not met", #ambiguous);
checkKind("a received ledger error is clean",
    "swap: internal error: #BadFee { expected_fee = 10_000 }", #clean);
checkKind("insufficient funds is clean",
    "swap: internal error: #InsufficientFunds { balance = 0 }", #clean);
checkKind("a swap trap only schedules an unconfirmed refund",
    "swap: internal error: Swap trapped: something broke", #ambiguous);
checkKind("post-deposit error overrides nested ledger marker",
    "swap: internal error: Swap trapped: InsufficientFunds", #ambiguous);
checkKind("duplicate ledger effect is not proof nothing moved",
    "swap: internal error: Duplicate", #ambiguous);
// Anything unrecognised at the deposit stage may have moved funds.
checkKind("an unknown deposit error is ambiguous",
    "swap: internal error: canister_error: IC0503 no reply", #ambiguous);
checkKind("empty text is ambiguous", "", #ambiguous);

// The pool answers dust with ok 0, not an error.
switch (Swap.plan(intent, { inputs with quoted_out = 0 })) {
    case (#ok(_)) Runtime.trap("plan accepted a zero quote");
    case (#err(_)) {};
};

switch (Swap.plan({ intent with amount_in = 9_999 }, inputs)) {
    case (#ok(_)) Runtime.trap("plan accepted an amount below the ledger fee");
    case (#err(_)) {};
};
switch (Swap.plan({ intent with amount_in = 0 }, inputs)) {
    case (#ok(_)) Runtime.trap("plan accepted a zero amount");
    case (#err(_)) {};
};
switch (Swap.plan({ intent with output_address = "ryjl3-tyaaa-aaaaa-aaaba-cai" }, inputs)) {
    case (#ok(_)) Runtime.trap("plan accepted a self swap");
    case (#err(_)) {};
};

// A quote far under the pool's mid price is a thin pool, not a bargain.
switch (Swap.plan(intent, { inputs with quoted_out = 1_000_000 })) {
    case (#ok(_)) Runtime.trap("plan accepted a 60% price impact");
    case (#err(_)) {};
};

// --- amount parsing ----------------------------------------------------------
switch (Swap.parseAmount("100000000")) {
    case (?value) check("parsed a plain integer", value, 100_000_000);
    case null Runtime.trap("failed to parse a plain integer");
};
switch (Swap.parseAmount("1.5")) {
    case (?_) Runtime.trap("parsed a decimal as an integer");
    case null {};
};
switch (Swap.parseAmount("")) {
    case (?_) Runtime.trap("parsed empty text");
    case null {};
};

ignore Float.abs(0.0);
