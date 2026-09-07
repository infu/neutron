import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { IDL } from "@dfinity/candid";
import { decodeFunctionData, encodeFunctionResult, type Hex } from "viem";
import type { JsonObject, JsonValue, MsgBusToolCall, MsgBusToolContext, SelfCallValue } from "neutron-tools/app";
import { EVM_WALLET_TOOLS } from "neutron-tools/evm_wallet";
import { bridgeEvmRequestId, executeBridgeDeposit, createBridgeClient, type BridgeIntent, type BridgeQuote } from "../src/bridge.ts";
import { handleWalletWrap, summarizeWalletWrap, walletWrapInputSchema, walletWrapOutputSchema } from "../src/deposit_tools.ts";
import { handleBridgeRootNext } from "../src/bridge_tools.ts";
import { validateToolResult } from "neutron-tools/protocol";
import { extractPublicTypeAliases, generateAppMethodSchemaArtifact, motokoTypeToIdl, validateAppMethodArgs } from "neutron-scripts/src/method_schema.js";
import { encodeSelfCallValues } from "neutron-tools/app";
import { materializeSelfCallArguments } from "../../kernel/src/self_calls.ts";

const id = "12".repeat(16);
const account = `0x${"11".repeat(20)}`;
const helper = `0x${"22".repeat(20)}`;
const minter = `0x${"33".repeat(20)}`;
const token = `0x${"44".repeat(20)}`;
const fingerprint = `0x${"55".repeat(32)}`;
const blockHash = `0x${"66".repeat(32)}`;
const word = `0x${"00".repeat(32)}`;
const ledger = "xevnm-gaaaa-aaaar-qafnq-cai";
const owner = { appId: "agent", installationUid: "51" };
const args = { requestId: id, ledger, amountAtoms: "3000000" };
const helperAbi = [{ type: "function", name: "getMinterAddress", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] }] as const;
const erc20Abi = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
] as const;

function fixture(native = false) {
  let saved: BridgeIntent | null = null;
  let binding: Record<string, unknown> | null = null;
  let allowance = 0n;
  let sends = 0;
  const calls: MsgBusToolCall[] = [];
  const selfCalls: Array<{ method: string; values: SelfCallValue[] }> = [];
  const operations = new Map<string, Record<string, unknown>>();
  const state = { loseReply: false, mint: true, reject: false, rotateKey: false, cancelOnSend: false, failFirstQuote: false };
  const abort = new AbortController();
  const quote: BridgeQuote = { chainId: "1", ledger, minter: "sv3dd-oaaaa-aaaar-qacoa-cai", helperAddress: helper, helperMode: "subaccount", minterAddress: minter, tokenAddress: native ? null : token, recipient: "aaaaa-aa", principalWord: word, subaccountWord: word };
  const wireQuote = () => ({ chain_id: "1", ledger, minter: quote.minter, helper_address: helper, helper_mode: { subaccount: null }, minter_address: minter, ...(native ? {} : { token_address: token }), recipient: quote.recipient, principal_word: word, subaccount_word: word });
  const wire = () => {
    if (!saved) throw new Error("Bridge intent not found");
    return {
      id: Uint8Array.from(id.match(/../g)!, (byte) => Number.parseInt(byte, 16)), quote: wireQuote(),
      source: { evm_agent: { app_id: owner.appId, installation_uid: owner.installationUid } }, account, amount: saved.amount,
      steps: saved.steps.map((step) => ({ kind: { [step.kind]: null }, state: { [step.state]: null }, ...(step.operationId ? { operation_id: step.operationId } : {}), ...(step.transactionHash ? { transaction_hash: step.transactionHash } : {}), ...(step.error ? { error: step.error } : {}) })),
      revision: saved.revision, created_at: "1", updated_at: "1", event_cursor: "1",
      ...(saved.mint ? { mint: { ledger_block_index: saved.mint.ledgerBlockIndex, event_index: "2", verified_ledger: true } } : {}),
    };
  };
  const querySelf = async (method: string, values: SelfCallValue[] = []) => {
    selfCalls.push({ method, values });
    if (method === "wallet_bridge_provider_binding_v1") return binding ? { binding } : {};
    if (method === "wallet_bridge_status_v1") return wire();
    throw new Error(`Unexpected query ${method}`);
  };
  const updateSelf = async (method: string, values: SelfCallValue[]) => {
    selfCalls.push({ method, values });
    if (method === "wallet_bridge_quote_v1") return wireQuote();
    if (method === "wallet_bridge_provider_prepare_v1") {
      const input = values[0] as Record<string, Record<string, unknown>>;
      if (binding && JSON.stringify(binding) !== JSON.stringify(input.binding)) throw new Error("Different provider binding");
      binding = input.binding!;
      if (state.failFirstQuote) { state.failFirstQuote = false; throw new Error("Minter quote temporarily unavailable"); }
      if (!saved) saved = { id, source: owner, account, amount: String(input.bridge!.amount), quote, revision: "0", createdAt: "1", updatedAt: "1", eventCursor: "1", acceptedDeposit: null, mint: null, error: null,
        steps: (["reset_approval", "approval", "deposit"] as const).map((kind) => ({ kind, state: "ready", operationId: null, transactionHash: null, error: null })) };
      return wire();
    }
    if (!saved) throw new Error("Bridge intent not found");
    if (method === "wallet_bridge_refresh_v1") {
      if (state.mint && saved.steps[2]!.state === "confirmed") saved.mint = { ledgerBlockIndex: "123", eventIndex: "2", verifiedLedger: true };
      return wire();
    }
    if (method === "wallet_bridge_step_v2") {
      const action = values[0] as Record<string, unknown>;
      const input = (action.claim ?? action.record) as Record<string, unknown>;
      if (input.revision !== saved.revision) throw new Error("Revision conflict");
      const step = saved.steps.find((step) => step.kind === Object.keys(input.step as object)[0])!;
      if (action.claim !== undefined) {
        if (step.state !== "ready") throw new Error("Already claimed");
        step.state = "unknown"; step.operationId = String(input.operation_id);
      } else {
        step.state = Object.keys(input.state as object)[0] as typeof step.state;
        step.transactionHash = input.transaction_hash as Hex ?? null;
        step.error = input.error as string ?? null;
      }
      saved.revision = String(BigInt(saved.revision) + 1n);
      return wire();
    }
    throw new Error(`Unexpected update ${method}`);
  };
  const context = {
    caller: { ...owner, endpoint: "app:agent:tile:root" }, audience: "agent_root", agentMode: true, signal: abort.signal, reportProgress: () => undefined,
    kernel: { querySelf, updateSelf, async callTool(call: MsgBusToolCall, options?: unknown) {
      calls.push(structuredClone(call));
      expect(options).toHaveProperty("signal", abort.signal);
      if (call.name === EVM_WALLET_TOOLS.accounts) return { accounts: [{ accountId: "main", address: account, publicKey: `0x02${"77".repeat(32)}`, keyFingerprint: state.rotateKey ? word : fingerprint, namespaceVersion: "1" }] };
      if (call.name === EVM_WALLET_TOOLS.callContract || call.name === EVM_WALLET_TOOLS.readContract) {
        const result = String(call.arguments?.to).toLowerCase() === helper.toLowerCase()
          ? encodeFunctionResult({ abi: helperAbi, functionName: "getMinterAddress", result: minter as Hex })
          : encodeFunctionResult({ abi: erc20Abi, functionName: "allowance", result: allowance });
        return { ...call.arguments, address: account, result, ...(call.name === EVM_WALLET_TOOLS.readContract ? { code: "0x6001" } : {}), blockNumber: "100", observedAtNs: "1" };
      }
      if (call.name === EVM_WALLET_TOOLS.operationStatus) return structuredClone(operations.get(String(call.arguments?.requestId)) ?? { accountId: "main", chainId: "1", requestId: call.arguments?.requestId, status: "not_found" });
      if (call.name === EVM_WALLET_TOOLS.sendTransaction) {
        sends++;
        const requestId = String(call.arguments?.requestId);
        const hash = `0x${sends.toString(16).padStart(64, "0")}`;
        if (String(call.arguments?.to).toLowerCase() === token.toLowerCase() && !state.reject) allowance = decodeFunctionData({ abi: erc20Abi, data: call.arguments!.data as Hex }).args[1] as bigint;
        const operation = { accountId: "main", chainId: "1", requestId, operationId: String(sends), kind: "transaction", status: state.reject ? "rejected" : "confirmed", address: account, transactionHash: state.reject ? null : hash, signature: null, message: state.reject ? "Declined by Agent" : null, reviewRevision: "1",
          receipt: state.reject ? null : { blockNumber: "100", blockHash, status: "success", gasUsed: "21000", effectiveGasPriceWei: "1000000", logs: [], finality: "included", observedAtNs: "1" } };
        operations.set(requestId, operation);
        if (state.cancelOnSend) { abort.abort(new Error("Cancelled")); throw abort.signal.reason; }
        if (state.loseReply) { state.loseReply = false; throw new Error("Wallet reply lost"); }
        return structuredClone(operation);
      }
      throw new Error(`Unexpected nested tool ${call.name}`);
    } },
  } as unknown as MsgBusToolContext;
  return { context, state, calls, selfCalls, operations, saved: () => saved!, count: () => sends, abort,
    bridge: createBridgeClient({ query: (method) => querySelf(method), update: updateSelf }) };
}

test("Agent wrap automatically completes exact ERC20 approval, deposit and verified mint using ordinary provider sends", async () => {
  const f = fixture();
  const result = await handleWalletWrap(args, f.context);
  expect(result).toMatchObject({ status: "completed", phase: "completed", icLedgerBlockIndex: "123", requestId: id });
  expect(f.calls.filter((call) => call.name === EVM_WALLET_TOOLS.sendTransaction).map((call) => call.arguments?.requestId)).toEqual([bridgeEvmRequestId(id, "approval"), bridgeEvmRequestId(id, "deposit")]);
  expect(f.calls.some((call) => call.name.includes("_root_"))).toBe(false);
  expect(f.count()).toBe(2);
  expect(f.saved().source).toEqual(owner);
  expect(await handleWalletWrap(args, f.context)).toMatchObject({ status: "completed" });
  expect(f.count()).toBe(2);
  expect(() => validateToolResult({ name: "wallet_wrap_root_v1", inputSchema: walletWrapInputSchema, outputSchema: walletWrapOutputSchema }, result)).not.toThrow();
});
test("ETH wrap makes only a deposit and remains pending until the exact ckETH mint is verified", async () => {
  const f = fixture(true); f.state.mint = false;
  expect(await handleWalletWrap(args, f.context)).toMatchObject({ status: "pending", phase: "ck_token_mint", nextAction: "refresh_mint" });
  expect(f.count()).toBe(1);
  f.state.mint = true;
  expect(await handleWalletWrap(args, f.context)).toMatchObject({ status: "completed" });
  expect(f.count()).toBe(1);
});
test("lost approval reply resumes its exact Wallet request and proceeds to deposit without another approval", async () => {
  const f = fixture(); f.state.loseReply = true;
  expect(await handleWalletWrap(args, f.context)).toMatchObject({ status: "pending", phase: "approval", nextAction: "continue_same_request" });
  expect(f.count()).toBe(1);
  expect(await handleWalletWrap(args, f.context)).toMatchObject({ status: "completed" });
  expect(f.count()).toBe(2);
});
test("Agent owner, signing key and exact amount cannot change when resuming a saved provider wrap", async () => {
  const f = fixture(); f.state.loseReply = true;
  await handleWalletWrap(args, f.context);
  await expect(handleWalletWrap({ ...args, amountAtoms: "4" }, f.context)).rejects.toThrow("different wrapping amount");
  await expect(handleWalletWrap(args, { ...f.context, caller: { ...f.context.caller!, installationUid: "52" } })).rejects.toThrow("original root Agent");
  f.state.rotateKey = true;
  await expect(handleWalletWrap(args, f.context)).rejects.toThrow("signing key changed");
  expect(f.count()).toBe(1);
});
test("UI and low-level direct-root APIs cannot execute the provider deposit", async () => {
  const f = fixture(); f.state.loseReply = true;
  await handleWalletWrap(args, f.context);
  await expect(handleBridgeRootNext({ id }, f.context)).rejects.toThrow("Wallet provider");
  await expect(executeBridgeDeposit({ intent: f.saved(), client: f.bridge, provider: { request: async () => { throw new Error("Must not reach provider"); } } })).rejects.toThrow("controlled by its original root Agent");
  expect(f.count()).toBe(1);
});
test("explicit rejection is terminal and does not fall through to an Ethereum deposit", async () => {
  const f = fixture(); f.state.reject = true;
  expect(await handleWalletWrap(args, f.context)).toMatchObject({ status: "failed", nextAction: "none" });
  expect(f.count()).toBe(1);
});
test("cancelled provider call returns the durable request and cannot be reported as a mint", async () => {
  const f = fixture(); f.state.cancelOnSend = true;
  expect(await handleWalletWrap(args, f.context)).toMatchObject({ requestId: id, status: "pending", nextAction: "continue_same_request" });
  expect(f.count()).toBe(1);
  expect(summarizeWalletWrap(f.saved()).status).toBe("pending");
});
test("non-root wrapping calls fail before any read or effect", async () => {
  const f = fixture();
  await expect(handleWalletWrap(args, { ...f.context, audience: undefined } as unknown as MsgBusToolContext)).rejects.toThrow("root-agent attestation");
  expect(f.calls).toHaveLength(0);
});
test("failed first quote retains the provider binding and retries the same preparation without losing the request", async () => {
  const f = fixture(); f.state.failFirstQuote = true;
  expect(await handleWalletWrap(args, f.context)).toMatchObject({ requestId: id, status: "pending", phase: "ready", nextAction: "continue_same_request" });
  expect(f.count()).toBe(0);
  expect(await handleWalletWrap(args, f.context)).toMatchObject({ requestId: id, status: "completed" });
  expect(f.count()).toBe(2);
});
test("automatic wrap self calls satisfy the current generated Candid method contract", async () => {
  const f = fixture(true);
  await handleWalletWrap(args, f.context);
  const [source, manifest] = await Promise.all([
    readFile(new URL("../backend/main.mo", import.meta.url), "utf8"),
    readFile(new URL("../neutron.json", import.meta.url), "utf8"),
  ]);
  const artifact = generateAppMethodSchemaArtifact(JSON.parse(manifest), source);
  const aliases = extractPublicTypeAliases(source);
  const publicValue = (value: SelfCallValue): JsonValue => {
    if (value instanceof Uint8Array) return [...value];
    if (Array.isArray(value)) return value.map(publicValue);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, publicValue(item)]));
    return value;
  };
  for (const call of f.selfCalls) {
    expect(validateAppMethodArgs(artifact, call.method, call.values.map(publicValue))).toEqual({ valid: true, errors: [] });
    const input = motokoTypeToIdl(aliases[`${call.method}_Input`]!, IDL, aliases);
    const encoded = encodeSelfCallValues(call.values);
    const bound = materializeSelfCallArguments(encoded.value, encoded.blobs, [input]);
    // Materialization explicitly fills omitted Candid option fields with null.
    expect(bound.args).toMatchObject(call.values);
  }
  expect(f.selfCalls.some((call) => call.method === "wallet_bridge_provider_prepare_v1")).toBe(true);
  expect(f.selfCalls.some((call) => call.method === "wallet_bridge_provider_binding_v1")).toBe(true);
});
