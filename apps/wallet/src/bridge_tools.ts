import { exposeTool, type JsonObject, type MsgBusToolContext } from "neutron-tools/app";
import { createEvmWalletClient, requireEvmWalletCaller, evmSendTransactionInputSchema, type EvmSendTransactionRequest } from "neutron-tools/evm_wallet";
import { decodeFunctionResult, encodeFunctionData, type Hex } from "viem";
import { assertBridgeQuoteCurrent, bridgeEvmRequestId, bridgeTransaction, createBridgeClient, type BridgeIntent, type BridgeSource } from "./bridge.ts";
import type { EthereumDepositStep } from "./ethereum.ts";
import { assertBridgeTransactionMatches } from "./evm_bridge.ts";

const text: JsonObject = { type: "string" };
const nat: JsonObject = { type: "string", pattern: "^0$|^[1-9][0-9]*$" };
const address: JsonObject = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };
const hash: JsonObject = { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" };
const requestId: JsonObject = { type: "string", pattern: "^[0-9a-f]{32}$" };
const nullable = (schema: JsonObject): JsonObject => ({ oneOf: [schema, { type: "null" }] });
const closed = (properties: JsonObject): JsonObject => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const stepSchema: JsonObject = { enum: ["reset_approval", "approval", "deposit"] };
export const bridgeQuoteSchema = closed({ chainId: { const: "1" }, ledger: text, minter: text, helperAddress: address, helperMode: { enum: ["subaccount", "legacy"] }, minterAddress: address, tokenAddress: nullable(address), recipient: text, principalWord: hash, subaccountWord: hash });
export const bridgeIntentSchema = closed({
  id: requestId, quote: bridgeQuoteSchema, source: { oneOf: [{ enum: ["external", "evm"] }, closed({ appId: text, installationUid: nat })] }, account: address, amount: nat,
  steps: { type: "array", items: closed({ kind: stepSchema, state: { enum: ["ready", "unknown", "submitted", "confirmed", "failed"] }, operationId: nullable(text), transactionHash: nullable(hash), error: nullable(text) }) },
  revision: nat, createdAt: text, updatedAt: text, eventCursor: nat,
  acceptedDeposit: nullable(closed({ logIndex: nat, blockNumber: nat, eventIndex: nat })),
  mint: nullable(closed({ ledgerBlockIndex: nat, eventIndex: nat, verifiedLedger: { type: "boolean" } })), error: nullable(text),
});
const nextSchema = closed({ intent: bridgeIntentSchema, step: nullable(stepSchema), request: nullable(evmSendTransactionInputSchema), message: text });
const rootAnnotations: JsonObject = { "neutron:audience": "agent_root", "neutron:visibility": "same_app", "neutron:audit": "metadata_only", "neutron:effects": ["read", "write", "network"] };
const allowanceAbi = [{ type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] }] as const;
const helperAbi = [{ type: "function", name: "getMinterAddress", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] }] as const;

export function registerBridgeTools(): void {
  exposeTool("wallet_bridge_quote_v1", { title: "Quote an Ethereum ck-token deposit", description: "Read the current official ckETH minter, helper, token mapping, IC recipient and Ethereum Mainnet chain. This does not submit or sign a transaction.", inputSchema: closed({ ledger: text }), outputSchema: bridgeQuoteSchema, annotations: { "neutron:effects": ["read", "network"] } }, async (args, context) => json(await scopedBridge(context).quote(stringArg(args, "ledger"))));
  exposeTool("wallet_bridge_status_v1", { title: "Read a saved ck-token deposit", description: "Read one durable bridge intent and its exact transaction/mint evidence. An unrelated balance increase never completes a bridge.", inputSchema: closed({ id: requestId }), outputSchema: bridgeIntentSchema, annotations: { "neutron:effects": ["read"] } }, async (args, context) => json(await scopedBridge(context).status(stringArg(args, "id"))));
  exposeTool("wallet_bridge_refresh_v1", { title: "Reconcile a ck-token deposit mint", description: "Reconcile the recorded Ethereum deposit against the minter event and exact IC mint block. Does not send another transaction.", inputSchema: closed({ id: requestId }), outputSchema: bridgeIntentSchema, annotations: { "neutron:effects": ["read", "write", "network"] } }, async (args, context) => json(await scopedBridge(context).refresh(stringArg(args, "id"))));
  exposeTool("wallet_bridge_prepare_root_v1", { title: "Save a ck-token bridge for root Agent execution", description: "Save an Ethereum Mainnet deposit from EVM Wallet, bound to this original root caller installation. No signing occurs. Call wallet_bridge_next_root_v1 for the next exact transaction, invoke EVM Wallet's root transaction tool directly, then attach its hash.", inputSchema: closed({ id: requestId, ledger: text, amountAtoms: { type: "string", pattern: "^[1-9][0-9]*$" } }), outputSchema: bridgeIntentSchema, annotations: rootAnnotations }, handleBridgeRootPrepare);
  exposeTool("wallet_bridge_next_root_v1", { title: "Prepare the next root bridge transaction", description: "Validate helper identity and allowance, durably claim one exact approval/deposit step, and return its stable EVM Wallet request. Pending steps return the same request; never replace its request ID. Execute using EVM Wallet's root tool directly, then attach the actual chain transaction hash.", inputSchema: closed({ id: requestId }), outputSchema: nextSchema, annotations: rootAnnotations }, handleBridgeRootNext);
  exposeTool("wallet_bridge_attach_root_v1", { title: "Attach a root bridge transaction", description: "Verify a transaction's actual network, sender, helper/token destination, value and calldata before binding its hash to the saved bridge step. Records receipts and mint progress without submitting any transaction.", inputSchema: closed({ id: requestId, step: stepSchema, transactionHash: hash }), outputSchema: bridgeIntentSchema, annotations: rootAnnotations }, handleBridgeRootAttach);
  exposeTool("wallet_bridge_attach_replacement_root_v1", { title: "Attach a verified root bridge speed-up", description: "Preserve the original EVM Wallet request/hash and record its journal-proven replacement separately. The replacement must perform the exact saved approval/deposit. Cancellations and changed calls cannot advance the bridge. Use both hashes even if the original RPC transaction was evicted before attachment.", inputSchema: closed({ id: requestId, step: stepSchema, originalTransactionHash: hash, transactionHash: hash }), outputSchema: bridgeIntentSchema, annotations: rootAnnotations }, handleBridgeRootAttachReplacement);
}
export async function handleBridgeRootPrepare(args: JsonObject, context: MsgBusToolContext): Promise<JsonObject> {
  const source = rootCaller(context);
  const bridge = scopedBridge(context);
  const evm = createEvmWalletClient(context.kernel);
  const account = (await evm.accounts()).accounts.find((entry) => entry.accountId === "main");
  if (!account) throw new Error("EVM Wallet's main account is unavailable");
  return json(await bridge.prepare({ id: stringArg(args, "id"), ledger: stringArg(args, "ledger"), source, account: account.address, amount: stringArg(args, "amountAtoms") }));
}
export async function handleBridgeRootNext(args: JsonObject, context: MsgBusToolContext): Promise<JsonObject> {
  const caller = rootCaller(context);
  const bridge = scopedBridge(context);
  let intent = await bridge.status(stringArg(args, "id"));
  assertExecutor(intent, caller);
  const evm = createEvmWalletClient(context.kernel);
  const account = (await evm.accounts()).accounts.find((entry) => entry.accountId === "main");
  if (!account || account.address.toLowerCase() !== intent.account.toLowerCase()) throw new Error("This bridge belongs to a different EVM Wallet key; its request will not be replayed");
  const failed = intent.steps.find((step) => step.state === "failed");
  if (failed) return json({ intent, step: null, request: null, message: failed.error ?? "A bridge transaction failed. Completed steps remain recorded." });
  const deposit = intent.steps.find((step) => step.kind === "deposit")!;
  if (deposit.state === "confirmed") return json({ intent: await bridge.refresh(intent.id), step: null, request: null, message: "Ethereum deposit confirmed; checking only this deposit's minter and IC mint evidence." });
  const pending = intent.steps.find((step) => step.state === "unknown" || step.state === "submitted");
  if (pending?.transactionHash) {
    const effective = await bridge.effectiveHash(intent.id, pending.kind);
    const message = effective && effective.toLowerCase() !== pending.transactionHash.toLowerCase()
      ? `Saved original transaction ${pending.transactionHash}; verified replacement execution ${effective}. Call wallet_bridge_attach_replacement_root_v1 with originalTransactionHash ${pending.transactionHash} and transactionHash ${effective} to reconcile. Do not submit another transaction.`
      : `Saved transaction ${pending.transactionHash}; call wallet_bridge_attach_root_v1 with this hash to reconcile its receipt. Do not submit another transaction.`;
    return json({ intent, step: pending.kind, request: null, message });
  }
  // A claim can survive a crash before EVM Wallet saw it. Without a recorded
  // hash this is not proof of dispatch, so validate the live route and helper
  // before returning an executable request. Known hashes reconcile above.
  assertBridgeQuoteCurrent(intent.quote, await bridge.quote(intent.quote.ledger));
  const scope = { chainId: "1", accountId: "main" as const };
  const helperRead = await evm.readContract({ ...scope, to: intent.quote.helperAddress, data: encodeFunctionData({ abi: helperAbi, functionName: "getMinterAddress" }) });
  const actualMinter = decodeFunctionResult({ abi: helperAbi, functionName: "getMinterAddress", data: helperRead.result as Hex });
  if (!/[1-9a-f]/i.test(helperRead.code.slice(2)) || actualMinter.toLowerCase() !== intent.quote.minterAddress.toLowerCase()) throw new Error("The saved deposit helper does not match the official minter");
  if (pending) return json({ intent, step: pending.kind, request: evmRequest(intent, pending.kind), message: "Resume this exact EVM Wallet request under the original root caller. Check its EVM operation status before executing; do not substitute a new request ID." });
  let kind: EthereumDepositStep = "deposit";
  if (intent.quote.tokenAddress) {
    const read = await evm.readContract({ ...scope, to: intent.quote.tokenAddress, data: encodeFunctionData({ abi: allowanceAbi, functionName: "allowance", args: [intent.account as Hex, intent.quote.helperAddress as Hex] }) });
    if (!/[1-9a-f]/i.test(read.code.slice(2))) throw new Error("The saved token has no contract code");
    const allowance = decodeFunctionResult({ abi: allowanceAbi, functionName: "allowance", data: read.result as Hex });
    if (allowance !== BigInt(intent.amount)) {
      kind = allowance === 0n ? "approval" : "reset_approval";
      if (intent.steps.find((step) => step.kind === kind)?.state === "confirmed") throw new Error("The helper allowance changed after this step completed. Reconcile that change before preparing another bridge; completed approvals will not be repeated.");
    }
  }
  intent = await bridge.claim(intent, kind, bridgeEvmRequestId(intent.id, kind));
  return json({ intent, step: kind, request: evmRequest(intent, kind), message: "Call evm_send_transaction_root_v1 directly with this exact request, then wallet_bridge_attach_root_v1 with its hash. IC Wallet does not inherit or forward root signing authority." });
}
export async function handleBridgeRootAttach(args: JsonObject, context: MsgBusToolContext): Promise<JsonObject> {
  const caller = rootCaller(context);
  const bridge = scopedBridge(context);
  const intent = await bridge.status(stringArg(args, "id"));
  assertExecutor(intent, caller);
  const kind = stringArg(args, "step") as EthereumDepositStep;
  if (!["reset_approval", "approval", "deposit"].includes(kind)) throw new Error("Invalid bridge step");
  const step = intent.steps.find((step) => step.kind === kind)!;
  if (step.state === "ready") throw new Error("Claim the step before executing and attaching a transaction");
  const hash = stringArg(args, "transactionHash");
  if (!step.operationId) throw new Error("This bridge step has no saved EVM Wallet request identity");
  const evidence = await createEvmWalletClient(context.kernel).transaction({ chainId: "1", transactionHash: hash, walletRequest: { callerAppId: caller.appId, callerInstallationUid: caller.installationUid, requestId: step.operationId } });
  if (evidence.walletRequestMatches !== true) {
    if (step.transactionHash && step.transactionHash.toLowerCase() !== hash.toLowerCase()) return attachRootReplacement(bridge, intent, caller, kind, step.transactionHash, hash, context);
    throw new Error("The Ethereum transaction is not bound to this exact root caller installation and saved EVM Wallet request");
  }
  const expected = bridgeTransaction(intent, kind);
  const actual = evidence.transaction;
  if (!actual) throw new Error("This transaction is not yet available from Ethereum. Keep the same hash and retry reconciliation.");
  if (actual.from.toLowerCase() !== expected.from.toLowerCase() || actual.to?.toLowerCase() !== expected.to.toLowerCase() || actual.data.toLowerCase() !== expected.data.toLowerCase() || actual.valueWei !== BigInt(expected.value ?? "0x0").toString()) throw new Error("The Ethereum transaction does not match this saved bridge step");
  const state = evidence.receipt?.status === "reverted" ? "failed" : evidence.receipt?.status === "success" ? "confirmed" : "submitted";
  // Re-read to merge harmless background mint refreshes after the RPC await.
  const latest = await bridge.status(intent.id);
  assertExecutor(latest, caller);
  const recorded = await bridge.record(latest, kind, state, hash as Hex, state === "failed" ? "The Ethereum transaction reverted" : null);
  return json(kind === "deposit" ? await bridge.refresh(recorded.id) : recorded);
}
export async function handleBridgeRootAttachReplacement(args: JsonObject, context: MsgBusToolContext): Promise<JsonObject> {
  const caller = rootCaller(context);
  const bridge = scopedBridge(context);
  const intent = await bridge.status(stringArg(args, "id"));
  assertExecutor(intent, caller);
  const kind = stringArg(args, "step") as EthereumDepositStep;
  if (!["reset_approval", "approval", "deposit"].includes(kind)) throw new Error("Invalid bridge step");
  return attachRootReplacement(bridge, intent, caller, kind, stringArg(args, "originalTransactionHash"), stringArg(args, "transactionHash"), context);
}
async function attachRootReplacement(bridge: ReturnType<typeof createBridgeClient>, intent: BridgeIntent, caller: Exclude<BridgeSource, string>, kind: EthereumDepositStep, originalHash: string, replacementHash: string, context: MsgBusToolContext): Promise<JsonObject> {
  const step = intent.steps.find((entry) => entry.kind === kind)!;
  if (step.state === "ready" || !step.operationId) throw new Error("Claim the saved bridge step before attaching its replacement");
  if (step.transactionHash && step.transactionHash.toLowerCase() !== originalHash.toLowerCase()) throw new Error("The replacement cannot change the saved original transaction hash");
  if (originalHash.toLowerCase() === replacementHash.toLowerCase()) throw new Error("A replacement requires a different execution hash");
  const wallet = createEvmWalletClient(context.kernel);
  const walletRequest = { callerAppId: caller.appId, callerInstallationUid: caller.installationUid, requestId: step.operationId };
  const original = await wallet.transaction({ chainId: "1", transactionHash: originalHash, walletRequest });
  if (original.walletRequestMatches !== true) throw new Error("The original hash is not bound to this exact root caller installation and saved EVM Wallet request");
  if (original.receipt) throw new Error("The original transaction already has a receipt; reconcile that execution before attributing a replacement");
  const proof = await wallet.replacementTransaction({ chainId: "1", transactionHash: replacementHash, originalWalletRequest: walletRequest });
  if (!proof.walletReplacementMatches) throw new Error("EVM Wallet did not prove this replacement descends from the exact saved root request");
  const evidence = await wallet.transaction({ chainId: "1", transactionHash: replacementHash });
  if (!evidence.transaction) throw new Error("The replacement is not yet visible on Ethereum; keep both hashes and retry reconciliation");
  assertBridgeTransactionMatches(bridgeTransaction(intent, kind), evidence.transaction);
  if (original.transaction && original.transaction.nonce !== evidence.transaction.nonce) throw new Error("The replacement transaction has a different nonce");
  const state = evidence.receipt?.status === "success" ? "confirmed" : evidence.receipt?.status === "reverted" ? "failed" : "submitted";
  let latest = await bridge.status(intent.id);
  assertExecutor(latest, caller);
  if (!latest.steps.find((entry) => entry.kind === kind)!.transactionHash) latest = await bridge.record(latest, kind, "submitted", originalHash as Hex);
  const previous = await bridge.effectiveHash(intent.id, kind) ?? originalHash as Hex;
  const error = state === "failed" ? "The replacement transaction reverted on Ethereum" : null;
  const recorded = previous.toLowerCase() === replacementHash.toLowerCase()
    ? await bridge.record(latest, kind, state, originalHash as Hex, error)
    : await bridge.recordReplacement(latest, kind, originalHash as Hex, previous, replacementHash as Hex, state, error);
  return json(kind === "deposit" ? await bridge.refresh(recorded.id) : recorded);
}

function evmRequest(intent: BridgeIntent, kind: EthereumDepositStep): EvmSendTransactionRequest {
  const tx = bridgeTransaction(intent, kind);
  const operation = intent.steps.find((step) => step.kind === kind)?.operationId;
  if (!operation) throw new Error("The bridge step has no saved EVM Wallet request identity");
  return { accountId: "main", chainId: "1", requestId: operation, to: tx.to, valueWei: BigInt(tx.value ?? "0x0").toString(), data: tx.data };
}
function rootCaller(context: MsgBusToolContext): Exclude<BridgeSource, string> {
  return requireEvmWalletCaller(context, true);
}
function assertExecutor(intent: BridgeIntent, caller: Exclude<BridgeSource, string>): void { if (typeof intent.source === "string" || intent.source.appId !== caller.appId || intent.source.installationUid !== caller.installationUid) throw new Error("Only the original root Agent installation can resume this bridge. Its signing command identity cannot be transferred to another app."); }
function scopedBridge(context: MsgBusToolContext) { return createBridgeClient({ query: (method, args) => context.kernel.querySelf(method, args), update: (method, args) => context.kernel.updateSelf(method, args, 120) }); }
function json(value: unknown): JsonObject { return value as JsonObject; }
function stringArg(args: JsonObject, key: string): string { const value = args[key]; if (typeof value !== "string") throw new Error(`Invalid ${key}`); return value; }
