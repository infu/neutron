import Int "mo:core/Int";
import Result "mo:core/Result";

// Integer Q96 liquidity calculations. Tick factors are the canonical protocol
// constants used by ICPSwap-V3-Service's TickMath. The formulas intentionally
// retain the protocol's intermediate floor when deriving liquidity from token0.
// Source: https://github.com/ICPSwap-Labs/icpswap-v3-service
//
// MIT License
// Copyright (c) 2024 ICPSwap-V3-Service
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

module {
    public type Amounts = { amount0 : Nat; amount1 : Nat };
    public type Preview = { liquidity : Nat; amount0 : Nat; amount1 : Nat };

    public let MIN_TICK : Int = -887_272;
    public let MAX_TICK : Int = 887_272;
    public let MIN_SQRT_RATIO : Nat = 4_295_128_739;
    public let MAX_SQRT_RATIO : Nat = 1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342;
    public let Q96 : Nat = 79_228_162_514_264_337_593_543_950_336;
    public let MAX_LIQUIDITY : Nat = 340_282_366_920_938_463_463_374_607_431_768_211_455;
    let Q128 : Nat = 340_282_366_920_938_463_463_374_607_431_768_211_456;
    let Q32 : Nat = 4_294_967_296;
    let MAX_AMOUNT : Nat = 115_792_089_237_316_195_423_570_985_008_687_907_853_269_984_665_640_564_039_457_584_007_913_129_639_935;

    let tickFactors : [Nat] = [
        0xfffcb933bd6fad37aa2d162d1a594001,
        0xfff97272373d413259a46990580e213a,
        0xfff2e50f5f656932ef12357cf3c7fdcc,
        0xffe5caca7e10e4e61c3624eaa0941cd0,
        0xffcb9843d60f6159c9db58835c926644,
        0xff973b41fa98c081472e6896dfb254c0,
        0xff2ea16466c96a3843ec78b326b52861,
        0xfe5dee046a99a2a811c461f1969c3053,
        0xfcbe86c7900a88aedcffc83b479aa3a4,
        0xf987a7253ac413176f2b074cf7815e54,
        0xf3392b0822b70005940c7a398e4b70f3,
        0xe7159475a2c29b7443b29c7fa6e889d9,
        0xd097f3bdfd2022b8845ad8f792aa5825,
        0xa9f746462d870fdf8a65dc1f90e061e5,
        0x70d869a156d2a1b890bb3df62baf32f7,
        0x31be135f97d08fd981231505542fcfa6,
        0x9aa508b5b7a84e1c677de54f3e99bc9,
        0x5d6af8dedb81196699c329225ee604,
        0x2216e584f5fa1ea926041bedfe98,
        0x48a170391f7dc42444e8fa2,
    ];

    func divide(numerator : Nat, denominator : Nat, roundUp : Bool) : Nat {
        let quotient = numerator / denominator;
        if (roundUp and numerator % denominator != 0) quotient + 1 else quotient;
    };

    public func sqrtRatioAtTick(tick : Int) : Result.Result<Nat, Text> {
        if (tick < MIN_TICK or tick > MAX_TICK) return #err("Tick is outside the protocol range [-887272, 887272].");
        var bits = Int.abs(tick);
        var ratio = Q128;
        for (factor in tickFactors.vals()) {
            if (bits % 2 == 1) ratio := ratio * factor / Q128;
            bits /= 2;
        };
        if (tick > 0) ratio := MAX_AMOUNT / ratio;
        #ok(divide(ratio, Q32, true));
    };

    func range(sqrtPriceX96 : Nat, tickLower : Int, tickUpper : Int) : Result.Result<(Nat, Nat), Text> {
        if (tickLower >= tickUpper) return #err("The lower tick must be less than the upper tick.");
        if (sqrtPriceX96 < MIN_SQRT_RATIO or sqrtPriceX96 >= MAX_SQRT_RATIO) return #err("Pool sqrt price is outside the initialized protocol range.");
        let lower = switch (sqrtRatioAtTick(tickLower)) { case (#ok(value)) value; case (#err(error)) return #err(error) };
        let upper = switch (sqrtRatioAtTick(tickUpper)) { case (#ok(value)) value; case (#err(error)) return #err(error) };
        #ok((lower, upper));
    };

    func liquidity0(amount : Nat, lower : Nat, upper : Nat) : Nat {
        let intermediate = lower * upper / Q96;
        amount * intermediate / (upper - lower);
    };

    func liquidity1(amount : Nat, lower : Nat, upper : Nat) : Nat {
        amount * Q96 / (upper - lower);
    };

    // The two successive divisions in amount0 have the same rounding direction
    // as SqrtPriceMath. No floating point conversion is used for token atoms.
    func amount0(liquidity : Nat, lower : Nat, upper : Nat, roundUp : Bool) : Nat {
        divide(divide(liquidity * Q96 * (upper - lower), upper, roundUp), lower, roundUp);
    };

    func amount1(liquidity : Nat, lower : Nat, upper : Nat, roundUp : Bool) : Nat {
        divide(liquidity * (upper - lower), Q96, roundUp);
    };

    func atPrice(liquidity : Nat, sqrtPriceX96 : Nat, lower : Nat, upper : Nat, roundUp : Bool) : Amounts {
        if (sqrtPriceX96 <= lower) {
            { amount0 = amount0(liquidity, lower, upper, roundUp); amount1 = 0 };
        } else if (sqrtPriceX96 >= upper) {
            { amount0 = 0; amount1 = amount1(liquidity, lower, upper, roundUp) };
        } else {
            {
                amount0 = amount0(liquidity, sqrtPriceX96, upper, roundUp);
                amount1 = amount1(liquidity, lower, sqrtPriceX96, roundUp);
            };
        };
    };

    public func amounts(liquidity : Nat, sqrtPriceX96 : Nat, tickLower : Int, tickUpper : Int, roundUp : Bool) : Result.Result<Amounts, Text> {
        if (liquidity > MAX_LIQUIDITY) return #err("Liquidity exceeds the protocol uint128 range.");
        let (lower, upper) = switch (range(sqrtPriceX96, tickLower, tickUpper)) { case (#ok(value)) value; case (#err(error)) return #err(error) };
        #ok(atPrice(liquidity, sqrtPriceX96, lower, upper, roundUp));
    };

    public func preview(amount0Max : Nat, amount1Max : Nat, sqrtPriceX96 : Nat, tickLower : Int, tickUpper : Int) : Result.Result<Preview, Text> {
        if (amount0Max > MAX_AMOUNT or amount1Max > MAX_AMOUNT) return #err("Token amount exceeds the protocol uint256 range.");
        let (lower, upper) = switch (range(sqrtPriceX96, tickLower, tickUpper)) { case (#ok(value)) value; case (#err(error)) return #err(error) };
        let liquidity = if (sqrtPriceX96 <= lower) {
            liquidity0(amount0Max, lower, upper);
        } else if (sqrtPriceX96 >= upper) {
            liquidity1(amount1Max, lower, upper);
        } else {
            let from0 = liquidity0(amount0Max, sqrtPriceX96, upper);
            let from1 = liquidity1(amount1Max, lower, sqrtPriceX96);
            // Upstream checks both intermediate uint128 values before taking
            // their minimum; return the same overflow as an ordinary error.
            if (from0 > MAX_LIQUIDITY or from1 > MAX_LIQUIDITY) return #err("Liquidity exceeds the protocol uint128 range.");
            if (from0 < from1) from0 else from1;
        };
        if (liquidity > MAX_LIQUIDITY) return #err("Liquidity exceeds the protocol uint128 range.");
        let required = atPrice(liquidity, sqrtPriceX96, lower, upper, true);
        #ok({ liquidity; amount0 = required.amount0; amount1 = required.amount1 });
    };
};
