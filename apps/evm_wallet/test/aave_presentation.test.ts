import { expect, test } from "bun:test";
import { encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import { mergeEvmAssets } from "neutron-tools/src/evm_assets.js";
import { presentAave } from "../src/decoders/adapters/aave_presentation.ts";
import { presentOperation } from "../src/presentation.ts";
import { agentProviderReview } from "../src/provider.ts";
import type { Operation } from "../src/data.ts";

const pool = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2";
const arbPool = "0x794a61358d6845594f94dc1db02a252b5b4814ad";
const rewards = "0x8164cc65827dcfe994ab23944cbc90e0aa80bfcb";
const arbRewards = "0x929ec64c34a17401f460460d4b9390518e5b473e";
const gateway = "0xd01607c3c5ecaba394d8be377a08590149325722";
const arbGateway = "0x5283beced7adf6d003225c13896e536f2d4264ff";
const wethDebt = "0xea51d7853eefb32b6ee06b1c12e6dcca88be0ffe";
const arbWethDebt = "0x0c84331e39d6658cd6e6b9ba04736cc4c4734351";
const aWeth = "0x4d5f47fa6a74757f35c14fd3a6ef8e3c9bc514e8";
const arbAWeth = "0xe50fa9b3c56ffb159cb0fca61f5c9d750e8128c8";
const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const arbUsdc = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const aUsdc = "0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c";
const vUsdc = "0x72e95b8931767c79ba4eee721354d6e99a61d004";
const owner = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
const max = 2n ** 256n - 1n;
const assets = mergeEvmAssets([]);
const abi = parseAbi([
  "function supply(address,uint256,address,uint16)",
  "function withdraw(address,uint256,address)",
  "function borrow(address,uint256,uint256,uint16,address)",
  "function repay(address,uint256,uint256,address)",
  "function repayWithATokens(address,uint256,uint256)",
  "function setUserUseReserveAsCollateral(address,bool)",
  "function setUserEMode(uint8)",
  "function claimRewards(address[],uint256,address,address)",
  "function claimRewardsToSelf(address[],uint256,address)",
  "function claimAllRewards(address[],address)",
  "function claimAllRewardsToSelf(address[])",
  "function depositETH(address,address,uint16) payable",
  "function withdrawETH(address,uint256,address)",
  "function borrowETH(address,uint256,uint16)",
  "function repayETH(address,uint256,address) payable",
  "function approveDelegation(address,uint256)",
  "function approve(address,uint256)",
]);
function operation(data: Hex, to: Address = pool, chainId = "1"): Operation {
  return { kind: "transaction", chainId, address: owner, caller: { appId: "unrelated", installationUid: "requester", endpoint: "background" }, intent: {},
    preparedTransaction: { to, value: "0", data, chainId, nonce: "5" } } as Operation;
}
const value = (shown: ReturnType<typeof presentOperation>, label: string) => [...shown.parties, ...(shown.advancedDetails ?? [])].find((entry) => entry.label === label)?.value;

test("Aave supply review uses exact underlying units and aToken beneficiary, independently of caller app", () => {
  const op = operation(encodeFunctionData({ abi, functionName: "supply", args: [usdc, 1234567n, other, 73] }));
  const shown = presentOperation(op, assets);
  expect(shown.title).toBe("Supply to Aave");
  expect(shown.amount).toBe("1.234567 USDC");
  expect(shown.amountAtoms).toBe("1234567");
  expect(shown.amountDecimals).toBe(6);
  expect(value(shown, "Asset")).toBe(getAddress(usdc));
  expect(value(shown, "Position beneficiary")).toBe(other);
  expect(value(shown, "Paid by")).toBe(owner);
  expect(value(shown, "Amount (atomic units)")).toBe("1234567");
  expect(value(shown, "Referral code")).toBe("73");
  expect(shown.contract).toBe(pool);
  expect(shown.description).toContain("controls the supplied position");
  expect(value(shown, "Onchain expiry")).toBe("None");
});

test("Aave borrow review separates recipient from the debt owner and identifies variable rate", () => {
  const shown = presentOperation(operation(encodeFunctionData({ abi, functionName: "borrow", args: [usdc, 250000001n, 2n, 5, other] })), assets);
  expect(shown.title).toBe("Borrow from Aave");
  expect(shown.amount).toBe("250.000001 USDC");
  expect(value(shown, "Recipient")).toBe(owner);
  expect(value(shown, "Debt owner")).toBe(other);
  expect(value(shown, "Interest rate mode")).toBe("Variable (2)");
  expect(shown.description).toContain("liquidated");
});

test("withdraw all means the entire supplied balance at execution and retains its exact sentinel", () => {
  const shown = presentOperation(operation(encodeFunctionData({ abi, functionName: "withdraw", args: [usdc, max, other] })), assets);
  expect(shown.amount).toBe("Entire supplied USDC balance");
  expect(value(shown, "Recipient")).toBe(other);
  expect(value(shown, "Position owner")).toBe(owner);
  expect(value(shown, "Amount (atomic units)")).toBe(max.toString());
  expect(value(shown, "Amount semantics")).toBe("Entire aToken balance at execution");
  expect(shown.description).toContain("sufficient pool liquidity");
  const partial = presentOperation(operation(encodeFunctionData({ abi, functionName: "withdraw", args: [usdc, 1000001n, other] })), assets);
  expect(partial.amount).toBe("1.000001 USDC");
});

test("repayment identifies payer, borrower and maximum spend including full-debt semantics", () => {
  const partial = presentOperation(operation(encodeFunctionData({ abi, functionName: "repay", args: [usdc, 3000000n, 2n, other] })), assets);
  expect(partial.amountLabel).toBe("Repayment limit");
  expect(partial.amount).toBe("3 USDC");
  expect(value(partial, "Paid by")).toBe(owner);
  expect(value(partial, "Debt owner")).toBe(other);
  const full = presentOperation(operation(encodeFunctionData({ abi, functionName: "repay", args: [usdc, max, 2n, owner] })), assets);
  expect(full.amount).toBe("Entire outstanding USDC debt");
  expect(full.description).toContain("including accrued interest");
  expect(value(full, "Amount (atomic units)")).toBe(max.toString());
  expect(full.unlimitedApproval).toBe(false);
});

test("repay with aTokens spends supplied balance and does not promise to repay all debt", () => {
  const full = presentOperation(operation(encodeFunctionData({ abi, functionName: "repayWithATokens", args: [usdc, max, 2n] })), assets);
  expect(full.title).toBe("Repay using Aave supply");
  expect(full.amount).toBe("Available supplied USDC balance, up to debt");
  expect(value(full, "Payment source")).toBe("Supplied aToken balance");
  expect(value(full, "Amount semantics")).toContain("capped by outstanding debt");
  expect(full.description).toContain("any debt beyond the repayment remains");
  const partial = presentOperation(operation(encodeFunctionData({ abi, functionName: "repayWithATokens", args: [usdc, 4500000n, 2n] })), assets);
  expect(partial.amount).toBe("4.5 USDC");
  expect(value(partial, "Underlying asset")).toBe(getAddress(usdc));
});

test("collateral and efficiency-mode changes preserve exact settings without inventing category parameters", () => {
  for (const enabled of [true, false]) {
    const shown = presentOperation(operation(encodeFunctionData({ abi, functionName: "setUserUseReserveAsCollateral", args: [usdc, enabled] })), assets);
    expect(shown.title).toBe(enabled ? "Enable Aave collateral" : "Disable Aave collateral");
    expect(value(shown, "Use as collateral")).toBe(enabled ? "Enabled" : "Disabled");
    expect(value(shown, "Position owner")).toBe(owner);
  }
  for (const category of [0, 1, 255]) {
    const shown = presentOperation(operation(encodeFunctionData({ abi, functionName: "setUserEMode", args: [category] })), assets);
    expect(value(shown, "Category ID")).toBe(String(category));
    expect(shown.amount).toBe(category === 0 ? "Disabled" : `Category ${category}`);
    expect(shown.description).toContain("no health-factor estimate");
  }
});

test("reward claims distinguish incentive-bearing tokens, reward currency and recipient", () => {
  const shown = presentOperation(operation(encodeFunctionData({ abi, functionName: "claimRewards", args: [[aUsdc, vUsdc], 1234567n, other, usdc] }), rewards), assets);
  expect(shown.title).toBe("Claim Aave rewards");
  expect(shown.amount).toBe("1.234567 USDC");
  expect(value(shown, "Reward token")).toBe(getAddress(usdc));
  expect(value(shown, "Recipient")).toBe(other);
  expect(value(shown, "Incentivized token 1")).toBe(getAddress(aUsdc));
  expect(value(shown, "Incentivized token 2")).toBe(getAddress(vUsdc));
  const self = presentOperation(operation(encodeFunctionData({ abi, functionName: "claimRewardsToSelf", args: [[aUsdc], max, usdc] }), rewards), assets);
  expect(self.amount).toBe("All accrued USDC rewards");
  expect(value(self, "Recipient")).toBe(owner);
});

test("claim-all review never substitutes a requested or observed reward quote for execution amounts", () => {
  const shown = presentOperation(operation(encodeFunctionData({ abi, functionName: "claimAllRewards", args: [[aUsdc, vUsdc], other] }), rewards), assets);
  expect(shown.title).toBe("Claim all Aave rewards");
  expect(shown.amount).toBe("All accrued rewards for selected positions");
  expect(shown.tokenAddress).toBeUndefined();
  expect(value(shown, "Recipient")).toBe(other);
  const self = presentOperation(operation(encodeFunctionData({ abi, functionName: "claimAllRewardsToSelf", args: [[vUsdc]] }), rewards), assets);
  expect(value(self, "Recipient")).toBe(owner);
  expect(value(self, "Incentivized token 1")).toBe(getAddress(vUsdc));
});

test("Arbitrum review matches network-specific deployments and token metadata", () => {
  const shown = presentOperation(operation(encodeFunctionData({ abi, functionName: "supply", args: [arbUsdc, 1020000n, owner, 0] }), arbPool, "42161"), assets);
  expect(shown.amount).toBe("1.02 USDC");
  expect(value(shown, "Aave V3 market")).toBe("Arbitrum");
  expect(presentOperation(operation(encodeFunctionData({ abi, functionName: "claimAllRewardsToSelf", args: [[vUsdc]] }), arbRewards, "42161"), assets).title).toBe("Claim all Aave rewards");
});

test("unrecognized reserve metadata retains atomic units and exact address without guessed symbols", () => {
  const shown = presentOperation(operation(encodeFunctionData({ abi, functionName: "supply", args: [other, 12345n, owner, 0] })), [{ chainId: "42161", address: other, symbol: "FAKE", decimals: 6 }]);
  expect(shown.amount).toBe("12345 atomic units");
  expect(value(shown, "Asset")).toBe(other);
  expect(shown.tokenSymbol).toBeNull();
});

test("wrong chain, destination, value, selector or trailing bytes never acquire an Aave review", () => {
  const data = encodeFunctionData({ abi, functionName: "supply", args: [usdc, 1000000n, owner, 0] });
  const mutations = [
    (op: Operation) => { op.chainId = "42161"; },
    (op: Operation) => { op.chainId = "8453"; },
    (op: Operation) => { op.preparedTransaction!.to = other; },
    (op: Operation) => { op.preparedTransaction!.to = rewards; },
    (op: Operation) => { op.preparedTransaction!.value = "1"; },
    (op: Operation) => { op.preparedTransaction!.data += "00"; },
    (op: Operation) => { op.preparedTransaction!.data = "0xffffffff" + data.slice(10); },
    (op: Operation) => { op.preparedTransaction!.data = data.slice(0, -2); },
  ];
  for (const mutate of mutations) {
    const op = operation(data); mutate(op);
    expect(presentAave(op, assets)).toBeNull();
    expect(presentOperation(op, assets).title).toBe("Contract interaction");
  }
});

test("unsupported interest modes and noncanonical encoded values retain generic review", () => {
  for (const mode of [0n, 1n, 3n, max]) {
    for (const data of [
      encodeFunctionData({ abi, functionName: "borrow", args: [usdc, 100n, mode, 0, owner] }),
      encodeFunctionData({ abi, functionName: "repay", args: [usdc, 100n, mode, owner] }),
      encodeFunctionData({ abi, functionName: "repayWithATokens", args: [usdc, 100n, mode] }),
    ]) expect(presentAave(operation(data), assets)).toBeNull();
  }
  const data = encodeFunctionData({ abi, functionName: "setUserUseReserveAsCollateral", args: [usdc, true] });
  expect(presentAave(operation((data.slice(0, -1) + "2") as Hex), assets)).toBeNull();
});

test("prepared bytes take precedence over intent and recognized reviews survive speed-ups", () => {
  const data = encodeFunctionData({ abi, functionName: "borrow", args: [usdc, 1000000n, 2n, 0, other] });
  const op = operation(data);
  op.intent.transaction = { ...op.preparedTransaction!, data: encodeFunctionData({ abi, functionName: "supply", args: [usdc, 1n, owner, 0] }) };
  expect(presentOperation(op, assets).title).toBe("Borrow from Aave");
  op.intent.replacement = { operationId: "original", cancel: false, maxFeePerGas: "2", maxPriorityFeePerGas: "1" };
  const shown = presentOperation(op, assets);
  expect(shown.title).toBe("Speed up transaction");
  expect(shown.amount).toBe("1 USDC");
  expect(value(shown, "Debt owner")).toBe(other);
});

test("native supply derives payment from msg.value and distinguishes immutable pool from unused argument", () => {
  const op = operation(encodeFunctionData({ abi, functionName: "depositETH", args: [other, other, 19] }), gateway);
  op.preparedTransaction!.value = "1000000000000001";
  const shown = presentOperation(op, assets);
  expect(shown.title).toBe("Supply ETH to Aave");
  expect(shown.amount).toBe("0.001000000000000001 ETH");
  expect(shown.amountAtoms).toBe("1000000000000001");
  expect(shown.amountDecimals).toBe(18);
  expect(value(shown, "Position beneficiary")).toBe(other);
  expect(value(shown, "Immutable Aave Pool")).toBe(getAddress(pool));
  expect(value(shown, "Legacy pool argument (unused)")).toBe(other);
  expect(value(shown, "Native payment (wei)")).toBe(op.preparedTransaction!.value);
  expect(value(shown, "Referral code")).toBe("19");
  expect(shown.nativeValue).toBeNull();
});

test("native borrow and withdrawal identify debt owner, output recipient and whole-position amount", () => {
  const borrow = presentOperation(operation(encodeFunctionData({ abi, functionName: "borrowETH", args: [pool, 1234567000000000000n, 7] }), gateway), assets);
  expect(borrow.title).toBe("Borrow ETH from Aave");
  expect(borrow.amount).toBe("1.234567 ETH");
  expect(borrow.amountAtoms).toBe("1234567000000000000");
  expect(borrow.amountDecimals).toBe(18);
  expect(value(borrow, "Recipient")).toBe(owner);
  expect(value(borrow, "Debt owner")).toBe(owner);
  expect(value(borrow, "Interest rate mode")).toBe("Variable (2)");
  const withdraw = presentOperation(operation(encodeFunctionData({ abi, functionName: "withdrawETH", args: [pool, max, other] }), gateway), assets);
  expect(withdraw.title).toBe("Withdraw ETH from Aave");
  expect(withdraw.amount).toBe("Entire supplied WETH balance as ETH");
  expect(withdraw.amountAtoms).toBeUndefined();
  expect(value(withdraw, "Recipient")).toBe(other);
  expect(value(withdraw, "Amount (wei)")).toBe(max.toString());
  expect(withdraw.description).toContain("aWETH allowance at execution");
  const partial = presentOperation(operation(encodeFunctionData({ abi, functionName: "withdrawETH", args: [pool, 1234567890123456789n, other] }), gateway), assets);
  expect(partial.amountAtoms).toBe("1234567890123456789");
  expect(partial.amountDecimals).toBe(18);
});

test("full native repayment separates exact ETH budget from outstanding debt and its refund", () => {
  const op = operation(encodeFunctionData({ abi, functionName: "repayETH", args: [pool, max, other] }), gateway);
  op.preparedTransaction!.value = "1010000000000000000";
  const shown = presentOperation(op, assets);
  expect(shown.title).toBe("Repay Aave debt with ETH");
  expect(shown.amountLabel).toBe("ETH sent (maximum)");
  expect(shown.amount).toBe("1.01 ETH");
  expect(shown.amountAtoms).toBe("1010000000000000000");
  expect(value(shown, "Repayment target")).toBe("Entire outstanding WETH debt");
  expect(value(shown, "Debt owner")).toBe(other);
  expect(value(shown, "Refund recipient")).toBe(owner);
  expect(value(shown, "Native payment budget (wei)")).toBe("1010000000000000000");
  expect(value(shown, "Repayment amount (wei)")).toBe(max.toString());
  expect(shown.description).toContain("Unused ETH is refunded");
  expect(shown.nativeValue).toBeNull();
  const partial = operation(encodeFunctionData({ abi, functionName: "repayETH", args: [pool, 1000000000000000000n, owner] }), gateway);
  partial.preparedTransaction!.value = "1010000000000000000";
  expect(value(presentOperation(partial, assets), "Repayment target")).toBe("Up to 1 WETH debt");
});

test("Aave quantities keep exact USD inputs separate from execution-time limits and nonmonetary settings", () => {
  const repay = presentOperation(operation(encodeFunctionData({ abi, functionName: "repay", args: [usdc, 1234567n, 2n, owner] })), assets);
  expect(repay.amountAtoms).toBe("1234567");
  expect(repay.amountDecimals).toBe(6);
  const fullRepay = presentOperation(operation(encodeFunctionData({ abi, functionName: "repay", args: [usdc, max, 2n, owner] })), assets);
  expect(fullRepay.amountAtoms).toBeUndefined();
  const fullSupplyRepay = presentOperation(operation(encodeFunctionData({ abi, functionName: "repayWithATokens", args: [usdc, max, 2n] })), assets);
  expect(fullSupplyRepay.amountAtoms).toBeUndefined();
  const category = presentOperation(operation(encodeFunctionData({ abi, functionName: "setUserEMode", args: [2] })), assets);
  expect(category.amountAtoms).toBeUndefined();
  expect(category.tokenAddress).toBeUndefined();
  const unknownToken = presentOperation(operation(encodeFunctionData({ abi, functionName: "supply", args: [other, 1234567n, owner, 0] })), assets);
  expect(unknownToken.amountAtoms).toBe("1234567");
  expect(unknownToken.amountDecimals).toBeUndefined();
});

test("credit delegation explains debt responsibility and exact limited, unlimited and revoked authorization", () => {
  for (const [atomic, expected, unlimited] of [[1000000000000001n, "0.001000000000000001 WETH credit", false], [max, "Unlimited WETH credit", true], [0n, "0 WETH credit", false]] as const) {
    const shown = presentOperation(operation(encodeFunctionData({ abi, functionName: "approveDelegation", args: [other, atomic] }), wethDebt), assets);
    expect(shown.title).toBe(atomic === 0n ? "Revoke Aave credit delegation" : "Approve Aave credit delegation");
    expect(shown.amountLabel).toBe("Borrowing limit");
    expect(shown.amount).toBe(expected);
    expect(value(shown, "Delegatee")).toBe(other);
    expect(value(shown, "Debt owner")).toBe(owner);
    expect(value(shown, "Allowance (atomic units)")).toBe(atomic.toString());
    expect(value(shown, "Variable debt token")).toBe(getAddress(wethDebt));
    expect(shown.unlimitedApproval).toBe(unlimited);
    expect(shown.description).toContain(atomic === 0n ? "Existing debt remains" : "responsible for the debt and interest");
  }
});

test("native withdrawal aWETH approval shows an exact supplied-token limit for both networks", () => {
  for (const [chainId, token, spender] of [["1", aWeth, gateway], ["42161", arbAWeth, arbGateway]] as const) {
    const limited = presentOperation(operation(encodeFunctionData({ abi, functionName: "approve", args: [spender, 1000000000000001n] }), token, chainId), assets);
    expect(limited.title).toBe("Approve aWETH");
    expect(limited.amount).toBe("0.001000000000000001 aWETH");
    expect(value(limited, "Spender")).toBe(getAddress(spender));
    expect(value(limited, "Supplied token")).toBe(getAddress(token));
    expect(limited.description).toContain("does not itself withdraw funds");
    const unlimited = presentOperation(operation(encodeFunctionData({ abi, functionName: "approve", args: [spender, max] }), token, chainId), assets);
    expect(unlimited.amount).toBe("Unlimited aWETH");
    expect(unlimited.unlimitedApproval).toBe(true);
    const revoked = presentOperation(operation(encodeFunctionData({ abi, functionName: "approve", args: [spender, 0n] }), token, chainId), assets);
    expect(revoked.title).toBe("Revoke aWETH allowance");
    const wrongChain = operation(encodeFunctionData({ abi, functionName: "approve", args: [spender, 1n] }), token, chainId === "1" ? "42161" : "1");
    expect(presentAave(wrongChain, assets)).toBeNull();
  }
});

test("Arbitrum native gateway and credit delegation match only their correct chain and destination", () => {
  const calls = [
    operation(encodeFunctionData({ abi, functionName: "borrowETH", args: [arbPool, 1000n, 0] }), arbGateway, "42161"),
    operation(encodeFunctionData({ abi, functionName: "approveDelegation", args: [arbGateway, 1000n] }), arbWethDebt, "42161"),
  ];
  for (const op of calls) {
    expect(value(presentOperation(op, assets), "Aave V3 market")).toBe("Arbitrum");
    op.chainId = "1";
    expect(presentAave(op, assets)).toBeNull();
    op.chainId = "42161";
    op.preparedTransaction!.to = other;
    expect(presentAave(op, assets)).toBeNull();
  }
});

test("obsolete gateway signatures, unexpected payments and altered calldata retain generic review", () => {
  const legacy = parseAbi(["function borrowETH(address,uint256,uint256,uint16)", "function repayETH(address,uint256,uint256,address) payable"]);
  for (const data of [
    encodeFunctionData({ abi: legacy, functionName: "borrowETH", args: [pool, 1n, 2n, 0] }),
    encodeFunctionData({ abi: legacy, functionName: "repayETH", args: [pool, max, 2n, owner] }),
  ]) expect(presentAave(operation(data, gateway), assets)).toBeNull();
  for (const op of [
    operation(encodeFunctionData({ abi, functionName: "borrowETH", args: [pool, 1n, 0] }), gateway),
    operation(encodeFunctionData({ abi, functionName: "withdrawETH", args: [pool, 1n, owner] }), gateway),
    operation(encodeFunctionData({ abi, functionName: "approveDelegation", args: [gateway, 1n] }), wethDebt),
  ]) {
    op.preparedTransaction!.value = "1";
    expect(presentAave(op, assets)).toBeNull();
  }
  for (const op of [
    operation(encodeFunctionData({ abi, functionName: "repayETH", args: [pool, max, owner] }), gateway),
    operation(encodeFunctionData({ abi, functionName: "approveDelegation", args: [gateway, max] }), wethDebt),
    operation(encodeFunctionData({ abi, functionName: "claimAllRewards", args: [[aUsdc], other] }), rewards),
  ]) {
    op.preparedTransaction!.data += "00";
    expect(presentAave(op, assets)).toBeNull();
  }
});

test("Agent review receives the same Aave ownership, payment semantics and complete candidate bytes as owner review", () => {
  const cases = [
    operation(encodeFunctionData({ abi, functionName: "borrow", args: [usdc, 1234567n, 2n, 0, other] })),
    operation(encodeFunctionData({ abi, functionName: "repayETH", args: [pool, max, owner] }), gateway),
    operation(encodeFunctionData({ abi, functionName: "approveDelegation", args: [gateway, 1234567n] }), wethDebt),
  ];
  cases[1]!.preparedTransaction!.value = "1010000000000000000";
  for (const op of cases) {
    const candidate = op.preparedTransaction!;
    Object.assign(candidate, { accessList: [], transactionType: "eip1559", gasLimit: "200000", maxFeePerGas: "2", maxPriorityFeePerGas: "1", gasPrice: null });
    Object.assign(op, {
      requestId: "ab".repeat(16), accountId: "main", operationId: "aave-review", status: "prepared", reviewRevision: "1", tokenEvidence: null, message: null,
      review: { nonce: candidate.nonce, gasLimit: candidate.gasLimit, maxFeePerGas: candidate.maxFeePerGas, maxPriorityFeePerGas: candidate.maxPriorityFeePerGas, gasPrice: null, balance: "2000000000000000000", simulation: "0x", observedAtNs: "1000000" },
    });
    op.intent.transaction = { to: candidate.to, value: candidate.value, data: candidate.data, accessList: [], transactionType: null, gasLimit: null, maxFeePerGas: null, maxPriorityFeePerGas: null, gasPrice: null };
    const review = agentProviderReview({
      kind: "transaction", operation: op,
      request: { requestId: op.requestId, accountId: "main", chainId: op.chainId, to: candidate.to, valueWei: candidate.value, data: candidate.data },
      identity: { caller: { app_id: op.caller.appId, installation_uid: op.caller.installationUid, endpoint: op.caller.endpoint } },
    });
    const human = presentOperation(op, assets);
    expect(review.summary).toMatchObject({ title: human.title, amount: human.amount, amountLabel: human.amountLabel, description: human.description, parties: human.parties, advancedDetails: human.advancedDetails });
    expect(review.transaction).toMatchObject({ to: candidate.to, valueWei: candidate.value, data: candidate.data });
    expect(review.signingAddress).toBe(owner);
  }
});
