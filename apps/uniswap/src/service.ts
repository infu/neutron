import { exposeTool, type JsonObject, type JsonValue, type MsgBusToolContext } from "neutron-tools/app";
import { createEvmWalletClient, requireEvmWalletCaller } from "neutron-tools/evm_wallet";
import { getAddress } from "viem";
import { customToken, defaultTokens, prepareSwap, quoteSwap, validateInput, type Quote } from "./swap.ts";
import { createSwapStore, savedIntent, verifyAgentResult, walletReader, type SavedIntent, type SwapRecord } from "./controller.ts";

const text = { type: "string" };
const address = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };
const nat = { type: "string", pattern: "^[1-9][0-9]*$" };
function schema(properties: JsonObject) { return { type: "object", properties, required: Object.keys(properties), additionalProperties: false }; }
function json(value: unknown): JsonValue { return value as JsonValue; }
function recordOutput(record: SwapRecord) {
  return { swapId: record.id, phase: record.phase, recordJson: JSON.stringify(record), approvalRequestJson: record.approval_request_json, swapRequestJson: record.swap_request_json };
}
const recordSchema = schema({ swapId: text, phase: text, recordJson: text, approvalRequestJson: { oneOf: [text, { type: "null" }] }, swapRequestJson: text });
const quoteSchema = schema({ chainId: { enum: ["1", "42161"] }, accountId: { const: "main" }, tokenIn: { oneOf: [address, { type: "null" }] }, tokenOut: { oneOf: [address, { type: "null" }] }, amountIn: nat, slippageBps: { type: "integer", minimum: 0, maximum: 9999 }, recipient: address, deadline: nat });

exposeTool("uniswap_quote_v1", {
  title: "Quote a Uniswap V3 swap",
  description: "Read live direct-pool exact-input quotes on Ethereum or Arbitrum through EVM Wallet. tokenIn/tokenOut null means native ETH; amountIn is atomic units. Compare available V3 fee tiers. No transaction or signature is requested.",
  inputSchema: quoteSchema, outputSchema: schema({ quoteJson: text }), annotations: { "neutron:effects": ["read", "network"] },
}, async (args, context) => {
  const wallet = createEvmWalletClient(context.kernel);
  const account = (await wallet.accounts()).accounts.find((entry) => entry.accountId === args.accountId);
  if (!account) throw new Error("EVM Wallet account is unavailable.");
  const chain = String(args.chainId), read = walletReader(wallet, account.accountId);
  const token = async (value: JsonValue | undefined) => value === null ? defaultTokens(chain)[0]! : customToken(read, chain, String(value));
  const input = { chainId: chain, accountId: account.accountId, accountAddress: getAddress(account.address), tokenIn: await token(args.tokenIn), tokenOut: await token(args.tokenOut), amountIn: String(args.amountIn), slippageBps: Number(args.slippageBps), recipient: getAddress(String(args.recipient)), deadline: String(args.deadline) };
  return { quoteJson: JSON.stringify(await quoteSwap(read, input)) };
});

exposeTool("uniswap_prepare_v1", {
  title: "Save an exact Uniswap swap intent",
  description: "Validate and persist quote-derived exact approval/swap requests. Reuse swapId for an identical prepare retry. This performs no EVM effect. The root agent calls EVM Wallet root tools directly, waits for approval confirmation, then calls the swap request. Save transaction results with uniswap_record_result_v1, which verifies public chain evidence. Never refresh or replace an ambiguous submitted request.",
  inputSchema: schema({ swapId: { type: "string", pattern: "^[0-9a-f]{32}$" }, quoteJson: text }), outputSchema: recordSchema,
  annotations: { "neutron:effects": ["write", "network"] },
}, async (args, context) => {
  const store = createSwapStore(context.kernel);
  const quote = JSON.parse(String(args.quoteJson)) as Quote;
  const walletCaller = requireEvmWalletCaller(context);
  const existing = await store.get(String(args.swapId));
  if (existing) {
    if (JSON.stringify(savedIntent(existing).walletCaller) !== JSON.stringify(walletCaller) || JSON.stringify(savedIntent(existing).quote) !== JSON.stringify(quote)) throw new Error("Swap ID already contains a different quote.");
    return json(recordOutput(existing));
  }
  validateInput(quote);
  const wallet = createEvmWalletClient(context.kernel);
  const account = (await wallet.accounts()).accounts.find((entry) => entry.accountId === quote.accountId);
  if (!account || account.address.toLowerCase() !== quote.accountAddress.toLowerCase()) throw new Error("The quote account no longer matches EVM Wallet.");
  const intent: SavedIntent = { ...await prepareSwap(walletReader(wallet, account.accountId), quote), account, executionMode: "agent", walletCaller };
  return json(recordOutput(await store.begin(intent, String(args.swapId))));
});

exposeTool("uniswap_status_v1", {
  title: "Read a saved Uniswap swap",
  description: "Read durable quote, exact wallet request IDs and independently recorded receipt progress. Does not claim a pending transaction succeeded.",
  inputSchema: schema({ swapId: text }), outputSchema: schema({ recordJson: { oneOf: [text, { type: "null" }] } }), annotations: { "neutron:effects": ["read"] },
}, async (args, context) => { const record = await createSwapStore(context.kernel).get(String(args.swapId)); return { recordJson: record ? JSON.stringify(record) : null }; });

exposeTool("uniswap_list_v1", {
  title: "List saved Uniswap swaps", description: "Read saved swap intents and approval/swap progress.", inputSchema: schema({}), outputSchema: schema({ recordsJson: text }), annotations: { "neutron:effects": ["read"] },
}, async (_args, context) => ({ recordsJson: JSON.stringify(await createSwapStore(context.kernel).list()) }));

exposeTool("uniswap_record_result_v1", {
  title: "Verify and record a root-agent swap transaction",
  description: "Bind an EVM Wallet root result to a saved approval/swap request, then independently read actual transaction from/to/data/value and receipt through EVM RPC. A caller-supplied success claim is never enough. Keep an unresolved transaction request and check again when it appears on chain.",
  inputSchema: schema({ swapId: text, stage: { enum: ["approval", "swap"] }, operationJson: text }), outputSchema: recordSchema,
  annotations: { "neutron:effects": ["write", "network"] },
}, async (args, context: MsgBusToolContext) => {
  const store = createSwapStore(context.kernel), record = await store.get(String(args.swapId));
  if (!record) throw new Error("Saved swap was not found.");
  return json(recordOutput(await verifyAgentResult(createEvmWalletClient(context.kernel), store, record, args.stage as "approval" | "swap", JSON.parse(String(args.operationJson)))));
});
