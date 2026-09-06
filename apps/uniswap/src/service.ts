import { exposeTool, type JsonObject, type JsonValue, type MsgBusToolContext } from "neutron-tools/app";
import { requireEvmWalletCaller } from "neutron-tools/evm_wallet";
import { getAddress } from "viem";
import { customToken, defaultTokens, prepareSwap, quoteSwap, validateInput, type Quote } from "./swap.ts";
import { createSwapStore, savedIntent, verifyAgentResult, walletReader, type SavedIntent, type SwapRecord } from "./controller.ts";
import { estimateSwapFees } from "./fees.ts";
import { createServiceWallet } from "./agent_wallet.ts";
import { nextAgentSwapAction } from "./agent_workflow.ts";

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
  description: "Read live direct-pool exact-input quotes on Ethereum or Arbitrum through EVM Wallet. tokenIn/tokenOut null means native ETH; amountIn is atomic units. Compare available V3 fee tiers and check live allowance, including approvals from earlier expired quotes. No transaction or signature is requested. To execute, save this quote with uniswap_prepare_v1, then follow uniswap_next_action_v1 through approval and swap confirmation.",
  inputSchema: quoteSchema, outputSchema: schema({ quoteJson: text }), annotations: { "neutron:effects": ["read", "network"], "neutron:longRunning": true },
}, async (args, context) => {
  context.reportProgress({ phase: "Checking EVM Wallet account" });
  const wallet = createServiceWallet(context);
  const account = (await wallet.accounts()).accounts.find((entry) => entry.accountId === args.accountId);
  if (!account) throw new Error("EVM Wallet account is unavailable.");
  const chain = String(args.chainId), read = walletReader(wallet, account.accountId);
  const defaults = defaultTokens(chain);
  const token = async (value: JsonValue | undefined) => defaults.find((entry) => value === null ? entry.address === null : entry.address?.toLowerCase() === String(value).toLowerCase()) ?? customToken(read, chain, String(value));
  const [tokenIn, tokenOut] = await Promise.all([token(args.tokenIn), token(args.tokenOut)]);
  const input = { chainId: chain, accountId: account.accountId, accountAddress: getAddress(account.address), tokenIn, tokenOut, amountIn: String(args.amountIn), slippageBps: Number(args.slippageBps), recipient: getAddress(String(args.recipient)), deadline: String(args.deadline) };
  const quoted = await quoteSwap(read, input, Date.now(), (phase) => context.reportProgress({ phase }));
  context.reportProgress({ phase: "Checking existing token allowance" });
  const prepared = await prepareSwap(read, quoted);
  context.reportProgress({ phase: "Estimating approval and swap network fees" });
  const quote = { ...prepared.quote, networkFees: await estimateSwapFees(wallet, prepared) };
  context.reportProgress({ phase: "Quote ready" });
  return { quoteJson: JSON.stringify(quote) };
});

exposeTool("uniswap_prepare_v1", {
  title: "Save an exact Uniswap swap intent",
  description: "Validate and persist quote-derived exact approval/swap requests. Reuse swapId for an identical prepare retry. This performs no EVM effect. Next call uniswap_next_action_v1 with both operation JSON fields null; follow its exact root Wallet action and return each Wallet result to that continuation tool. It independently verifies approval and swap receipts and handles safely expired quotes. Never refresh or replace an ambiguous submitted request.",
  inputSchema: schema({ swapId: { type: "string", pattern: "^[0-9a-f]{32}$" }, quoteJson: text }), outputSchema: recordSchema,
  annotations: { "neutron:effects": ["write", "network"], "neutron:longRunning": true },
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
  const wallet = createServiceWallet(context);
  const account = (await wallet.accounts()).accounts.find((entry) => entry.accountId === quote.accountId);
  if (!account || account.address.toLowerCase() !== quote.accountAddress.toLowerCase()) throw new Error("The quote account no longer matches EVM Wallet.");
  const intent: SavedIntent = { ...await prepareSwap(walletReader(wallet, account.accountId), quote), account, executionMode: "agent", walletCaller };
  return json(recordOutput(await store.begin(intent, String(args.swapId))));
});

exposeTool("uniswap_next_action_v1", {
  title: "Continue an Agent swap through approval and confirmation",
  description: "Return the exact next action for the saved swap owned by this Agent installation. Initially pass both operation JSON fields null. Call returned nextCall directly as the root Agent, then pass the Wallet result back in the matching approvalOperationJson or swapOperationJson field, retaining the other latest observation. A lost send reply requires the same request's root Wallet operation-status result. Supplied hashes are independently verified and recorded; no transaction is sent here. Follow wait actions after pollAfterSeconds instead of asking the owner to retry. On quote_expired, follow the fresh quote only within the owner's instructions, then prepare a distinct swapId; existing allowance is reused. Completion requires a verified swap receipt, not just approval. Never dispatch root Wallet effects in parallel or replace an ambiguous submitted intent.",
  inputSchema: schema({ swapId: text, swapOperationJson: { oneOf: [text, { type: "null" }] }, approvalOperationJson: { oneOf: [text, { type: "null" }] } }),
  outputSchema: schema({
    swapId: text, phase: text, state: { enum: ["check_status", "send", "wait", "complete", "quote_expired", "stopped"] },
    stage: { enum: ["approval", "swap", null] }, message: text,
    nextCall: { oneOf: [schema({ target: text, tool: text, argsJson: text }), { type: "null" }] },
    pollAfterSeconds: { oneOf: [{ type: "integer", minimum: 0 }, { type: "null" }] },
  }),
  annotations: { "neutron:effects": ["read", "write", "network"], "neutron:longRunning": true },
}, async (args, context) => {
  const caller = requireEvmWalletCaller(context);
  const store = createSwapStore(context.kernel), record = await store.get(String(args.swapId));
  if (!record) throw new Error("Saved swap was not found.");
  context.reportProgress({ phase: "Checking saved swap and approval evidence" });
  return json(await nextAgentSwapAction(createServiceWallet(context), store, record, caller, {
    swapOperationJson: args.swapOperationJson as string | null,
    approvalOperationJson: args.approvalOperationJson as string | null,
  }));
});

exposeTool("uniswap_status_v1", {
  title: "Read a saved Uniswap swap",
  description: "Read durable quote, exact wallet request IDs and independently recorded receipt progress. Does not claim a pending transaction succeeded. Use uniswap_next_action_v1 to continue an Agent-owned approval or swap with those saved IDs.",
  inputSchema: schema({ swapId: text }), outputSchema: schema({ recordJson: { oneOf: [text, { type: "null" }] } }), annotations: { "neutron:effects": ["read"] },
}, async (args, context) => { const record = await createSwapStore(context.kernel).get(String(args.swapId)); return { recordJson: record ? JSON.stringify(record) : null }; });

exposeTool("uniswap_list_v1", {
  title: "List saved Uniswap swaps", description: "Read saved swap intents and approval/swap progress. For large histories use uniswap_list_page_v1 and follow nextCursor; this compatibility tool returns the complete list in one tool response.", inputSchema: schema({}), outputSchema: schema({ recordsJson: text }), annotations: { "neutron:effects": ["read"] },
}, async (_args, context) => ({ recordsJson: JSON.stringify(await createSwapStore(context.kernel).list()) }));

exposeTool("uniswap_list_page_v1", {
  title: "Read a page of saved Uniswap swaps",
  description: "Read newest saved swaps first without fitting the entire history into one response. Start with cursor null, then pass nextCursor until null. Records and request IDs remain intact; no wallet effect is requested.",
  inputSchema: schema({ cursor: { oneOf: [text, { type: "null" }] }, limit: { type: "integer", minimum: 1 } }),
  outputSchema: schema({ recordsJson: text, nextCursor: { oneOf: [text, { type: "null" }] } }),
  annotations: { "neutron:effects": ["read"] },
}, async (args, context) => {
  const page = await createSwapStore(context.kernel).page(args.cursor as string | null, Number(args.limit));
  return { recordsJson: JSON.stringify(page.rows), nextCursor: page.nextCursor };
});

exposeTool("uniswap_record_result_v1", {
  title: "Verify and record a root-agent swap transaction",
  description: "Bind an EVM Wallet root result to a saved approval/swap request, then independently read actual transaction from/to/data/value and receipt through EVM RPC. A caller-supplied success claim is never enough. Keep an unresolved transaction request and check again when it appears on chain.",
  inputSchema: schema({ swapId: text, stage: { enum: ["approval", "swap"] }, operationJson: text }), outputSchema: recordSchema,
  annotations: { "neutron:effects": ["write", "network"], "neutron:longRunning": true },
}, async (args, context: MsgBusToolContext) => {
  const store = createSwapStore(context.kernel), record = await store.get(String(args.swapId));
  if (!record) throw new Error("Saved swap was not found.");
  return json(recordOutput(await verifyAgentResult(createServiceWallet(context), store, record, args.stage as "approval" | "swap", JSON.parse(String(args.operationJson)))));
});
