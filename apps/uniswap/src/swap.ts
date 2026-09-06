import { decodeFunctionResult, encodeFunctionData, getAddress, isAddress, parseAbi, parseUnits, type Address, type Hex } from "viem";

export const ROUTER = getAddress("0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45");
export const QUOTER = getAddress("0x61ffe014ba17989e743c5f6cb21bf9697530b21e");
export const FACTORY = getAddress("0x1f98431c8ad98523631ae4a59f267346ea31f984");
export const FEE_TIERS = [100, 500, 3000, 10000] as const;
export type Token = { chainId: string; address: Address | null; symbol: string; decimals: number };
export const NETWORKS = {
  "1": { name: "Ethereum", wrapped: getAddress("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"), usdc: getAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"), explorer: "https://etherscan.io/tx/" },
  "42161": { name: "Arbitrum", wrapped: getAddress("0x82af49447d8a07e3bd95bd0d56f35241523fbab1"), usdc: getAddress("0xaf88d065e77c8cc2239327c5edb3a432268e5831"), explorer: "https://arbiscan.io/tx/" },
} as const;
export type Chain = keyof typeof NETWORKS;
export const TOKEN_ABI = parseAbi([
  "function decimals() view returns (uint8)", "function symbol() view returns (string)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
]);
export const QUOTER_ABI = parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)"]);
export const ROUTER_ABI = parseAbi([
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
  "function unwrapWETH9(uint256 amountMinimum,address recipient) payable",
  "function refundETH() payable",
]);
const FACTORY_ABI = parseAbi(["function getPool(address tokenA,address tokenB,uint24 fee) view returns (address pool)"]);
const POOL_ABI = parseAbi(["function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)"]);
export type ReadResult = { data: Hex; blockNumber: string | null; observedAtMs: number };
export type Reader = (chainId: string, address: Address, data: Hex, blockTag?: string) => Promise<ReadResult>;
export type QuoteInput = { chainId: string; accountId: string; accountAddress: Address; tokenIn: Token; tokenOut: Token; amountIn: string; slippageBps: number; recipient: Address; deadline: string };
export type Quote = QuoteInput & { router: Address; quoter: Address; fee: number; amountOut: string; minimumOut: string; gasEstimate: string; priceImpactBps: string | null; quotedAtMs: number; blockNumber: string | null; pool: Address | null; routeWarnings: string[] };
export type Transaction = { chainId: string; accountId: string; to: Address; value: string; data: Hex };
export type PreparedSwap = { quote: Quote; approval: Transaction | null; swap: Transaction; allowance: string | null };

export function network(chainId: string) {
  if (!Object.hasOwn(NETWORKS, chainId)) throw new Error("Select Ethereum or Arbitrum.");
  return NETWORKS[chainId as Chain];
}
export function defaultTokens(chainId: string): Token[] {
  const n = network(chainId);
  return [{ chainId, address: null, symbol: "ETH", decimals: 18 }, { chainId, address: n.usdc, symbol: "USDC", decimals: 6 }, { chainId, address: n.wrapped, symbol: "WETH", decimals: 18 }];
}
export function tokenAddress(token: Token): Address { return token.address ?? network(token.chainId).wrapped; }
export function amountAtoms(amount: string, token: Token): string {
  if (/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.exec(amount)?.[0] !== amount || (amount.split(".")[1]?.length ?? 0) > token.decimals) throw new Error(`Enter a positive amount with at most ${token.decimals} decimals.`);
  const atoms = parseUnits(amount, token.decimals);
  if (atoms <= 0n || atoms >= 2n ** 256n) throw new Error("Amount must fit a positive uint256.");
  return atoms.toString();
}
export function slippageBasisPoints(value: string): number {
  if (/^(?:0|[1-9][0-9]?)(?:\.[0-9]{1,2})?$/u.exec(value)?.[0] !== value) throw new Error("Slippage must be 0–99.99%, with at most two decimal places.");
  return Number(parseUnits(value, 2));
}
function positive(value: string, label: string) { if (/^[1-9][0-9]*$/u.exec(value)?.[0] !== value || BigInt(value) >= 2n ** 256n) throw new Error(`Invalid ${label}.`); }
export function validateInput(input: QuoteInput, nowMs = Date.now()): void {
  network(input.chainId);
  for (const token of [input.tokenIn, input.tokenOut]) {
    if (token.chainId !== input.chainId || !Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 255 || (token.address !== null && !isAddress(token.address))) throw new Error("Token does not match the selected network.");
  }
  if (!input.accountId || !isAddress(input.accountAddress) || !isAddress(input.recipient) || /^0x0{40}$/i.test(input.recipient)) throw new Error("Select an account and a nonzero recipient address.");
  if (tokenAddress(input.tokenIn).toLowerCase() === tokenAddress(input.tokenOut).toLowerCase()) throw new Error("Choose different tokens. ETH/WETH wrapping is not a pool swap.");
  positive(input.amountIn, "input amount"); positive(input.deadline, "deadline");
  if (BigInt(input.deadline) <= BigInt(Math.floor(nowMs / 1000))) throw new Error("Swap deadline has expired. Request a new quote.");
  if (!Number.isInteger(input.slippageBps) || input.slippageBps < 0 || input.slippageBps >= 10000) throw new Error("Slippage must be between 0 and 99.99%.");
}
export async function customToken(read: Reader, chainId: string, address: string): Promise<Token> {
  network(chainId); const checked = getAddress(address);
  const decimals = await read(chainId, checked, encodeFunctionData({ abi: TOKEN_ABI, functionName: "decimals" }));
  const d = decodeFunctionResult({ abi: TOKEN_ABI, functionName: "decimals", data: decimals.data });
  let symbol = checked.slice(0, 8);
  try { symbol = decodeFunctionResult({ abi: TOKEN_ABI, functionName: "symbol", data: (await read(chainId, checked, encodeFunctionData({ abi: TOKEN_ABI, functionName: "symbol" }))).data }); } catch { /* Metadata is descriptive; address is authoritative. */ }
  return { chainId, address: checked, decimals: d, symbol };
}
export async function quoteSwap(read: Reader, input: QuoteInput, nowMs = Date.now()): Promise<Quote> {
  validateInput(input, nowMs);
  const tokenIn = tokenAddress(input.tokenIn), tokenOut = tokenAddress(input.tokenOut);
  const quotePool = async (fee: typeof FEE_TIERS[number]) => {
    const r = await read(input.chainId, QUOTER, encodeFunctionData({ abi: QUOTER_ABI, functionName: "quoteExactInputSingle", args: [{ tokenIn, tokenOut, amountIn: BigInt(input.amountIn), fee, sqrtPriceLimitX96: 0n }] }));
    const [amountOut, , , gasEstimate] = decodeFunctionResult({ abi: QUOTER_ABI, functionName: "quoteExactInputSingle", data: r.data });
    if (amountOut <= 0n) throw new Error("Pool returned no output");
    return { fee, amountOut, gasEstimate, response: r };
  };
  // A fresh Wallet read can ask for owner consent. Await it before the next
  // pool so concurrent permission prompts cannot hide otherwise valid routes.
  const results: PromiseSettledResult<Awaited<ReturnType<typeof quotePool>>>[] = [];
  for (const fee of FEE_TIERS) {
    try { results.push({ status: "fulfilled", value: await quotePool(fee) }); }
    catch (reason) { results.push({ status: "rejected", reason }); }
  }
  const available = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  if (!available.length) throw new Error(`No direct V3 pool quote is available. ${results.map((r) => r.status === "rejected" ? String(r.reason) : "").join("; ")}`);
  available.sort((a, b) => a.amountOut > b.amountOut ? -1 : a.amountOut < b.amountOut ? 1 : a.fee - b.fee);
  const best = available[0]!;
  const routeWarnings = results.flatMap((r, i) => r.status === "rejected" ? [`${FEE_TIERS[i]! / 10000}% pool unavailable: ${String(r.reason)}`] : []);
  let pool: Address | null = null, priceImpactBps: string | null = null;
  try {
    const tag = best.response.blockNumber === null ? undefined : `0x${BigInt(best.response.blockNumber).toString(16)}`;
    pool = decodeFunctionResult({ abi: FACTORY_ABI, functionName: "getPool", data: (await read(input.chainId, FACTORY, encodeFunctionData({ abi: FACTORY_ABI, functionName: "getPool", args: [tokenIn, tokenOut, best.fee] }), tag)).data });
    const [sqrt] = decodeFunctionResult({ abi: POOL_ABI, functionName: "slot0", data: (await read(input.chainId, pool, encodeFunctionData({ abi: POOL_ABI, functionName: "slot0" }), tag)).data });
    const numerator = sqrt * sqrt, denominator = 2n ** 192n;
    const spotOut = tokenIn.toLowerCase() < tokenOut.toLowerCase() ? BigInt(input.amountIn) * numerator / denominator : BigInt(input.amountIn) * denominator / numerator;
    const afterFee = spotOut * BigInt(1_000_000 - best.fee) / 1_000_000n;
    if (afterFee > 0n) priceImpactBps = ((afterFee - best.amountOut) * 10000n / afterFee).toString();
  } catch (error) { routeWarnings.push(`Price impact unavailable: ${String(error)}`); }
  const minimumOut = best.amountOut * BigInt(10000 - input.slippageBps) / 10000n;
  if (minimumOut === 0n) throw new Error("Minimum received rounds to zero; change amount or slippage.");
  return { ...input, router: ROUTER, quoter: QUOTER, fee: best.fee, amountOut: best.amountOut.toString(), minimumOut: minimumOut.toString(), gasEstimate: best.gasEstimate.toString(), priceImpactBps, quotedAtMs: best.response.observedAtMs, blockNumber: best.response.blockNumber, pool, routeWarnings };
}
export function swapTransaction(quote: Quote, nowMs = Date.now()): Transaction {
  validateInput(quote, nowMs);
  if (quote.router !== ROUTER || quote.quoter !== QUOTER || !(FEE_TIERS as readonly number[]).includes(quote.fee)) throw new Error("Quote route does not match a supported deployment.");
  positive(quote.amountOut, "quoted output"); positive(quote.minimumOut, "minimum output");
  if (BigInt(quote.minimumOut) !== BigInt(quote.amountOut) * BigInt(10000 - quote.slippageBps) / 10000n) throw new Error("Quote minimum output does not match slippage.");
  const nativeOutput = quote.tokenOut.address === null;
  const calls: Hex[] = [encodeFunctionData({ abi: ROUTER_ABI, functionName: "exactInputSingle", args: [{ tokenIn: tokenAddress(quote.tokenIn), tokenOut: tokenAddress(quote.tokenOut), fee: quote.fee, recipient: nativeOutput ? ROUTER : quote.recipient, amountIn: BigInt(quote.amountIn), amountOutMinimum: BigInt(quote.minimumOut), sqrtPriceLimitX96: 0n }] })];
  if (nativeOutput) calls.push(encodeFunctionData({ abi: ROUTER_ABI, functionName: "unwrapWETH9", args: [BigInt(quote.minimumOut), quote.recipient] }));
  if (quote.tokenIn.address === null) calls.push(encodeFunctionData({ abi: ROUTER_ABI, functionName: "refundETH" }));
  return { chainId: quote.chainId, accountId: quote.accountId, to: ROUTER, value: quote.tokenIn.address === null ? quote.amountIn : "0", data: encodeFunctionData({ abi: ROUTER_ABI, functionName: "multicall", args: [BigInt(quote.deadline), calls] }) };
}
export async function prepareSwap(read: Reader, quote: Quote, nowMs = Date.now()): Promise<PreparedSwap> {
  const swap = swapTransaction(quote, nowMs);
  if (quote.tokenIn.address === null) return { quote, approval: null, swap, allowance: null };
  const allowance = decodeFunctionResult({ abi: TOKEN_ABI, functionName: "allowance", data: (await read(quote.chainId, quote.tokenIn.address, encodeFunctionData({ abi: TOKEN_ABI, functionName: "allowance", args: [quote.accountAddress, ROUTER] }))).data });
  const approval: Transaction | null = allowance >= BigInt(quote.amountIn) ? null : { chainId: quote.chainId, accountId: quote.accountId, to: quote.tokenIn.address, value: "0", data: encodeFunctionData({ abi: TOKEN_ABI, functionName: "approve", args: [ROUTER, BigInt(quote.amountIn)] }) };
  return { quote, approval, swap, allowance: allowance.toString() };
}
