import { exposeTool, type JsonObject } from "neutron-tools/app";
import { walletReader } from "./controller.ts";
import { parseUnifiedSwapInput, prepareUnifiedSwap, quoteUnifiedSwap, type UnifiedSwapInput } from "./swap_routes.ts";
import { actionOutputSchema, compactToken, runToolAction, tokenOutputSchema, toolAccount, toolAddress, toolJson, toolNullableText, toolOperationId, toolPositive, toolSchema, toolText } from "./liquidity_tools.ts";

const poolKeySchema = toolSchema({ currency0: toolAddress, currency1: toolAddress, fee: { type: "integer", minimum: 0 }, tickSpacing: { type: "integer", minimum: 1 }, hooks: toolAddress });
const swapProperties: JsonObject = {
  protocol: { enum: ["auto", "v3", "v4"] }, chainId: { enum: ["1", "42161"] }, accountId: { const: "main" },
  tokenIn: { oneOf: [toolAddress, { type: "null" }] }, tokenOut: { oneOf: [toolAddress, { type: "null" }] }, amountIn: toolPositive,
  recipient: { oneOf: [toolAddress, { type: "null" }] }, slippageBps: { type: "integer", minimum: 0, maximum: 9999 }, quoteValiditySeconds: toolPositive,
  poolKey: poolKeySchema, hookData: { type: "string", pattern: "^0x[0-9a-fA-F]*$" },
};

export function registerV4Tools() {
  exposeTool("uniswap_quote_v2", {
    title: "Compare Uniswap V3 and V4 swap quotes",
    description: "Read direct-pool exact-input quotes on Ethereum or Arbitrum. protocol auto compares V3 and V4 output amounts across standard pools; it does not claim global multi-hop or gas-adjusted routing. Specify v3 or v4 to select a version. An explicit V4 poolKey/hookData requires protocol v4 and preserves the actual currencies, fee, tick spacing and hooks. Null token means ETH; amountIn uses atomic units. Defaults: auto routing, main account, own recipient, 50 slippage bps, 1200 seconds. For independent USD estimates, call EVM Wallet evm_wallet_prices_v1 with the quote token chain IDs and addresses; its prices include source timestamps and can be unavailable without blocking this quote. This is read-only; use uniswap_swap_v2 for the complete approval and swap flow.",
    inputSchema: toolSchema(swapProperties, ["chainId", "tokenIn", "tokenOut", "amountIn"]),
    outputSchema: toolSchema({ protocol: { enum: ["v3", "v4"] }, chainId: toolText, accountId: toolText, tokenIn: tokenOutputSchema, tokenOut: tokenOutputSchema, amountIn: toolText, amountOut: toolText, minimumOut: toolText, recipient: toolAddress, slippageBps: { type: "integer" }, deadline: toolText, fee: { type: "integer" }, gasEstimate: toolText, priceImpactBps: toolNullableText, blockNumber: toolNullableText, pool: toolNullableText, poolId: toolNullableText, poolKey: { oneOf: [poolKeySchema, { type: "null" }] }, warnings: { type: "array", items: toolText } }),
    annotations: { "neutron:effects": ["read", "network"], "neutron:longRunning": true },
  }, async (args, context) => {
    const input = parseUnifiedSwapInput(args), { account, read } = await toolAccount(context, input.accountId);
    const quote = await quoteUnifiedSwap(read, account, input, Date.now(), (phase) => context.reportProgress({ phase }));
    return toolJson({ protocol: quote.protocol, chainId: quote.chainId, accountId: quote.accountId, tokenIn: compactToken(quote.tokenIn), tokenOut: compactToken(quote.tokenOut), amountIn: quote.amountIn, amountOut: quote.amountOut, minimumOut: quote.minimumOut, recipient: quote.recipient, slippageBps: quote.slippageBps, deadline: quote.deadline, fee: quote.fee, gasEstimate: quote.gasEstimate, priceImpactBps: quote.priceImpactBps, blockNumber: quote.blockNumber, pool: quote.pool, poolId: quote.protocol === "v4" ? quote.poolId : null, poolKey: quote.protocol === "v4" ? quote.poolKey : null, warnings: quote.routeWarnings });
  });

  exposeTool("uniswap_swap_v2", {
    title: "Swap through Uniswap V3 or V4 through confirmation",
    description: "Complete an exact-input V3 or V4 swap: compare quotes, reuse allowance, approve exact amounts when needed, perform every Wallet review, send the swap and verify its receipt. Defaults and routing semantics match uniswap_quote_v2. Keep one stable 32-hex operationId and identical original arguments. Continue pending/review results by calling this tool again; never stop at token or Permit2 approval and never make a duplicate operation after a lost reply. Expired known-unsigned plans renew within the original inputs; uncertain submitted requests keep their IDs. Serialize effectful swap and liquidity flows within one Agent run; independent reads can run in parallel. Wallet sends exact transaction reviews to the human or current root Agent judge using the owner's existing instructions. Existing uniswap_swap_v1 flow IDs must continue through v1.",
    inputSchema: toolSchema({ operationId: toolOperationId, ...swapProperties }, ["operationId", "chainId", "tokenIn", "tokenOut", "amountIn"]),
    outputSchema: actionOutputSchema, annotations: { "neutron:effects": ["read", "write", "network", "user_visible_ui"], "neutron:longRunning": true },
  }, (args, context) => {
    const input = parseUnifiedSwapInput(args);
    return runToolAction(context, { operationId: String(args.operationId), kind: "swap", chainId: input.chainId, accountId: "main", input }, ({ wallet, account, envelope, now, onProgress }) => prepareUnifiedSwap(walletReader(wallet, account.accountId), account, envelope.input as UnifiedSwapInput, now(), onProgress), "uniswap_swap_v2");
  });
}
