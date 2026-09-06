import { getAddress, isAddress, type Hex } from "viem";
import type { EvmAccount } from "neutron-tools/evm_wallet";
import type { ActionPlan } from "./action_types.ts";
import { customToken, defaultTokens, network, quoteSwap, swapTransaction, type Quote, type QuoteInput, type Reader } from "./swap.ts";
import { validateV4PoolKey, type V4PoolKey } from "./v4_common.ts";
import { prepareV4Swap, quoteV4Swap, type V4Quote } from "./v4_swap.ts";
import { planErc20Approval } from "./approval_plan.ts";

export type UnifiedSwapInput = {
  protocol: "auto" | "v3" | "v4";
  chainId: string;
  accountId: "main";
  tokenIn: string | null;
  tokenOut: string | null;
  amountIn: string;
  recipient: string | null;
  slippageBps: number;
  quoteValiditySeconds: string;
  poolKey?: V4PoolKey;
  hookData?: Hex;
};
export type UnifiedQuote = (Quote & { protocol: "v3" }) | V4Quote;

/** Canonical owner inputs are saved before any approval. Quote renewal changes
 * market observations, never the amount, recipient, route preference or pool. */
export function parseUnifiedSwapInput(raw: Record<string, unknown>): UnifiedSwapInput {
  const protocol = raw.protocol ?? "auto";
  if (protocol !== "auto" && protocol !== "v3" && protocol !== "v4") throw new Error("Choose auto, v3 or v4 routing.");
  const chainId = String(raw.chainId ?? "");
  network(chainId);
  if (raw.accountId !== undefined && raw.accountId !== "main") throw new Error("Select the main EVM Wallet account.");
  const token = (value: unknown) => {
    if (value === null) return null;
    if (typeof value !== "string" || !isAddress(value)) throw new Error("Use a token contract address, or null for native ETH.");
    return getAddress(value);
  };
  if (typeof raw.amountIn !== "string" || !/^[1-9][0-9]*$/.test(raw.amountIn) || BigInt(raw.amountIn) >= 1n << 256n) throw new Error("amountIn must be a positive uint256 in atomic units.");
  const recipient = raw.recipient === undefined || raw.recipient === null ? null : token(raw.recipient);
  if (recipient && BigInt(recipient) === 0n) throw new Error("Use a nonzero recipient address.");
  const slippageBps = raw.slippageBps ?? 50;
  if (typeof slippageBps !== "number" || !Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10000) throw new Error("Slippage must be between 0 and 9999 basis points.");
  const quoteValiditySeconds = raw.quoteValiditySeconds ?? "1200";
  if (typeof quoteValiditySeconds !== "string" || !/^[1-9][0-9]*$/.test(quoteValiditySeconds) || BigInt(quoteValiditySeconds) >= 1n << 256n) throw new Error("Quote validity must be a positive number of seconds.");
  if ((raw.poolKey !== undefined || raw.hookData !== undefined) && protocol !== "v4") throw new Error("Select v4 when specifying an exact pool key or hook data.");
  const poolKey = raw.poolKey === undefined ? undefined : validateV4PoolKey(raw.poolKey as V4PoolKey);
  let hookData: Hex | undefined;
  if (raw.hookData !== undefined) {
    if (typeof raw.hookData !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(raw.hookData)) throw new Error("Hook data must contain whole hexadecimal bytes.");
    hookData = raw.hookData as Hex;
  }
  return { protocol, chainId, accountId: "main", tokenIn: token(raw.tokenIn), tokenOut: token(raw.tokenOut), amountIn: raw.amountIn, recipient, slippageBps, quoteValiditySeconds, ...(poolKey ? { poolKey } : {}), ...(hookData !== undefined ? { hookData } : {}) };
}

async function quoteInput(read: Reader, account: EvmAccount, input: UnifiedSwapInput, nowMs: number): Promise<QuoteInput> {
  if (account.accountId !== input.accountId) throw new Error("The selected EVM Wallet account is unavailable.");
  const defaults = defaultTokens(input.chainId);
  const resolve = async (address: string | null) => defaults.find((token) => address === null ? token.address === null : token.address?.toLowerCase() === address.toLowerCase()) ?? customToken(read, input.chainId, String(address));
  const [tokenIn, tokenOut] = await Promise.all([resolve(input.tokenIn), resolve(input.tokenOut)]);
  return { chainId: input.chainId, accountId: input.accountId, accountAddress: getAddress(account.address), tokenIn, tokenOut, amountIn: input.amountIn, recipient: getAddress(input.recipient ?? account.address), slippageBps: input.slippageBps, deadline: (BigInt(Math.floor(nowMs / 1000)) + BigInt(input.quoteValiditySeconds)).toString() };
}

export async function quoteUnifiedSwap(read: Reader, account: EvmAccount, input: UnifiedSwapInput, nowMs = Date.now(), onProgress?: (message: string) => void): Promise<UnifiedQuote> {
  const checked = parseUnifiedSwapInput(input), common = await quoteInput(read, account, checked, nowMs);
  const v3 = async (): Promise<UnifiedQuote> => ({ ...await quoteSwap(read, common, nowMs, onProgress), protocol: "v3" });
  const v4 = () => quoteV4Swap(read, { ...common, ...(checked.poolKey ? { poolKey: checked.poolKey } : {}), ...(checked.hookData !== undefined ? { hookData: checked.hookData } : {}) }, nowMs, onProgress);
  if (checked.protocol === "v3") return v3();
  if (checked.protocol === "v4") return v4();
  const results = await Promise.allSettled([v3(), v4()]);
  const quotes = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  if (!quotes.length) throw new Error(`No direct V3 or V4 quote is available. ${results.map((result) => result.status === "rejected" ? String(result.reason) : "").join("; ")}`);
  // Compare output amounts, not token counts or a guessed gas-adjusted value.
  // On a tie V3 avoids introducing Permit2 prerequisites unnecessarily.
  quotes.sort((a, b) => BigInt(a.amountOut) > BigInt(b.amountOut) ? -1 : BigInt(a.amountOut) < BigInt(b.amountOut) ? 1 : a.protocol === "v3" ? -1 : 1);
  const best = quotes[0]!;
  return { ...best, routeWarnings: [...best.routeWarnings, ...results.flatMap((result, index) => result.status === "rejected" ? [`V${index === 0 ? "3" : "4"} comparison unavailable: ${String(result.reason)}`] : [])] };
}

export async function prepareQuotedSwap(read: Reader, quote: UnifiedQuote, nowMs = Date.now()): Promise<ActionPlan> {
  if (quote.protocol === "v4") return prepareV4Swap(read, quote, nowMs);
  const swap = swapTransaction(quote, nowMs);
  const approvals = quote.tokenIn.address === null ? [] : await planErc20Approval(read, { chainId: quote.chainId, accountId: quote.accountId, owner: quote.accountAddress, token: quote.tokenIn.address, spender: quote.router, amount: quote.amountIn, symbol: quote.tokenIn.symbol });
  return {
    chainId: quote.chainId, accountId: quote.accountId, accountAddress: quote.accountAddress, deadline: quote.deadline,
    summary: `Swap ${quote.tokenIn.symbol} for ${quote.tokenOut.symbol} on Uniswap V3`,
    steps: [...approvals, { label: "Swap tokens", kind: "transaction", transaction: swap }],
    details: { protocol: "v3", quote },
  };
}

export async function prepareUnifiedSwap(read: Reader, account: EvmAccount, input: UnifiedSwapInput, nowMs = Date.now(), onProgress?: (message: string) => void): Promise<ActionPlan> {
  return prepareQuotedSwap(read, await quoteUnifiedSwap(read, account, input, nowMs, onProgress), nowMs);
}
