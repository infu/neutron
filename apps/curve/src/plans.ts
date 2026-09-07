import { decodeFunctionResult, getAddress, parseAbi, type Abi, type Address } from "viem";
import type { EvmAccount, EvmEstimateTransactionResult, EvmWalletClient } from "neutron-tools/evm_wallet";
import { bps, call, chain, CHAINS, encode, isLegacy, liquiditySignatures, minimum, NATIVE, poolKey, poolRef, ROUTER_EXCHANGE, ROUTER_QUOTE, TOKEN_ALLOWANCE, TOKEN_APPROVE, TOKEN_BALANCE, uint, walletReader, ZERO, type ChainId, type PoolRef, type Reader, type Token, type Transaction, type VerifiedPool } from "./contracts.ts";
import { errorMessage, fetchPools, findPool, readToken, verifyPool, type PoolCatalog } from "./pools.ts";

export type SwapInput = {
  kind: "swap"; chainId: ChainId; tokenIn: Address | null; tokenOut: Address | null;
  amountIn: string; recipient: Address | null; slippageBps: number; quoteValiditySeconds: string; pool: PoolRef | null;
};
export type LiquidityInput = {
  kind: "deposit" | "withdraw" | "withdraw_one"; chainId: ChainId; pool: PoolRef;
  amounts: string[]; lpAmount: string; coinIndex: number; useNative: boolean;
  recipient: Address | null; slippageBps: number; quoteValiditySeconds: string;
};
export type Input = SwapInput | LiquidityInput;
export type Step = { label: string; kind: "approval" | "transaction"; transaction: Transaction };
export type Plan = {
  summary: string; chainId: ChainId; accountAddress: Address; validUntil: string;
  steps: Step[]; pool: VerifiedPool | null; preview: Preview;
};
export type Preview = {
  inputs: { token: Token; amount: string }[]; outputs: { token: Token; amount: string; minimum: string }[];
  recipient: Address; blockNumber: string; route: string[]; priceImpactBps: string | null; warnings: string[];
};
export type Route = { route: Address[]; params: bigint[][]; pools: Address[] };
export type Fee = { label: string; estimate: EvmEstimateTransactionResult | null; error: string | null };

function address(value: unknown): Address | null {
  if (value === null || value === undefined) return null;
  const result = getAddress(String(value));
  if (result === ZERO || result === NATIVE) throw new Error("Use a token contract address, or select native ETH.");
  return result;
}
export function parseInput(raw: Record<string, unknown>): Input {
  const chainId = chain(raw.chainId), recipient = address(raw.recipient), slippageBps = bps(raw.slippageBps ?? 50);
  const quoteValiditySeconds = String(raw.quoteValiditySeconds ?? "1200"); uint(quoteValiditySeconds, "Quote validity", true);
  const common = { chainId, recipient, slippageBps, quoteValiditySeconds };
  if (raw.kind === "swap") {
    const tokenIn = address(raw.tokenIn), tokenOut = address(raw.tokenOut);
    if (tokenIn === tokenOut) throw new Error("Choose two different assets.");
    const amountIn = String(raw.amountIn); uint(amountIn, "Swap amount", true);
    const pool = raw.pool === undefined || raw.pool === null ? null : poolRef(raw.pool);
    if (pool && pool.chainId !== chainId) throw new Error("The selected pool belongs to another network.");
    return { ...common, kind: "swap", tokenIn, tokenOut, amountIn, pool };
  }
  if (!["deposit", "withdraw", "withdraw_one"].includes(String(raw.kind))) throw new Error("Choose a swap, deposit or withdrawal.");
  const pool = poolRef(raw.pool);
  if (pool.chainId !== chainId) throw new Error("The selected pool belongs to another network.");
  if (raw.amounts !== undefined && (!Array.isArray(raw.amounts) || raw.amounts.some((v) => typeof v !== "string"))) throw new Error("Deposit amounts must be exact atomic values.");
  const amounts = (raw.amounts ?? []) as string[]; amounts.forEach((value) => uint(value, "Deposit amount"));
  const lpAmount = String(raw.lpAmount ?? "0"); uint(lpAmount, "LP token amount", raw.kind !== "deposit");
  const coinIndex = raw.coinIndex ?? 0;
  if (typeof coinIndex !== "number" || !Number.isSafeInteger(coinIndex) || coinIndex < 0) throw new Error("Choose a withdrawal token.");
  if (raw.useNative !== undefined && typeof raw.useNative !== "boolean") throw new Error("Invalid native ETH selection.");
  return { ...common, kind: raw.kind as LiquidityInput["kind"], pool, amounts, lpAmount, coinIndex, useNative: raw.useNative === true };
}

export function swapRoute(chainId: ChainId, tokenIn: Address | null, tokenOut: Address | null, pool: Pick<VerifiedPool, "address" | "coins" | "family"> | null): Route {
  const network = CHAINS[chainId], route: Address[] = [tokenIn ?? NATIVE], params: bigint[][] = [];
  const hop = (contract: Address, to: Address, config: bigint[]) => { route.push(contract, to); params.push(config); };
  if (!pool) {
    if (!((tokenIn === null && tokenOut === network.weth) || (tokenOut === null && tokenIn === network.weth))) throw new Error("No pool was supplied for this pair.");
    hop(network.weth, tokenOut ?? NATIVE, [0n, 0n, 8n, 0n, 0n]);
  } else {
    // Prefer a pool's exact coin, then bridge ETH/WETH in either direction.
    // Legacy ETH pools need an unwrap before spending WETH, or a wrap before
    // delivering WETH; NG WETH pools need the opposite conversion for ETH.
    const mapToken = (token: Address | null) => {
      const exact = pool.coins.findIndex((coin) => coin.address === token);
      return exact >= 0 ? exact : pool.coins.findIndex((coin) =>
        (token === null && coin.address === network.weth) || (token === network.weth && coin.address === null));
    };
    const i = mapToken(tokenIn), j = mapToken(tokenOut);
    if (i < 0 || j < 0 || i === j) throw new Error("This pool does not exchange the selected assets.");
    const currencyIn = pool.coins[i]!.address, currencyOut = pool.coins[j]!.address;
    if (tokenIn === null && currencyIn === network.weth) hop(network.weth, network.weth, [0n, 0n, 8n, 0n, 0n]);
    if (tokenIn === network.weth && currencyIn === null) hop(network.weth, NATIVE, [0n, 0n, 8n, 0n, 0n]);
    const poolType = pool.family.startsWith("legacy") ? 1n : pool.family.startsWith("stable") ? 10n : pool.family === "twocrypto-ng" ? 20n : 30n;
    hop(pool.address, currencyOut ?? NATIVE, [BigInt(i), BigInt(j), 1n, poolType, BigInt(pool.coins.length)]);
    if (tokenOut === null && currencyOut === network.weth) hop(network.weth, NATIVE, [0n, 0n, 8n, 0n, 0n]);
    if (tokenOut === network.weth && currencyOut === null) hop(network.weth, network.weth, [0n, 0n, 8n, 0n, 0n]);
  }
  while (route.length < 11) route.push(ZERO);
  while (params.length < 5) params.push([0n, 0n, 0n, 0n, 0n]);
  return { route, params, pools: Array<Address>(5).fill(ZERO) };
}

/** These are transaction prerequisites, never standing or unlimited grants. */
export async function approvalSteps(read: Reader, chainId: ChainId, owner: Address, token: Token, spender: Address, amount: string, blockNumber?: string): Promise<Step[]> {
  if (token.address === null || BigInt(amount) === 0n) return [];
  const allowance = BigInt(String((await call(read, chainId, token.address, TOKEN_ALLOWANCE, [owner, spender], blockNumber)).value));
  if (allowance >= BigInt(amount)) return [];
  const step = (amount: bigint, label: string): Step => ({ label, kind: "approval", transaction: { chainId, accountId: "main", to: token.address!, valueWei: "0", data: encode(TOKEN_APPROVE, [spender, amount]) } });
  const usdtReset = chainId === "1" && token.address.toLowerCase() === "0xdac17f958d2ee523a2206206994597c13d831ec7" && allowance > 0n;
  return [...(usdtReset ? [step(0n, `Reset ${token.symbol} approval`)] : []), step(BigInt(amount), `Approve ${token.symbol}`)];
}

export async function quoteSwap(read: Reader, account: EvmAccount, raw: SwapInput, options: { catalog?: PoolCatalog; now?: number; onProgress?: (message: string) => void; signal?: AbortSignal } = {}): Promise<Plan> {
  const input = parseInput(raw) as SwapInput, owner = getAddress(account.address), recipient = input.recipient ?? owner;
  const network = CHAINS[input.chainId], amount = BigInt(input.amountIn);
  const wrap = (input.tokenIn === null && input.tokenOut === network.weth) || (input.tokenOut === null && input.tokenIn === network.weth);
  options.onProgress?.("Finding Curve pools for this pair…");
  const catalog = wrap ? { pools: [], complete: true, errors: [], fetchedAtMs: options.now ?? Date.now() } : options.catalog ?? await fetchPools(input.chainId, options.signal ? { signal: options.signal } : {});
  const candidates = wrap ? [null] : input.pool ? [catalog.pools.find((pool) => poolKey(pool) === poolKey(input.pool!)) ?? await verifyPool(read, input.pool)] : catalog.pools.filter((pool) => {
    try { swapRoute(input.chainId, input.tokenIn, input.tokenOut, pool); return true; } catch { return false; }
  });
  if (!candidates.length) throw new Error(catalog.complete ? "No supported direct Curve pool connects these assets. Choose another pair or an exact pool." : `Pool discovery is incomplete. Retry or choose a saved pool. ${catalog.errors.join("; ")}`);
  options.onProgress?.(`Comparing ${candidates.length} ${candidates.length === 1 ? "route" : "routes"}…`);
  const quotes = await Promise.allSettled(candidates.map(async (pool) => {
    const route = swapRoute(input.chainId, input.tokenIn, input.tokenOut, pool);
    const quote = await call(read, input.chainId, network.router, ROUTER_QUOTE, [route.route, route.params, amount, route.pools]);
    return { pool, route, output: BigInt(String(quote.value)), blockNumber: quote.blockNumber };
  }));
  options.signal?.throwIfAborted();
  const available = quotes.flatMap((result) => result.status === "fulfilled" && result.value.output > 0n ? [result.value] : []);
  available.sort((a, b) => a.output > b.output ? -1 : a.output < b.output ? 1 : 0);
  const warnings = [...catalog.errors, ...quotes.flatMap((result, i) => result.status === "rejected" ? [`${candidates[i]?.name ?? "Route"}: ${errorMessage(result.reason)}`] : [])];
  for (const selected of available) {
    let pool: VerifiedPool | null;
    try { pool = selected.pool ? await verifyPool(read, selected.pool, selected.pool, selected.blockNumber) : null; }
    catch (error) { warnings.push(errorMessage(error)); continue; }
    options.onProgress?.("Checking token amounts and existing approvals…");
    const [tokenIn, tokenOut] = await Promise.all([readToken(read, input.chainId, input.tokenIn, selected.blockNumber), readToken(read, input.chainId, input.tokenOut, selected.blockNumber)]);
    const min = minimum(selected.output, input.slippageBps), route = selected.route;
    const approvals = await approvalSteps(read, input.chainId, owner, tokenIn, network.router, input.amountIn, selected.blockNumber);
    let priceImpactBps: string | null = null;
    if (!wrap && amount > 1000n) {
      try {
        const small = amount / 1000n;
        const output = BigInt(String((await call(read, input.chainId, network.router, ROUTER_QUOTE, [route.route, route.params, small, route.pools], selected.blockNumber)).value));
        if (output > 0n) priceImpactBps = ((output * amount - selected.output * small) * 10000n / (output * amount)).toString();
      } catch { /* Optional marginal-price observation; executable quote survives. */ }
    }
    return { summary: `${wrap ? input.tokenIn === null ? "Wrap" : "Unwrap" : "Swap"} ${tokenIn.symbol} to ${tokenOut.symbol}`, chainId: input.chainId, accountAddress: owner,
      validUntil: (BigInt(Math.floor((options.now ?? Date.now()) / 1000)) + BigInt(input.quoteValiditySeconds)).toString(), pool,
      steps: [...approvals, { kind: "transaction", label: wrap ? input.tokenIn === null ? "Wrap ETH" : "Unwrap WETH" : "Swap tokens", transaction: { chainId: input.chainId, accountId: "main", to: network.router, valueWei: input.tokenIn === null ? input.amountIn : "0", data: encode(ROUTER_EXCHANGE, [route.route, route.params, amount, min, route.pools, recipient]) } }],
      preview: { inputs: [{ token: tokenIn, amount: input.amountIn }], outputs: [{ token: tokenOut, amount: selected.output.toString(), minimum: min.toString() }], recipient, blockNumber: selected.blockNumber,
        route: route.route.filter((address) => address !== ZERO), priceImpactBps, warnings } };
  }
  throw new Error(`No executable Curve quote is available. ${warnings.join("; ")}`);
}

export async function poolPosition(read: Reader, account: EvmAccount, pool: VerifiedPool) {
  const balance = BigInt(String((await call(read, pool.chainId, pool.lpToken, TOKEN_BALANCE, [getAddress(account.address)], pool.blockNumber)).value));
  const supply = BigInt(pool.supply);
  return { pool, lpBalance: balance.toString(), amounts: pool.balances.map((value) => supply === 0n ? "0" : (BigInt(value) * balance / supply).toString()), blockNumber: pool.blockNumber };
}

export async function quoteLiquidity(read: Reader, account: EvmAccount, raw: LiquidityInput, options: { catalog?: PoolCatalog; now?: number; signal?: AbortSignal; onProgress?: (message: string) => void } = {}): Promise<Plan> {
  const input = parseInput(raw) as LiquidityInput;
  options.onProgress?.("Verifying pool and token balances…");
  const pool = await findPool(read, input.pool, options), owner = getAddress(account.address), recipient = input.recipient ?? owner;
  if (isLegacy(pool) && recipient !== owner) throw new Error("This legacy pool pays liquidity proceeds to the signing wallet. Use your own address for this pool.");
  if (input.useNative && (pool.family !== "tricrypto-ng" || !pool.coins.some((coin) => coin.address === CHAINS[pool.chainId].weth))) throw new Error("This pool does not offer native ETH liquidity; use its listed pool assets.");
  const coins = pool.coins.map((coin): Token => input.useNative && coin.address === CHAINS[pool.chainId].weth ? { ...coin, address: null, symbol: "ETH" } : coin);
  const lpToken: Token = { chainId: pool.chainId, address: pool.lpToken, decimals: pool.lpDecimals, symbol: `${pool.name} LP` };
  const sig = liquiditySignatures(pool), tail = pool.family === "tricrypto-ng" ? [input.useNative, recipient] : isLegacy(pool) ? [] : [recipient];
  const preview: Preview = { inputs: [], outputs: [], recipient, blockNumber: pool.blockNumber, route: [pool.address], priceImpactBps: null, warnings: [] };
  const steps: Step[] = [];
  let transaction: Transaction, summary: string;
  if (input.kind === "deposit") {
    if (input.amounts.length !== coins.length || !input.amounts.some((amount) => BigInt(amount) > 0n)) throw new Error("Enter a deposit amount for at least one pool asset.");
    const amounts = input.amounts.map(BigInt);
    const minted = BigInt(String((await call(read, pool.chainId, pool.address, sig.quoteDeposit, [amounts, true], pool.blockNumber)).value));
    if (minted === 0n) throw new Error("The deposit is too small to mint LP tokens.");
    for (let i = 0; i < coins.length; i++) steps.push(...await approvalSteps(read, pool.chainId, owner, coins[i]!, pool.address, input.amounts[i]!, pool.blockNumber));
    preview.inputs = coins.map((token, i) => ({ token, amount: input.amounts[i]! }));
    preview.outputs = [{ token: lpToken, amount: minted.toString(), minimum: minimum(minted, input.slippageBps).toString() }];
    const nativeIndex = coins.findIndex((coin) => coin.address === null);
    transaction = { chainId: pool.chainId, accountId: "main", to: pool.address, valueWei: nativeIndex < 0 ? "0" : input.amounts[nativeIndex]!, data: encode(sig.deposit, [amounts, minimum(minted, input.slippageBps), ...tail]) };
    summary = `Add liquidity to ${pool.name}`;
  } else {
    const balance = (await poolPosition(read, account, pool)).lpBalance, burn = BigInt(input.lpAmount);
    if (burn > BigInt(balance)) throw new Error(`Your wallet holds ${balance} atomic LP units. Withdraw an amount within that balance.`);
    preview.inputs = [{ token: lpToken, amount: input.lpAmount }];
    if (input.kind === "withdraw_one") {
      if (input.coinIndex >= coins.length) throw new Error("Choose one of this pool's assets.");
      // Crypto pools can claim admin fees before burning LP supply. Their
      // standalone view can overestimate a one-coin withdrawal; simulate the
      // exact overload with a zero minimum to include that state transition.
      const output = isLegacy(pool)
        ? BigInt(String((await call(read, pool.chainId, pool.address, sig.quoteOne, [burn, BigInt(input.coinIndex)], pool.blockNumber)).value))
        : BigInt(String((await call(read, pool.chainId, pool.address, `${sig.withdrawOne} returns (uint256)`, [burn, BigInt(input.coinIndex), 0n, ...tail], pool.blockNumber)).value));
      preview.outputs = [{ token: coins[input.coinIndex]!, amount: output.toString(), minimum: minimum(output, input.slippageBps).toString() }];
      transaction = { chainId: pool.chainId, accountId: "main", to: pool.address, valueWei: "0", data: encode(sig.withdrawOne, [burn, BigInt(input.coinIndex), minimum(output, input.slippageBps), ...tail]) };
    } else {
      let outputs: bigint[];
      // NG methods return their actual withdrawal amounts. Simulating the zero-
      // minimum call includes current admin-fee minting and integer rounding.
      const simulated = await read(pool.chainId, pool.address, encode(sig.withdraw, [burn, coins.map(() => 0n), ...tail]), pool.blockNumber);
      if (!isLegacy(pool)) {
        const returns = pool.family === "stable-ng" ? "uint256[]" : pool.family === "tricrypto-ng" ? "uint256[3]" : "uint256[2]";
        outputs = decodeFunctionResult({ abi: parseAbi([`${sig.withdraw} returns (${returns})`] as string[]) as Abi, functionName: "remove_liquidity", data: simulated.data }) as bigint[];
      } else outputs = pool.balances.map((amount) => BigInt(amount) * burn / BigInt(pool.supply));
      preview.outputs = coins.map((token, index) => ({ token, amount: outputs[index]!.toString(), minimum: minimum(outputs[index]!, input.slippageBps).toString() }));
      transaction = { chainId: pool.chainId, accountId: "main", to: pool.address, valueWei: "0", data: encode(sig.withdraw, [burn, outputs.map((amount) => minimum(amount, input.slippageBps)), ...tail]) };
    }
    summary = `Remove liquidity from ${pool.name}`;
  }
  steps.push({ label: input.kind === "deposit" ? "Add liquidity" : "Remove liquidity", kind: "transaction", transaction });
  return { summary, chainId: pool.chainId, accountAddress: owner, validUntil: (BigInt(Math.floor((options.now ?? Date.now()) / 1000)) + BigInt(input.quoteValiditySeconds)).toString(), steps, pool, preview };
}

export async function preparePlan(wallet: EvmWalletClient, account: EvmAccount, input: Input, options: { signal?: AbortSignal; onProgress?: (message: string) => void; now?: number } = {}): Promise<Plan> {
  const read = walletReader(wallet, options.signal);
  return input.kind === "swap" ? quoteSwap(read, account, input, options) : quoteLiquidity(read, account, input, options);
}
export async function estimateFees(wallet: EvmWalletClient, plan: Plan, signal?: AbortSignal): Promise<Fee[]> {
  return Promise.all(plan.steps.map(async (step): Promise<Fee> => {
    try { return { label: step.label, estimate: await wallet.estimateTransaction(step.transaction, signal ? { signal } : undefined), error: null }; }
    catch (error) { signal?.throwIfAborted(); return { label: step.label, estimate: null, error: errorMessage(error) }; }
  }));
}
