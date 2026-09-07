import { expect, test } from "bun:test";
import { decodeFunctionData, encodeAbiParameters, keccak256, stringToHex } from "viem";
import type { EvmAccount, EvmEffectRequest, EvmOperationResult, EvmReceipt, EvmSendTransactionRequest, EvmTransactionResult, EvmWalletClient } from "neutron-tools/evm_wallet";
import { createFundingTransport, fundingState, quoteFunding, runFunding, type FundingInput, type FundingObservation, type FundingOptions, type FundingQuote, type FundingTransport } from "../src/funding.ts";
import { CCTP, CORE_DEPOSIT_ABI, parseFundingInput } from "../src/funding_protocol.ts";
import { stable, type RecordRow, type Store } from "../src/store.ts";

const id = "ab".repeat(16), owner = "0x1111111111111111111111111111111111111111", caller = { appId: "agent", installationUid: "17" };
const account: EvmAccount = { accountId: "main", address: owner, publicKey: `0x02${"66".repeat(32)}`, keyFingerprint: `0x${"77".repeat(32)}`, namespaceVersion: "1" };
const receipt: EvmReceipt = { blockNumber: "123", blockHash: `0x${"99".repeat(32)}`, status: "success", gasUsed: "50000", effectiveGasPriceWei: "10000000", finality: "included", observedAtNs: "1800000000000000000", logs: [] };
const pending: FundingObservation = { phase: "waiting_attestation", sourceTransactionHash: `0x${"44".repeat(32)}`, destinationTransactionHash: null, receivedAtoms: null, message: "Waiting for CCTP", evidence: null };
function fixture(direction: "deposit" | "withdraw" = "deposit", approval = false) {
  const input: FundingInput = { environment: "mainnet", direction, chainId: "1", amount: "10" }, rows = new Map<string, RecordRow>(), operations = new Map<string, EvmOperationResult>(), transactions = new Map<string, EvmTransactionResult>();
  const sends: EvmEffectRequest[] = [], posts: unknown[] = [], events: string[] = [];
  let selected = account, maxFee = "200000", observations = pending, now = 1800000000000;
  const store: Store = {
    async get(id) { return structuredClone(rows.get(id) ?? null); },
    async begin(value) { const prior = rows.get(value.id); if (prior) { if (prior.input_json !== value.input_json) throw Error("Intent conflict"); return structuredClone(prior); } const row = { ...value, revision: "0", created_at: String(now), updated_at: String(now) }; rows.set(value.id, row); events.push("begin"); return structuredClone(row); },
    async update(prior, state, phase) { if (rows.get(prior.id)?.revision !== prior.revision) throw Error("Revision conflict"); const row = { ...prior, state_json: stable(state), phase, revision: String(BigInt(prior.revision) + 1n) }; rows.set(prior.id, row); events.push(phase); return structuredClone(row); },
    async page() { return { rows: [...rows.values()], nextCursor: null }; },
  };
  const hash = (request: EvmEffectRequest) => keccak256(stringToHex(request.requestId));
  const operation = (request: EvmEffectRequest, status: EvmOperationResult["status"] = "confirmed"): EvmOperationResult => {
    const signature = "typedDataJson" in request && status === "signed" ? `0x${"11".repeat(32)}${"22".repeat(32)}1b` : null;
    return { ...{ accountId: request.accountId, chainId: request.chainId, requestId: request.requestId }, operationId: "1", kind: "typedDataJson" in request ? "typed_data" : "transaction", status, address: owner, transactionHash: "typedDataJson" in request || status === "prepared" ? null : hash(request), signature, message: null, reviewRevision: "1", receipt: status === "confirmed" ? receipt : null };
  };
  const evidence = (request: EvmSendTransactionRequest, success = true): EvmTransactionResult => ({ chainId: request.chainId, transactionHash: hash(request), walletRequestMatches: null, transaction: { from: owner, to: request.to, data: request.data, valueWei: "0", nonce: "0", blockNumber: success ? "123" : null, blockHash: success ? receipt.blockHash : null }, receipt: success ? receipt : null, observedAtNs: receipt.observedAtNs, source: "evm_rpc" });
  let send = async (request: EvmEffectRequest) => operation(request, "typedDataJson" in request ? "signed" : "confirmed");
  let exchange = async (_envelope: unknown): Promise<unknown> => ({ status: "ok", response: { type: "default" } });
  const invoke = async (request: EvmEffectRequest) => { sends.push(structuredClone(request)); events.push("send"); const result = await send(request); operations.set(request.requestId, result); if ("to" in request && result.transactionHash) transactions.set(result.transactionHash, evidence(request, result.status === "confirmed")); return result; };
  const wallet = {
    async accounts() { return { accounts: [selected] }; },
    async operationStatus(request: EvmEffectRequest) { return structuredClone(operations.get(request.requestId) ?? { accountId: "main", chainId: request.chainId, requestId: request.requestId, status: "not_found" }); },
    async transaction({ transactionHash }: { transactionHash: string }) { return structuredClone(transactions.get(transactionHash)); },
    sendTransaction: invoke, signTypedData: invoke,
  } as unknown as EvmWalletClient;
  const prepare: NonNullable<FundingOptions["prepare"]> = async (_wallet, raw) => {
    const quote: FundingQuote = { input: parseFundingInput(raw), account, recipient: owner, observedAtMs: now, amountAtoms: "10000000", estimatedFeeAtoms: maxFee, maxFeeAtoms: maxFee, minimumReceiveAtoms: String(10000000n - BigInt(maxFee)), protocolFeeAtoms: "0", forwardingFeeAtoms: maxFee, activationFeeAtoms: "0", sourceDex: "", accountMode: "disabled", allowanceAtoms: approval ? "0" : "10000000", sourceGas: { estimatedFeeWei: null, maximumFeeWei: null, reason: null }, warnings: [] };
    return quote;
  };
  const transport: FundingTransport = { async rpc(_url, method) { if (method === "eth_blockNumber") return "0x100"; throw Error(method); }, async info() { return []; }, async circle() { return { messages: [] }; }, async exchange(body) { posts.push(structuredClone(body)); events.push("post"); return exchange(body); } };
  const run = (options: FundingOptions = {}, raw: FundingInput = input, origin: typeof caller | null = caller) => runFunding(wallet, store, id, raw, origin, origin !== null, { prepare, transport, now: () => now, waitForProgress: false, observe: async () => observations, ...options });
  return { run, input, rows, operations, sends, posts, events, store, wallet, operation, evidence, transactions, hash, setSend: (fn: typeof send) => { send = fn; }, setExchange: (fn: typeof exchange) => { exchange = fn; }, setAccount: (value: EvmAccount) => { selected = value; }, setFee: (value: string) => { maxFee = value; }, setObservation: (value: FundingObservation) => { observations = value; }, advance: () => { now += 1000; } };
}
test("exact USDC approval precedes burn; confirmed burn alone stays pending", async () => {
  const f = fixture("deposit", true), result = await f.run();
  expect(result.state).toBe("pending"); expect(result.phase).toBe("waiting_attestation"); expect(f.sends).toHaveLength(2);
  expect(f.events.indexOf("wallet_0_requested")).toBeLessThan(f.events.indexOf("send"));
  expect(f.events.indexOf("wallet_0_confirmed")).toBeLessThan(f.events.indexOf("wallet_1_requested"));
  await f.run(); expect(f.sends).toHaveLength(2); expect(f.rows.size).toBe(1);
});
test("lost Wallet reply retries only its exact original request and never creates a new burn", async () => {
  const f = fixture(); f.setSend(async () => { throw Error("Lost reply"); });
  await f.run(); await f.run(); expect(f.sends).toHaveLength(2); expect(f.sends[1]).toEqual(f.sends[0]); expect(f.rows.size).toBe(1);
  const request = f.sends[0] as EvmSendTransactionRequest;
  f.operations.set(request.requestId, f.operation(request)); f.transactions.set(f.hash(request), f.evidence(request));
  expect((await f.run()).phase).toBe("waiting_attestation"); expect(f.sends).toHaveLength(2);
});
test("read-only status never opens a prepared Wallet review", async () => {
  const f = fixture(); f.setSend(async request => f.operation(request, "prepared"));
  expect((await f.run()).state).toBe("review"); expect((await f.run({ execute: false })).state).toBe("review"); expect(f.sends).toHaveLength(1);
});
test("a prepared burn whose fee cap is now too low is preserved without another dispatch", async () => {
  const f = fixture(); f.setSend(async request => f.operation(request, "prepared"));
  await f.run(); f.setFee("300000"); const result = await f.run();
  expect(result.phase).toBe("fee_changed"); expect(result.message).toContain("Decline that original request"); expect(f.sends).toHaveLength(1);
});
test("changed caller, amount or custody identity cannot reuse a saved funding ID", async () => {
  const f = fixture(); await f.run();
  await expect(f.run({}, { ...f.input, amount: "11" })).rejects.toThrow("original inputs");
  await expect(f.run({}, f.input, null)).rejects.toThrow("original inputs");
  f.setAccount({ ...account, keyFingerprint: `0x${"55".repeat(32)}` });
  await expect(f.run()).rejects.toThrow("identity changed"); expect(f.sends).toHaveLength(1);
});
test("receipt for a different replacement cannot complete a burn", async () => {
  const f = fixture(); await f.run(); const request = f.sends[0] as EvmSendTransactionRequest;
  f.transactions.set(f.hash(request), { ...f.evidence(request), transaction: { ...f.evidence(request).transaction!, to: owner, data: "0x" } });
  expect((await f.run()).state).toBe("stopped"); expect(f.sends).toHaveLength(1);
});
test("corrupted saved receipt linkage is rejected before any funding effect", async () => {
  const f = fixture(); await f.run(); const row = f.rows.get(id)!, state = JSON.parse(row.state_json);
  state.steps[0].evidence.transactionHash = `0x${"aa".repeat(32)}`; f.rows.set(id, { ...row, state_json: stable(state) });
  await expect(f.run()).rejects.toThrow("not linked"); expect(f.sends).toHaveLength(1);
});
test("lost exchange reply retains exact signature and nonce across reload and retry", async () => {
  const f = fixture("withdraw"); f.setExchange(async () => { throw Error("Lost HTTP reply"); });
  f.setObservation({ ...pending, phase: "waiting_source", sourceTransactionHash: null });
  await f.run(); const first = structuredClone(f.posts[0]); f.advance();
  await f.run(); expect(f.posts[1]).toEqual(first); expect(f.sends).toHaveLength(1);
  const state = fundingState(f.rows.get(id)!); expect(state.withdrawal!.nonce).toBe(1800000000000); expect(state.envelope).toEqual(first);
  f.setObservation({ ...pending, sourceTransactionHash: `0x${"55".repeat(32)}` });
  await f.run(); expect(f.posts).toHaveLength(2);
});
test("a definitive first exchange rejection stops while a used-nonce retry remains reconcilable", async () => {
  const f = fixture("withdraw"); f.setExchange(async () => ({ status: "err", response: "Insufficient withdrawable balance" }));
  expect((await f.run()).state).toBe("stopped"); expect((await f.run()).state).toBe("stopped"); expect(f.posts).toHaveLength(1);
  const retry = fixture("withdraw"); retry.setObservation({ ...pending, phase: "waiting_source", sourceTransactionHash: null });
  retry.setExchange(async () => { throw Error("Lost"); }); await retry.run();
  retry.setExchange(async () => ({ status: "err", response: "Nonce already used" }));
  expect((await retry.run()).state).toBe("pending"); expect(retry.posts).toHaveLength(2);
});
test("automatic continuation follows the confirmed original approval into one burn", async () => {
  const f = fixture("deposit", true); let first = true;
  f.setSend(async request => { const result = f.operation(request, first ? "submitted" : "confirmed"); first = false; return result; });
  const result = await f.run({ waitForProgress: true, wait: async () => {
    const request = f.sends[0] as EvmSendTransactionRequest;
    f.operations.set(request.requestId, f.operation(request)); f.transactions.set(f.hash(request), f.evidence(request)); f.advance();
  } });
  expect(result.phase).toBe("waiting_attestation"); expect(f.sends).toHaveLength(2);
});
test("quotes read deployed activation/forwarding fees and require a choice for undefined default mode", async () => {
  let mode = "default";
  const readWallet = { async accounts() { return { accounts: [account] }; }, async callContract() { return { result: encodeAbiParameters([{ type: "uint256" }], [0n]) }; } } as unknown as EvmWalletClient;
  const transport: FundingTransport = {
    async rpc(_url, method, params) {
      expect(method).toBe("eth_call");
      const call = params[0] as { to: string; data: `0x${string}` };
      if (call.to === CCTP.coreUserExists) return encodeAbiParameters([{ type: "bool" }], [false]);
      const decoded = decodeFunctionData({ abi: CORE_DEPOSIT_ABI, data: call.data });
      const values = { enabledDestinationDexes: true, isDexForwardingDisabled: false, newCoreAccountFee: 100_000_000n, calculateCrossChainWithdrawalFee: 1_200_000n, cctpMaxFee: 0n };
      const value = values[decoded.functionName];
      return typeof value === "boolean" ? encodeAbiParameters([{ type: "bool" }], [value]) : encodeAbiParameters([{ type: "uint256" }], [value]);
    },
    async info() { return mode; },
    async circle() { return [{ finalityThreshold: 1000, minimumFee: 0, forwardFee: { low: 200000, med: 200000, high: 200000 } }]; },
    async exchange() { throw Error("Quote must not submit"); },
  };
  const deposit = await quoteFunding(readWallet, { environment: "mainnet", direction: "deposit", chainId: "1", amount: "10" }, { transport });
  expect(deposit.activationFeeAtoms).toBe("1000000"); expect(deposit.minimumReceiveAtoms).toBe("8800000"); expect(deposit.allowanceAtoms).toBe("0");
  const withdraw = { environment: "mainnet", direction: "withdraw", chainId: "1", amount: "10" } as const;
  await expect(quoteFunding(readWallet, withdraw, { transport })).rejects.toThrow("sourceBalance");
  expect((await quoteFunding(readWallet, { ...withdraw, sourceBalance: "perps" }, { transport })).sourceDex).toBe("");
  mode = "unifiedAccount";
  expect((await quoteFunding(readWallet, withdraw, { transport })).sourceDex).toBe("spot");
  await expect(quoteFunding(readWallet, { ...withdraw, sourceBalance: "perps" }, { transport })).rejects.toThrow("conflicts");
});
test("Circle's observed message-not-found404 is pending, other404routes are errors", async () => {
  const transport = createFundingTransport((async () => new Response(JSON.stringify({ error: "Message not found for provided parameters" }), { status: 404 })) as unknown as typeof fetch);
  expect(await transport.circle(`/v2/messages/0?transactionHash=0x${"11".repeat(32)}`)).toEqual({ messages: [] });
  await expect(transport.circle("/v2/burn/USDC/fees/0/19")).rejects.toThrow("404");
});
