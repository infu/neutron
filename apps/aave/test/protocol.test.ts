import { expect, test } from "bun:test";
import { decodeFunctionData, encodeFunctionResult, getAddress, parseAbi, type Abi, type Hex } from "viem";
import type { EvmAccount } from "neutron-tools/evm_wallet";
import { CHAINS, EFFECTS, encode, MAX_UINT256, RAY, rayApy, uint, type Market, type Reader, type Reserve } from "../src/contracts.ts";
import { calculatePosition, collateralParameters, parseInput, quotePlan, type Input } from "../src/plans.ts";
import { decodeConfiguration, MULTICALL_READ, readBatch, readEModes, EMODE_DATA } from "../src/markets.ts";

const owner = getAddress("0x1111111111111111111111111111111111111111");
const asset = getAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
const account: EvmAccount = { accountId: "main", address: owner, publicKey: "", keyFingerprint: "fixture", namespaceVersion: "1" };
const erc20 = parseAbi(["function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)", "function borrowAllowance(address,address) view returns (uint256)"]);
const independent = parseAbi(["function supply(address,uint256,address,uint16)", "function withdraw(address,uint256,address) returns (uint256)", "function borrow(address,uint256,uint256,uint16,address)", "function repay(address,uint256,uint256,address) returns (uint256)", "function repayWithATokens(address,uint256,uint256) returns (uint256)", "function setUserUseReserveAsCollateral(address,bool)", "function setUserEMode(uint8)", "function repayETH(address,uint256,address) payable", "function borrowETH(address,uint256,uint16)", "function withdrawETH(address,uint256,address)", "function depositETH(address,address,uint16) payable", "function approveDelegation(address,uint256)"]);
function reserve(overrides: Partial<Reserve> = {}): Reserve {
  return { chainId: "1", address: asset, name: "USD Coin", symbol: "USDC", decimals: 6, id: 3, aTokenAddress: getAddress("0x3333333333333333333333333333333333333333"), variableDebtTokenAddress: getAddress("0x4444444444444444444444444444444444444444"),
    supplyRateRay: "30000000000000000000000000", borrowRateRay: "50000000000000000000000000", supplyApy: 0.0304545, borrowApy: 0.0512711,
    priceBase: "100000000", totalSupplied: "1000000000000", totalDebt: "500000000000", availableLiquidity: "500000000000", walletBalance: "1000000000", supplied: "1000000000", variableDebt: "100000000", collateralEnabled: true,
    ltvBps: 7500, liquidationThresholdBps: 8000, liquidationBonusBps: 10500, active: true, frozen: false, paused: false, borrowingEnabled: true,
    supplyCap: "2000000", borrowCap: "2000000", debtCeiling: "0", isolationModeTotalDebt: "0", borrowableInIsolation: true, siloedBorrowing: false, accruedToTreasury: "0", ...overrides };
}
function snapshot(rows = [reserve()]): Market {
  const position = calculatePosition(rows, [], 0);
  return { chainId: "1", name: "Ethereum Core", pool: CHAINS["1"].pool, accountAddress: owner, blockNumber: "123", fetchedAtMs: 1000, baseCurrencyUnit: "100000000", baseCurrencyUsd: "1", reserves: rows, account: position, eModes: [], rewards: [], errors: [] };
}
function input(kind: Input["kind"], overrides: Record<string, unknown> = {}): Input { return parseInput({ kind, chainId: "1", asset, amount: "10000000", ...overrides }); }
function reader(allowance = 0n, rejectSimulation = false): Reader {
  return async (_chainId, to, data, blockNumber) => {
    expect(blockNumber).toBe("123");
    if (["0xdd62ed3e", encode("function borrowAllowance(address,address) view returns (uint256)", [owner, owner]).slice(0, 10)].includes(data.slice(0, 10))) return { data: encodeFunctionResult({ abi: erc20, functionName: "allowance", result: allowance }), blockNumber: "123" };
    if (to.toLowerCase() === "0xca11bde05977b3631167028862be2a173976ca11") {
      const calls = (decodeFunctionData({ abi: parseAbi([MULTICALL_READ]), data }).args as unknown as readonly [readonly { callData: Hex }[]])[0];
      return { data: encodeFunctionResult({ abi: parseAbi([MULTICALL_READ]), functionName: "aggregate3", result: calls.map(c => ({ success: true, returnData: encodeFunctionResult({ abi: parseAbi(["function identity() view returns (address)"]), functionName: "identity", result: c.callData === encode("function POOL() view returns (address)") ? CHAINS["1"].pool : CHAINS["1"].weth }) })) }), blockNumber: "123" };
    }
    if (rejectSimulation) throw new Error("Protocol health factor validation reverted");
    return { data: "0x", blockNumber: "123" };
  };
}

test("atomic parser preserves large budgets and refuses malformed quantities", () => {
  expect(uint("900719925474099300000000000000", "amount")).toBe(900719925474099300000000000000n);
  for (const amount of ["1e6", "1.2", "-1", "01", 100, (MAX_UINT256 + 1n).toString()]) expect(() => uint(amount, "amount")).toThrow();
  expect(() => parseInput({ kind: "borrow", chainId: "1", asset, amount: "1", all: true })).toThrow();
  expect(() => input("repay", { all: true, maxPaymentAmount: MAX_UINT256.toString() })).toThrow("finite");
  expect(() => input("borrow", { useNative: true })).toThrow("WETH");
  expect(() => input("emode", { eModeId: 256 })).toThrow();
});
test("current reserve bitmap separates flags, decimal precision and whole-token caps", () => {
  const bits = 7500n | (8000n << 16n) | (10500n << 32n) | (6n << 48n) | (1n << 56n) | (1n << 58n) | (1n << 60n) | (777n << 80n) | (888n << 116n);
  expect(decodeConfiguration(bits)).toMatchObject({ ltvBps: 7500, liquidationThresholdBps: 8000, decimals: 6, active: true, frozen: false, paused: true, borrowingEnabled: true, borrowCap: "777", supplyCap: "888" });
  expect(rayApy("0")).toBe(0); expect(rayApy((RAY / 20n).toString())).toBeCloseTo(0.051271096, 8); expect(rayApy((1n << 127n).toString())).toBeNull();
});
test("independent pool calldata preserves reserve, exact value, variable debt mode and wallet beneficiary", async () => {
  for (const kind of ["supply", "withdraw", "borrow", "repay", "repay_atokens"] as const) {
    const plan = await quotePlan(reader(), account, input(kind), { market: snapshot(), now: 1000 });
    const decoded = decodeFunctionData({ abi: independent, data: plan.steps.at(-1)!.transaction.data });
    expect(decoded.functionName).toBe(kind === "repay_atokens" ? "repayWithATokens" : kind);
    expect(decoded.args![0]).toBe(asset); expect(decoded.args![1]).toBe(10000000n);
    if (kind === "borrow" || kind === "repay" || kind === "repay_atokens") expect(decoded.args![2]).toBe(2n);
    expect(plan.steps.at(-1)!.transaction.to).toBe(CHAINS["1"].pool); expect(plan.steps.at(-1)!.transaction.valueWei).toBe("0");
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan);
  }
});
test("full repay reduces an existing unlimited grant to the reviewed cap and closes accrued debt", async () => {
  const plan = await quotePlan(reader(MAX_UINT256), account, input("repay", { all: true, maxPaymentAmount: "100100000" }), { market: snapshot() });
  expect(plan.steps).toHaveLength(2);
  expect(decodeFunctionData({ abi: erc20, data: plan.steps[0]!.transaction.data }).args).toEqual([CHAINS["1"].pool, 100100000n]);
  expect(decodeFunctionData({ abi: independent, data: plan.steps[1]!.transaction.data }).args).toEqual([asset, MAX_UINT256, 2n, owner]);
  expect(plan.preview.maximumPayment).toBe("100100000"); expect(plan.preview.after.totalDebtBase).toBe("0");
  await expect(quotePlan(reader(), account, input("repay", { all: true }), { market: snapshot() })).rejects.toThrow("maximum payment");
  await expect(quotePlan(reader(), account, input("repay", { all: true, maxPaymentAmount: "99999999" }), { market: snapshot() })).rejects.toThrow("below");
});
test("withdrawal uses the current supplied atoms without changing an explicit amount into a full withdrawal", async () => {
  const usdt = reserve({ address: getAddress("0xdac17f958d2ee523a2206206994597c13d831ec7"), symbol: "USDT", supplied: "399999", variableDebt: "0" });
  const market = snapshot([usdt]);
  const requested = input("withdraw", { asset: usdt.address, amount: "400000" });
  await expect(quotePlan(reader(), account, requested, { market })).rejects.toThrow("currently 0.399999 USDT at block 123");
  expect(requested.amount).toBe("400000");
  expect(requested.all).toBe(false);

  const exact = await quotePlan(reader(), account, input("withdraw", { asset: usdt.address, amount: "399999" }), { market });
  expect(exact.preview.amount).toBe("399999");
  expect(decodeFunctionData({ abi: independent, data: exact.steps.at(-1)!.transaction.data }).args).toEqual([usdt.address, 399999n, owner]);

  const all = await quotePlan(reader(), account, input("withdraw", { asset: usdt.address, amount: "400000", all: true }), { market });
  expect(all.preview.amount).toBe("399999");
  expect(all.preview.after.totalCollateralBase).toBe("0");
  expect(decodeFunctionData({ abi: independent, data: all.steps.at(-1)!.transaction.data }).args).toEqual([usdt.address, MAX_UINT256, owner]);
});
test("reducing a pre-existing USDT full-repay allowance includes its required zero reset", async () => {
  const usdt = reserve({ address: getAddress("0xdac17f958d2ee523a2206206994597c13d831ec7"), symbol: "USDT" });
  const plan = await quotePlan(reader(MAX_UINT256), account, input("repay", { asset: usdt.address, all: true, maxPaymentAmount: "100100000" }), { market: snapshot([usdt]) });
  expect(plan.steps).toHaveLength(3);
  expect(plan.steps.slice(0, 2).map(s => decodeFunctionData({ abi: erc20, data: s.transaction.data }).args![1])).toEqual([0n, 100100000n]);
});
test("repay from supplied tokens needs no approval and honestly previews a remaining debt", async () => {
  const market = snapshot([reserve({ supplied: "40000000", collateralEnabled: false })]);
  const plan = await quotePlan(reader(), account, input("repay_atokens", { all: true }), { market });
  expect(plan.steps).toHaveLength(1); expect(plan.preview.amount).toBe("40000000"); expect(plan.preview.after.totalDebtBase).toBe("6000000000");
  expect(plan.preview.warnings.join(" ")).toContain("remaining borrow");
  expect(decodeFunctionData({ abi: independent, data: plan.steps[0]!.transaction.data }).args).toEqual([asset, MAX_UINT256, 2n]);
});
test("native gateway effects carry exact value/delegation and full repayment budget", async () => {
  const weth = reserve({ address: CHAINS["1"].weth, symbol: "WETH", decimals: 18, priceBase: "200000000000", supplied: "1000000000000000000", variableDebt: "100000000000000000", walletBalance: "0", totalSupplied: "1000000000000000000000", totalDebt: "500000000000000000000", availableLiquidity: "500000000000000000000" });
  const market = snapshot([weth]);
  for (const kind of ["supply", "withdraw", "borrow", "repay"] as const) {
    const all = kind === "repay" || kind === "withdraw";
    const budget = kind === "withdraw" ? "1001000000000000000" : "100100000000000000";
    const plan = await quotePlan(reader(MAX_UINT256), account, input(kind, { asset: weth.address, useNative: true, amount: "10000000000000000", all, maxPaymentAmount: all ? budget : null }), { market });
    const tx = plan.steps.at(-1)!.transaction, decoded = decodeFunctionData({ abi: independent, data: tx.data });
    expect(tx.to).toBe(CHAINS["1"].gateway); expect(decoded.functionName).toBe(kind === "supply" ? "depositETH" : `${kind}ETH`);
    expect(tx.valueWei).toBe(kind === "supply" ? "10000000000000000" : kind === "repay" ? budget : "0");
    if (kind === "withdraw") expect(decodeFunctionData({ abi: erc20, data: plan.steps[0]!.transaction.data }).args![1]).toBe(BigInt(budget));
  }
});
test("paused/frozen/capped reserves and unsupported identities fail before effects", async () => {
  for (const [kind, patch, message] of [["supply", { frozen: true }, "frozen"], ["repay", { paused: true }, "paused"], ["borrow", { borrowingEnabled: false }, "not enabled"], ["supply", { supplyCap: "1" }, "supply cap"], ["borrow", { availableLiquidity: "1" }, "liquidity"]] as const) {
    await expect(quotePlan(reader(), account, input(kind), { market: snapshot([reserve(patch)]) })).rejects.toThrow(message);
  }
  await expect(quotePlan(reader(), account, input("supply", { asset: owner }), { market: snapshot() })).rejects.toThrow("not a registered reserve");
});
test("health previews use per-reserve eMode bitmaps, including isolated zero-LTV collateral", () => {
  const mode = { id: 7, label: "Correlated assets", ltvBps: 9000, liquidationThresholdBps: 9500, liquidationBonusBps: 10100, collateralBitmap: "8", borrowableBitmap: "8", ltvzeroBitmap: "0", isolated: true };
  expect(collateralParameters(reserve(), mode)).toEqual({ ltvBps: 9000, liquidationThresholdBps: 9500 });
  expect(collateralParameters(reserve({ id: 4 }), mode)).toEqual({ ltvBps: 0, liquidationThresholdBps: 8000 });
  const p = calculatePosition([reserve()], [mode], 7); expect(p.healthFactor).toBe("9500000000000000000"); expect(p.availableBorrowsBase).toBe("80000000000");
});
test("position math preserves tiny debts and applies Aave's integer average LTV before capacity", () => {
  const rows = [reserve({ supplied: "1000000", decimals: 0, variableDebt: "0", ltvBps: 8000 }), reserve({ address: owner, supplied: "1000001", decimals: 0, variableDebt: "0", ltvBps: 7500 })];
  const mixed = calculatePosition(rows, [], 0); expect(mixed.ltvBps).toBe(7749); expect(mixed.availableBorrowsBase).toBe("154980077490000");
  const dust = calculatePosition([reserve({ supplied: "0", decimals: 18, variableDebt: "1" })], [], 0);
  expect(dust.totalDebtBase).toBe("1"); expect(dust.healthFactor).toBe("0");
  const zeroThreshold = calculatePosition([reserve({ supplied: "1000000", variableDebt: "0", liquidationThresholdBps: 0, ltvBps: 0 })], [], 0);
  expect(zeroThreshold.totalCollateralBase).toBe("100000000");
});
test("actual Pool simulation rejects invalid health changes instead of inventing an app floor", async () => {
  await expect(quotePlan(reader(0n, true), account, input("withdraw"), { market: snapshot() })).rejects.toThrow("Protocol health factor");
  // A wallet repayment remains possible while an account is already liquidatable.
  const market = snapshot([reserve({ supplied: "1000000", variableDebt: "100000000" })]);
  const plan = await quotePlan(reader(), account, input("repay"), { market }); expect(plan.preview.after.healthFactor).not.toBeNull();
});
test("reward read failures are unavailable observations, not a zero-reward claim", async () => {
  const market = snapshot();
  market.errors = ["Rewards are unavailable: Contract reverted"];
  await expect(quotePlan(reader(), account, input("rewards", { asset: null }), { market })).rejects.toThrow("Rewards are unavailable: Contract reverted");
  market.errors = [];
  await expect(quotePlan(reader(), account, input("rewards", { asset: null }), { market })).rejects.toThrow("No claimable Aave incentives");
});
test("all nested reads reject inconsistent pinned blocks and optional reads alone may fail", async () => {
  await expect(readBatch(async () => ({ blockNumber: "124", data: "0x" }), "1", [{ to: owner, signature: "function symbol() view returns (string)" }], "123")).rejects.toThrow("inconsistent block");
  const failed: Reader = async () => ({ blockNumber: "123", data: encodeFunctionResult({ abi: parseAbi([MULTICALL_READ]), functionName: "aggregate3", result: [{ success: false, returnData: "0x" }] }) });
  expect(await readBatch(failed, "1", [{ to: owner, signature: "function symbol() view returns (string)", optional: true }], "123")).toEqual([null]);
  await expect(readBatch(failed, "1", [{ to: owner, signature: "function balanceOf(address) view returns (uint256)", args: [owner] }], "123")).rejects.toThrow("balanceOf");
});
test("eMode discovery covers sparse IDs including 255 rather than stopping at a gap", async () => {
  const ids: number[] = [];
  const read: Reader = async (_chain, _to, data) => {
    const calls = (decodeFunctionData({ abi: parseAbi([MULTICALL_READ]), data }).args as unknown as readonly [readonly { callData: Hex }[]])[0];
    const result = calls.map(({ callData }) => {
      if (callData.slice(0, 10) === encode(EMODE_DATA, [1]).slice(0, 10)) {
        const id = Number(BigInt(`0x${callData.slice(10)}`)); ids.push(id);
        return { success: true, returnData: encodeFunctionResult({ abi: parseAbi([EMODE_DATA]), functionName: "getEModeCategoryData", result: { ltv: id === 255 ? 9000 : 0, liquidationThreshold: id === 255 ? 9500 : 0, liquidationBonus: 10100, priceSource: "0x0000000000000000000000000000000000000000", label: id === 255 ? "Sparse mode" : "" } }) };
      }
      const isBool = callData.slice(0, 10) === encode("function getIsEModeCategoryIsolated(uint8) view returns (bool)", [255]).slice(0, 10);
      return { success: true, returnData: encodeFunctionResult({ abi: parseAbi([`function config() view returns (${isBool ? "bool" : "uint128"})`]), functionName: "config", result: isBool ? false : 8n }) };
    });
    return { blockNumber: "123", data: encodeFunctionResult({ abi: parseAbi([MULTICALL_READ]), functionName: "aggregate3", result }) };
  };
  expect((await readEModes(read, "1", "123")).map(mode => mode.id)).toEqual([255]); expect(ids).toHaveLength(255);
});
