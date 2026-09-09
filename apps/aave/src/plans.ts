import { formatUnits, getAddress, type Address } from "viem";
import type { EvmAccount, EvmEstimateTransactionResult, EvmWalletClient } from "neutron-tools/evm_wallet";
import { call, chain, CHAINS, EFFECTS, encode, MAX_UINT256, TOKEN_ALLOWANCE, TOKEN_APPROVE, uint, WAD, walletReader, ZERO, type AccountPosition, type ChainId, type EMode, type Market, type Reader, type Reserve, type Token, type Transaction } from "./contracts.ts";
import { errorMessage, readBatch, readMarket } from "./markets.ts";

export type Kind = "supply" | "withdraw" | "borrow" | "repay" | "repay_atokens" | "collateral" | "emode" | "rewards";
export type Input = { kind: Kind; chainId: ChainId; asset: Address | null; amount: string; all: boolean; useNative: boolean; maxPaymentAmount: string | null; collateralEnabled: boolean; eModeId: number; quoteValiditySeconds: string };
export type Step = { label: string; kind: "approval" | "transaction"; transaction: Transaction };
export type Preview = { reserve: Reserve | null; amount: string; maximumPayment: string | null; before: AccountPosition; after: AccountPosition; warnings: string[]; blockNumber: string; inputs: { token: Token; amount: string }[]; outputs: { token: Token; amount: string }[] };
export type Plan = { summary: string; chainId: ChainId; accountAddress: Address; validUntil: string; steps: Step[]; preview: Preview };
export type Fee = { label: string; estimate: EvmEstimateTransactionResult | null; error: string | null };
export const KINDS: Kind[] = ["supply", "withdraw", "borrow", "repay", "repay_atokens", "collateral", "emode", "rewards"];

export function parseInput(raw: Record<string, unknown>): Input {
  if (!KINDS.includes(raw.kind as Kind)) throw new Error("Choose an Aave action.");
  const kind = raw.kind as Kind, chainId = chain(raw.chainId), asset = raw.asset == null ? null : getAddress(String(raw.asset));
  if (asset === ZERO) throw new Error("Choose a listed Aave reserve.");
  const amount = raw.amount ?? "0"; uint(amount, "Amount");
  const maxPaymentAmount = raw.maxPaymentAmount ?? null;
  if (maxPaymentAmount !== null && uint(maxPaymentAmount, "Maximum payment", true) === MAX_UINT256) throw new Error("Enter a finite payment budget instead of an unlimited approval.");
  for (const key of ["all", "useNative", "collateralEnabled"]) if (raw[key] !== undefined && typeof raw[key] !== "boolean") throw new Error(`Invalid ${key} selection.`);
  const all = raw.all === true, useNative = raw.useNative === true;
  if (all && !["withdraw", "repay", "repay_atokens"].includes(kind)) throw new Error("Use an exact amount for supply and borrowing.");
  if (useNative && !["supply", "withdraw", "borrow", "repay"].includes(kind)) throw new Error("This action uses the reserve token directly.");
  if (!["emode", "rewards"].includes(kind) && asset === null) throw new Error("Choose a listed Aave reserve.");
  if (useNative && asset !== CHAINS[chainId].weth) throw new Error("Native ETH is available for the WETH reserve.");
  if (["supply", "withdraw", "borrow", "repay", "repay_atokens"].includes(kind) && !all) uint(amount, "Amount", true);
  if (["supply", "borrow"].includes(kind) && BigInt(String(amount)) === MAX_UINT256) throw new Error("Enter the exact amount instead of the protocol's all-balance sentinel.");
  const eModeId = raw.eModeId ?? 0;
  if (typeof eModeId !== "number" || !Number.isInteger(eModeId) || eModeId < 0 || eModeId > 255) throw new Error("Choose a valid efficiency-mode category.");
  const quoteValiditySeconds = raw.quoteValiditySeconds ?? "1200"; uint(quoteValiditySeconds, "Review validity", true);
  return { kind, chainId, asset, amount: String(amount), all, useNative, maxPaymentAmount: maxPaymentAmount === null ? null : String(maxPaymentAmount), collateralEnabled: raw.collateralEnabled !== false, eModeId, quoteValiditySeconds: String(quoteValiditySeconds) };
}

export function inBitmap(bitmap: string, reserveId: number): boolean { return (BigInt(bitmap) & (1n << BigInt(reserveId))) !== 0n; }
export function collateralParameters(reserve: Reserve, mode: EMode | undefined) {
  const enhanced = mode && inBitmap(mode.collateralBitmap, reserve.id);
  const zeroLtv = mode && (inBitmap(mode.ltvzeroBitmap, reserve.id) || (mode.isolated && !enhanced));
  return { ltvBps: zeroLtv ? 0 : enhanced ? mode.ltvBps : reserve.ltvBps, liquidationThresholdBps: enhanced ? mode.liquidationThresholdBps : reserve.liquidationThresholdBps };
}
export function calculatePosition(reserves: readonly Reserve[], modes: readonly EMode[], eModeId: number): AccountPosition {
  const mode = modes.find(m => m.id === eModeId); let collateral = 0n, debt = 0n, ltvWeighted = 0n, thresholdWeighted = 0n;
  for (const reserve of reserves) {
    const unit = 10n ** BigInt(reserve.decimals), price = BigInt(reserve.priceBase);
    debt += (BigInt(reserve.variableDebt) * price + unit - 1n) / unit;
    const parameters = collateralParameters(reserve, mode);
    if (reserve.collateralEnabled) {
      const value = BigInt(reserve.supplied) * price / unit; collateral += value;
      ltvWeighted += value * BigInt(parameters.ltvBps); thresholdWeighted += value * BigInt(parameters.liquidationThresholdBps);
    }
  }
  const averageLtv = collateral ? ltvWeighted / collateral : 0n;
  const capacity = collateral * averageLtv / 10000n;
  return { totalCollateralBase: collateral.toString(), totalDebtBase: debt.toString(), availableBorrowsBase: (capacity > debt ? capacity - debt : 0n).toString(),
    liquidationThresholdBps: collateral ? Number(thresholdWeighted / collateral) : 0, ltvBps: Number(averageLtv),
    healthFactor: debt === 0n ? null : (((thresholdWeighted * WAD + debt / 2n) / debt) / 10000n).toString(), eModeId };
}
function min(a: bigint, b: bigint) { return a < b ? a : b; }
function requiredBudget(input: Input, current: bigint): bigint {
  if (input.maxPaymentAmount === null) throw new Error("Review a maximum payment budget that covers the current balance and interest until execution.");
  const budget = uint(input.maxPaymentAmount, "Maximum payment", true);
  if (budget < current) throw new Error("The maximum payment budget is below the current accrued balance. Refresh and review it again.");
  return budget;
}
export async function approvalSteps(read: Reader, chainId: ChainId, owner: Address, token: Pick<Token, "address" | "symbol">, spender: Address, amount: bigint, block: string, delegation = false, exactBudget = false): Promise<Step[]> {
  const signature = delegation ? "function borrowAllowance(address fromUser,address toUser) view returns (uint256)" : TOKEN_ALLOWANCE;
  const allowance = BigInt(String((await call(read, chainId, token.address, signature, [owner, spender], block)).value));
  if (exactBudget ? allowance === amount : allowance >= amount) return [];
  const make = (value: bigint, label: string): Step => ({ kind: "approval", label, transaction: { chainId, accountId: "main", to: token.address, valueWei: "0", data: encode(delegation ? EFFECTS.delegation : TOKEN_APPROVE, [spender, value]) } });
  const reset = !delegation && chainId === "1" && token.address.toLowerCase() === "0xdac17f958d2ee523a2206206994597c13d831ec7" && allowance > 0n;
  return [...(reset ? [make(0n, `Reset ${token.symbol} approval`)] : []), make(amount, delegation ? "Approve this ETH borrowing amount" : `Approve ${token.symbol} spending`)];
}

export async function quotePlan(read: Reader, account: EvmAccount, raw: Input, options: { market?: Market; now?: number; signal?: AbortSignal; onProgress?: (message: string) => void } = {}): Promise<Plan> {
  const input = parseInput(raw), owner = getAddress(account.address), network = CHAINS[input.chainId];
  const market = options.market ?? await readMarket(read, input.chainId, owner, options);
  if (market.chainId !== input.chainId || market.accountAddress !== owner || market.pool !== network.pool) throw new Error("The market snapshot belongs to another wallet or network.");
  const block = market.blockNumber, mode = market.eModes.find(m => m.id === market.account.eModeId);
  const reserve = market.reserves.find(r => r.address === input.asset) ?? null;
  if (input.asset !== null && !reserve) throw new Error("This contract is not a registered reserve in the selected Aave market.");
  options.signal?.throwIfAborted(); options.onProgress?.("Checking your Aave position and permissions…");
  const warnings = ["Health factor and rates are estimates at this block. Prices, interest and market parameters can change before confirmation."];
  const nextReserves = market.reserves.map(r => ({ ...r }));
  const next = reserve ? nextReserves.find(r => r.address === reserve.address)! : null;
  let amount = BigInt(input.amount), maximumPayment: bigint | null = null, eModeId = market.account.eModeId;
  let steps: Step[] = [], signature: string = "", args: readonly unknown[] = [], valueWei = "0", to: Address = network.pool, summary = "";
  const inputs: Preview["inputs"] = [], outputs: Preview["outputs"] = [];
  if (input.useNative) {
    const gateway = await readBatch(read, input.chainId, [{ to: network.gateway, signature: "function POOL() view returns (address)" }, { to: network.gateway, signature: "function WETH() view returns (address)" }], block);
    if (getAddress(String(gateway[0])) !== network.pool || getAddress(String(gateway[1])) !== network.weth) throw new Error("The native ETH gateway does not match this Aave market.");
    to = network.gateway;
  }
  const token = reserve && (input.useNative ? { ...reserve, symbol: "ETH", name: "Ether" } : reserve);
  if (reserve && !["emode", "rewards"].includes(input.kind)) {
    if (!reserve.active) throw new Error(`${reserve.symbol} is inactive in Aave.`);
    if (reserve.paused) throw new Error(`${reserve.symbol} is paused by the Aave protocol.`);
    if (reserve.priceBase === "0" && ["borrow", "withdraw", "collateral"].includes(input.kind)) throw new Error("Aave has no current oracle price for this reserve.");
  }
  if (input.kind === "supply" && reserve && next && token) {
    if (reserve.frozen) throw new Error("This Aave reserve is frozen for new supplies.");
    if (!input.useNative && amount > BigInt(reserve.walletBalance)) throw new Error(`Insufficient ${reserve.symbol} in your wallet.`);
    if (BigInt(reserve.supplyCap) && BigInt(reserve.totalSupplied) + BigInt(reserve.accruedToTreasury) + amount > BigInt(reserve.supplyCap) * 10n ** BigInt(reserve.decimals)) throw new Error("This amount exceeds Aave's current supply cap.");
    next.supplied = (BigInt(next.supplied) + amount).toString();
    const otherCollateral = market.reserves.filter(r => r.address !== reserve.address && r.collateralEnabled && BigInt(r.supplied) > 0n);
    if (BigInt(reserve.supplied) === 0n && collateralParameters(reserve, mode).ltvBps > 0 && !otherCollateral.some(r => BigInt(r.debtCeiling) > 0n) && !(BigInt(reserve.debtCeiling) > 0n && otherCollateral.length > 0)) next.collateralEnabled = true;
    if (!next.collateralEnabled && reserve.liquidationThresholdBps > 0) warnings.push("This supply is not automatically enabled as collateral. You can manage collateral after it confirms.");
    if (input.useNative) { signature = EFFECTS.supply_native; args = [network.pool, owner, 0]; valueWei = amount.toString(); }
    else { steps = await approvalSteps(read, input.chainId, owner, reserve, network.pool, amount, block); signature = EFFECTS.supply; args = [reserve.address, amount, owner, 0]; }
    summary = `Supply ${token.symbol}`; inputs.push({ token, amount: amount.toString() });
  } else if (input.kind === "withdraw" && reserve && next && token) {
    amount = input.all ? BigInt(reserve.supplied) : amount;
    if (!amount || amount > BigInt(reserve.supplied)) throw new Error(`Withdraw an amount within your supplied balance (currently ${formatUnits(BigInt(reserve.supplied), reserve.decimals)} ${reserve.symbol} at block ${block}). Use the current balance or choose a full withdrawal.`);
    if (amount > BigInt(reserve.availableLiquidity)) throw new Error("This amount exceeds the reserve's currently available liquidity.");
    next.supplied = (BigInt(next.supplied) - amount).toString(); if (next.supplied === "0") next.collateralEnabled = false;
    if (input.useNative) {
      maximumPayment = input.all ? requiredBudget(input, amount) : amount;
      steps = await approvalSteps(read, input.chainId, owner, { address: reserve.aTokenAddress, symbol: `a${reserve.symbol}` }, network.gateway, maximumPayment, block, false, input.all);
      signature = EFFECTS.withdraw_native; args = [network.pool, input.all ? MAX_UINT256 : amount, owner];
      if (input.all) warnings.push("The gateway withdraws your accrued aWETH balance. Its allowance is limited to the reviewed maximum; refresh if interest outgrows it.");
    } else { signature = EFFECTS.withdraw; args = [reserve.address, input.all ? MAX_UINT256 : amount, owner]; }
    summary = `Withdraw ${token.symbol}`; outputs.push({ token, amount: amount.toString() });
  } else if (input.kind === "borrow" && reserve && next && token) {
    if (reserve.frozen) throw new Error("This Aave reserve is frozen for new borrowing.");
    if (mode ? !inBitmap(mode.borrowableBitmap, reserve.id) : !reserve.borrowingEnabled) throw new Error("Borrowing this asset is not enabled in the selected Aave mode.");
    if (amount > BigInt(reserve.availableLiquidity)) throw new Error("This amount exceeds the reserve's currently available liquidity.");
    if (BigInt(reserve.borrowCap) && BigInt(reserve.totalDebt) + amount > BigInt(reserve.borrowCap) * 10n ** BigInt(reserve.decimals)) throw new Error("This amount exceeds Aave's current borrow cap.");
    const otherDebts = market.reserves.filter(r => r.address !== reserve.address && BigInt(r.variableDebt) > 0n);
    if ((reserve.siloedBorrowing && otherDebts.length > 0) || otherDebts.some(r => r.siloedBorrowing)) throw new Error("Aave's siloed-borrowing rules prevent combining these debts.");
    const isolated = market.reserves.find(r => r.collateralEnabled && BigInt(r.supplied) > 0n && BigInt(r.debtCeiling) > 0n);
    if (isolated) {
      if (!reserve.borrowableInIsolation) throw new Error("This asset cannot be borrowed against your isolated collateral.");
      const ceilingDebt = amount / (10n ** BigInt(Math.max(0, reserve.decimals - 2)));
      if (BigInt(isolated.isolationModeTotalDebt) + ceilingDebt > BigInt(isolated.debtCeiling)) throw new Error("This amount exceeds the isolated collateral's Aave debt ceiling.");
    }
    const cost = amount * BigInt(reserve.priceBase) / (10n ** BigInt(reserve.decimals));
    if (cost > BigInt(market.account.availableBorrowsBase)) throw new Error("This amount exceeds your available borrowing power. Supply more collateral or borrow less.");
    next.variableDebt = (BigInt(next.variableDebt) + amount).toString();
    if (input.useNative) { steps = await approvalSteps(read, input.chainId, owner, { address: reserve.variableDebtTokenAddress, symbol: reserve.symbol }, network.gateway, amount, block, true); signature = EFFECTS.borrow_native; args = [network.pool, amount, 0]; }
    else { signature = EFFECTS.borrow; args = [reserve.address, amount, 2n, 0, owner]; }
    summary = `Borrow ${token.symbol}`; outputs.push({ token, amount: amount.toString() });
    warnings.push("Borrow interest is variable. A health factor below 1 makes your collateral eligible for liquidation.");
  } else if ((input.kind === "repay" || input.kind === "repay_atokens") && reserve && next && token) {
    const debt = BigInt(reserve.variableDebt); if (!debt) throw new Error(`You have no ${reserve.symbol} variable debt to repay.`);
    if (input.kind === "repay_atokens") {
      amount = input.all ? min(debt, BigInt(reserve.supplied)) : min(amount, debt);
      if (!amount || amount > BigInt(reserve.supplied)) throw new Error("Repay an amount within your supplied balance of the same asset.");
      next.supplied = (BigInt(next.supplied) - amount).toString(); if (next.supplied === "0") next.collateralEnabled = false;
      signature = EFFECTS.repay_atokens; args = [reserve.address, input.all ? MAX_UINT256 : amount, 2n]; summary = `Repay using supplied ${reserve.symbol}`;
      if (input.all && BigInt(reserve.supplied) < debt) warnings.push("This uses all supplied tokens of the same asset and leaves the remaining borrow open.");
    } else {
      amount = input.all ? debt : min(amount, debt); maximumPayment = input.all ? requiredBudget(input, debt) : amount;
      if (!input.useNative && maximumPayment > BigInt(reserve.walletBalance)) throw new Error(`The reviewed payment budget exceeds your ${reserve.symbol} wallet balance.`);
      if (input.useNative) { signature = EFFECTS.repay_native; args = [network.pool, input.all ? MAX_UINT256 : amount, owner]; valueWei = maximumPayment.toString(); }
      else { steps = await approvalSteps(read, input.chainId, owner, reserve, network.pool, maximumPayment, block, false, input.all); signature = EFFECTS.repay; args = [reserve.address, input.all ? MAX_UINT256 : amount, 2n, owner]; }
      summary = `${input.all ? "Repay all" : "Repay"} ${token.symbol}`;
      if (input.all) warnings.push(input.useNative ? "Aave repays the debt including accrued interest and refunds unused ETH. It reverts if the debt exceeds your reviewed maximum." : "Aave repays the debt including accrued interest within your bounded allowance. It reverts if interest outgrows the reviewed maximum; unused allowance may remain.");
    }
    next.variableDebt = (debt - amount).toString(); inputs.push({ token, amount: amount.toString() });
  } else if (input.kind === "collateral" && reserve && next) {
    if (!BigInt(reserve.supplied)) throw new Error("Supply this reserve before changing its collateral setting.");
    if (input.collateralEnabled === reserve.collateralEnabled) warnings.push(`${reserve.symbol} collateral is already ${input.collateralEnabled ? "enabled" : "disabled"} at block ${block}. This transaction would repeat the current setting and still incur a network fee if submitted.`);
    if (input.collateralEnabled && collateralParameters(reserve, mode).liquidationThresholdBps === 0) throw new Error("This asset is not eligible as collateral in this mode.");
    if (input.collateralEnabled && !reserve.collateralEnabled) {
      const otherCollateral = market.reserves.filter(r => r.address !== reserve.address && r.collateralEnabled && BigInt(r.supplied) > 0n);
      if (otherCollateral.some(r => BigInt(r.debtCeiling) > 0n) || (BigInt(reserve.debtCeiling) > 0n && otherCollateral.length)) throw new Error("Aave's isolation rules prevent enabling this collateral combination.");
    }
    next.collateralEnabled = input.collateralEnabled; signature = EFFECTS.collateral; args = [reserve.address, input.collateralEnabled]; summary = `${input.collateralEnabled ? "Enable" : "Disable"} ${reserve.symbol} collateral`;
  } else if (input.kind === "emode") {
    const category = market.eModes.find(m => m.id === input.eModeId);
    if (input.eModeId !== 0 && !category) throw new Error("Choose an efficiency mode configured in this Aave market.");
    if (input.eModeId === market.account.eModeId) warnings.push(`E-mode is already ${category ? `${category.label} (${category.id})` : "disabled (0)"} at block ${block}. This transaction would repeat the current setting and still incur a network fee if submitted.`);
    if (category && market.reserves.some(r => BigInt(r.variableDebt) > 0n && !inBitmap(category.borrowableBitmap, r.id))) throw new Error("Repay assets outside this efficiency mode before switching to it.");
    eModeId = input.eModeId; signature = EFFECTS.emode; args = [eModeId]; summary = category ? `Enable ${category.label} eMode` : "Disable eMode";
    warnings.push("Efficiency mode changes borrowing power for eligible assets; correlated collateral can still lose value and be liquidated.");
  } else if (input.kind === "rewards") {
    if (!market.rewards.length && market.errors.length) throw new Error(market.errors.join(" "));
    if (!market.rewards.length) throw new Error("No claimable Aave incentives were found for this wallet.");
    to = network.rewardsController; signature = EFFECTS.rewards; args = [market.reserves.flatMap(r => [r.aTokenAddress, r.variableDebtTokenAddress]), owner]; summary = "Claim Aave rewards";
    for (const reward of market.rewards) outputs.push({ token: reward, amount: reward.amount });
  } else throw new Error("Choose a registered Aave reserve for this action.");
  const after = calculatePosition(nextReserves, market.eModes, eModeId);
  // The actual Pool simulation checks current protocol rules (including new
  // eMode/LTV constraints and oracle sentinels), using the Wallet caller.
  if (["borrow", "withdraw", "collateral", "emode", "repay_atokens"].includes(input.kind)) {
    const simulation = input.useNative && reserve ? input.kind === "borrow" ? encode(EFFECTS.borrow, [reserve.address, amount, 2n, 0, owner]) : encode(EFFECTS.withdraw, [reserve.address, input.all ? MAX_UINT256 : amount, owner]) : encode(signature, args);
    let result: Awaited<ReturnType<Reader>>;
    try { result = await read(input.chainId, network.pool, simulation, block); }
    catch (error) {
      options.signal?.throwIfAborted();
      const category = input.kind === "emode" ? market.eModes.find(m => m.id === input.eModeId) : undefined;
      const enabled = market.reserves.filter(r => r.collateralEnabled && BigInt(r.supplied) > 0n);
      const modeContext = input.kind === "emode"
        ? ` Current E-mode: ${market.account.eModeId}; requested: ${input.eModeId}${category ? ` (${category.label}${category.isolated ? ", isolated" : ""})` : ""}. Enabled collateral: ${enabled.map(r => r.symbol).join(", ") || "none"}. Aave checks enabled collateral as well as debt when changing E-mode, including accounts with no debt.`
        : "";
      throw new Error(`Could not simulate ${summary} at block ${block}.${modeContext} The failed read does not establish which protocol condition failed. Wallet detail: ${errorMessage(error)}`, { cause: error });
    }
    if (BigInt(result.blockNumber) !== BigInt(block)) throw new Error("The transaction simulation used a different block. Refresh the preview.");
  }
  const transaction: Transaction = { chainId: input.chainId, accountId: "main", to, valueWei, data: encode(signature, args) };
  steps.push({ kind: "transaction", label: summary, transaction });
  const now = options.now ?? Date.now();
  return { summary, chainId: input.chainId, accountAddress: owner, validUntil: (BigInt(Math.floor(now / 1000)) + BigInt(input.quoteValiditySeconds)).toString(), steps,
    preview: { reserve, amount: amount.toString(), maximumPayment: maximumPayment?.toString() ?? null, before: market.account, after, warnings, blockNumber: block, inputs, outputs } };
}

export async function preparePlan(wallet: EvmWalletClient, account: EvmAccount, input: Input, options: { signal?: AbortSignal; now?: number; onProgress?: (message: string) => void } = {}): Promise<Plan> {
  return quotePlan(walletReader(wallet, options.signal), account, input, options);
}
export async function estimateFees(wallet: EvmWalletClient, plan: Plan, signal?: AbortSignal): Promise<Fee[]> {
  return Promise.all(plan.steps.map(async step => {
    try { return { label: step.label, estimate: await wallet.estimateTransaction(step.transaction, signal ? { signal } : undefined), error: null }; }
    catch (error) { return { label: step.label, estimate: null, error: errorMessage(error) }; }
  }));
}
