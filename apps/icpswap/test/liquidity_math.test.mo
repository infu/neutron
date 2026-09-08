import Result "mo:core/Result";
import Runtime "mo:core/Runtime";
import Math "../backend/icpswap/LiquidityMath";

func ok<T>(result : Result.Result<T, Text>) : T {
    switch (result) { case (#ok(value)) value; case (#err(message)) Runtime.trap(message) };
};

// Independent fixtures from @uniswap/v3-sdk 3.31.3. TickMath,
// maxLiquidityForAmounts(useFullPrecision=false), and SqrtPriceMath were used
// as the oracle. These include every bit of the protocol tick exponent.
let tickFixtures : [(Int, Nat)] = [
    (-887272, 4295128739),
    (-887271, 4295343490),
    (-524288, 327099227039063107),
    (-262144, 160982827401375763736069),
    (-131072, 112935262922445818024280874),
    (-65536, 2991262837734375505310244437),
    (-32768, 15394552875315951095595078918),
    (-16384, 34923947901690145425342545399),
    (-8192, 52601903197458624361810746400),
    (-4096, 64556580881331167221767657720),
    (-2048, 71517125791179246722882903168),
    (-1024, 75273969370139069689486932538),
    (-512, 77225761753129597550065289037),
    (-256, 78220554859095770638340573244),
    (-128, 78722746600537056721934508530),
    (-64, 78975050245229982702767995060),
    (-32, 79101505139923049997807806615),
    (-16, 79164808496886665658930780292),
    (-8, 79196479170490597288862688491),
    (-4, 79212319258289487113226433917),
    (-2, 79220240490215316061937756561),
    (-1, 79224201403219477170569942574),
    (0, 79228162514264337593543950336),
    (1, 79232123823359799118286999568),
    (2, 79236085330515764027303304732),
    (4, 79244008939048815603706035062),
    (8, 79259858533276714757314932306),
    (16, 79291567232598584799939703905),
    (32, 79355022692464371645785046467),
    (64, 79482085999252804386437311142),
    (128, 79736823300114093921829183327),
    (256, 80248749790819932309965073893),
    (512, 81282483887344747381513967012),
    (1024, 83390072131320151908154831282),
    (2048, 87770609709833776024991924139),
    (4096, 97234110755111693312479820774),
    (8192, 119332217159966728226237229891),
    (16384, 179736315981702064433883588728),
    (32768, 407748233172238350107850275305),
    (65536, 2098478828474011932436660412518),
    (131072, 55581415166113811149459800483534),
    (262144, 38992368544603139932233054999993536),
    (524288, 19190206568837448476620805525116361302670),
    (887271, 1461373636630004318706518188784493106690254656249),
    (887272, 1461446703485210103287273052203988822378723970342),
];
for ((tick, expected) in tickFixtures.vals()) {
    assert (ok(Math.sqrtRatioAtTick(tick)) == expected);
};

// (sqrt price, lower tick, upper tick, max token0, max token1, liquidity,
//  mint token0, mint token1, burn token0, burn token1). Atomic units cover
// 6/8-decimal ICP/ckUSDC, 6/18-decimal USDC/WETH, asymmetric amounts,
// both one-sided ranges and boundaries, full range, zero and dust.
let fixtures : [(Nat, Int, Int, Nat, Nat, Nat, Nat, Nat, Nat, Nat)] = [
    (79228162514264337593543950336, -60, 60, 1000000, 1000000, 333850249, 1000000, 1000000, 999999, 999999),
    (79228162514264337593543950336, -60, 120, 1000000, 1000000, 167175499, 1000000, 500750, 999999, 500749),
    (12277582631158410175998358561, -37800, -36720, 100000000, 2500000, 548701914, 100000000, 2128302, 99999999, 2128301),
    (1588318612778845690295197348304277, 198030, 198230, 2000000, 800000000000000, 7805851670582, 2000000, 757086801068748, 1999999, 757086801068747),
    (1589828156904972468151112507917187, 198040, 198240, 700000, 300000000000000, 2828438974027, 660895, 299999999999965, 660894, 299999999999964),
    (78754240422856966435523493930, 0, 60, 1000000, 0, 333850249, 1000000, 0, 999999, 0),
    (79704936542881920863903188246, -60, 0, 0, 1000000, 333850249, 0, 1000000, 0, 999999),
    (78990846045029531151608375686, -60, 60, 123456789, 0, 20577129426, 123456789, 0, 123456788, 0),
    (79466191966197645195421774833, -60, 60, 0, 987654321, 164617036914, 0, 987654321, 0, 987654320),
    (79228162514264337593543950336, -887272, 887272, 1000000000000000000, 1000000000000000000, 1000000000000000000, 1000000000000000000, 1000000000000000000, 999999999999999999, 999999999999999999),
    (79228162514264337593543950336, -60, 60, 1, 0, 0, 0, 0, 0, 0),
    (79228162514264337593543950336, -60, 60, 0, 0, 0, 0, 0, 0, 0),
    (4295128739, -887272, -887271, 1, 1, 0, 0, 0, 0, 0),
    (1461373636630004318706518188784493106690254656249, 887270, 887272, 1, 1, 0, 0, 0, 0, 0),
    (79228162514264337593543950336, -1, 1, 1, 1, 20001, 1, 1, 0, 0),
    // Prices inside a tick, including the observed ICP/ckUSDC pool price.
    (12277588773922894909248192137, -37800, -36720, 100000000, 2500000, 548711634, 100000000, 2128383, 99999999, 2128382),
    (1589867901615302173422195997587704, 198040, 198240, 700000, 300000000000000, 2815124533498, 654277, 299999999999904, 654276, 299999999999903),
    (79228162514264337593543950337, -60, 60, 1000000, 1000000, 333850249, 1000000, 1000000, 999999, 999999),
];
for ((sqrt, lower, upper, max0, max1, liquidity, mint0, mint1, burn0, burn1) in fixtures.vals()) {
    let quote = ok(Math.preview(max0, max1, sqrt, lower, upper));
    assert (quote == { liquidity; amount0 = mint0; amount1 = mint1 });
    assert (quote.amount0 <= max0 and quote.amount1 <= max1);
    assert (ok(Math.amounts(liquidity, sqrt, lower, upper, true)) == { amount0 = mint0; amount1 = mint1 });
    assert (ok(Math.amounts(liquidity, sqrt, lower, upper, false)) == { amount0 = burn0; amount1 = burn1 });
    assert (mint0 >= burn0 and mint0 <= burn0 + 1);
    assert (mint1 >= burn1 and mint1 <= burn1 + 1);
};

func isError<T>(result : Result.Result<T, Text>) : Bool {
    switch (result) { case (#ok(_)) false; case (#err(_)) true };
};

// Invalid protocol inputs must return ordinary errors without trapping.
assert (isError(Math.sqrtRatioAtTick(-887273)));
assert (isError(Math.sqrtRatioAtTick(887273)));
assert (isError(Math.preview(1, 1, Math.Q96, 1, 1)));
assert (isError(Math.preview(1, 1, Math.Q96, 2, 1)));
assert (isError(Math.preview(1, 1, Math.Q96, -887273, 1)));
assert (isError(Math.preview(1, 1, Math.Q96, 0, 887273)));
assert (isError(Math.preview(1, 1, 0, -60, 60)));
assert (isError(Math.preview(1, 1, Math.MIN_SQRT_RATIO - 1, -60, 60)));
assert (isError(Math.preview(1, 1, Math.MAX_SQRT_RATIO, -60, 60)));
assert (isError(Math.amounts(1, 0, -60, 60, false)));
assert (isError(Math.amounts(1, Math.Q96, 60, -60, true)));
assert (isError(Math.amounts(Math.MAX_LIQUIDITY + 1, Math.Q96, -60, 60, true)));

let maxAmount : Nat = 115792089237316195423570985008687907853269984665640564039457584007913129639935;
assert (isError(Math.preview(maxAmount + 1, 0, Math.Q96, 60, 120)));
assert (isError(Math.preview(0, maxAmount + 1, Math.Q96, -120, -60)));
assert (isError(Math.preview(maxAmount, maxAmount, Math.Q96, -1, 1)));
// Upstream validates each token liquidity before selecting the smaller value.
assert (isError(Math.preview(maxAmount, 1, Math.Q96, -1, 1)));
assert (isError(Math.preview(1, maxAmount, Math.Q96, -1, 1)));
// Wide-range maximum uint128 arithmetic remains exact and finite.
let maximum = ok(Math.amounts(Math.MAX_LIQUIDITY, Math.Q96, Math.MIN_TICK, Math.MAX_TICK, true));
assert (maximum.amount0 > 0 and maximum.amount1 > 0);
let empty = ok(Math.amounts(0, Math.Q96, Math.MIN_TICK, Math.MAX_TICK, true));
assert (empty == { amount0 = 0; amount1 = 0 });
