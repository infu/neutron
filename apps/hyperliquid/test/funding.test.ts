import { expect, test } from "bun:test";
import { concatHex, decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, numberToHex, parseAbi, stringToHex, type Hex } from "viem";
import type { EvmAccount, EvmEffectRequest, EvmOperationResult, EvmReceipt, EvmSendTransactionRequest, EvmTransactionResult, EvmWalletClient } from "neutron-tools/evm_wallet";
import { createFundingTransport, fundingResult, fundingState, observeFunding, quoteFunding, recoverFunding, runFunding, type FundingInput, type FundingObservation, type FundingOptions, type FundingQuote, type FundingTransport } from "../src/funding.ts";
import { CCTP, CCTP_RECOVERY_ABI, CORE_DEPOSIT_ABI, FUNDING_CHAINS, TOKEN_MESSENGER_ABI, forwardHook, parseFundingInput } from "../src/funding_protocol.ts";
import { decodeCctpMessage, evidenceAddressWord, withdrawalHook } from "../src/funding_evidence.ts";
import { stable, type RecordRow, type Store } from "../src/store.ts";

const id = "ab".repeat(16), owner = "0x1111111111111111111111111111111111111111", caller = { appId: "agent", installationUid: "17" };
const account: EvmAccount = { accountId: "main", address: owner, publicKey: `0x02${"66".repeat(32)}`, keyFingerprint: `0x${"77".repeat(32)}`, namespaceVersion: "1" };
const receipt: EvmReceipt = { blockNumber: "123", blockHash: `0x${"99".repeat(32)}`, status: "success", gasUsed: "50000", effectiveGasPriceWei: "10000000", finality: "included", observedAtNs: "1800000000000000000", logs: [] };
const pending: FundingObservation = { phase: "waiting_attestation", sourceTransactionHash: `0x${"44".repeat(32)}`, destinationTransactionHash: null, receivedAtoms: null, message: "Waiting for CCTP", evidence: null };
function fixture(direction: "deposit" | "withdraw" = "deposit", approval = false) {
  const input: FundingInput = { environment: "mainnet", direction, chainId: "1", amount: "10" }, rows = new Map<string, RecordRow>(), operations = new Map<string, EvmOperationResult>(), transactions = new Map<string, EvmTransactionResult>();
  const sends: EvmEffectRequest[] = [], posts: unknown[] = [], events: string[] = [];
  let selected = account, maxFee = "200000", estimatedFee = "200000", observations = pending, now = 1800000000000;
  const store: Store = {
    async get(id) { return structuredClone(rows.get(id) ?? null); },
    async begin(value) { const prior = rows.get(value.id); if (prior) { if (prior.input_json !== value.input_json) throw Error("Intent conflict"); return structuredClone(prior); } const row = { ...value, revision: "0", created_at: String(now), updated_at: String(now) }; rows.set(value.id, row); events.push("begin"); return structuredClone(row); },
    async update(prior, state, phase) { if (rows.get(prior.id)?.revision !== prior.revision) throw Error("Revision conflict"); const row = { ...prior, state_json: stable(state), phase, revision: String(BigInt(prior.revision) + 1n) }; rows.set(prior.id, row); events.push(phase); return structuredClone(row); },
    async page() { return { rows: [...rows.values()], nextCursor: null }; },
  };
  const hash = (request: EvmEffectRequest) => keccak256(stringToHex(request.requestId));
  const operation = (request: EvmEffectRequest, status: EvmOperationResult["status"] = "confirmed"): EvmOperationResult => {
    const signature = "typedDataJson" in request && status === "signed" ? `0x${"11".repeat(32)}${"22".repeat(32)}1b` : null;
    return { ...{ accountId: request.accountId, chainId: request.chainId, requestId: request.requestId }, operationId: "1", kind: "typedDataJson" in request ? "typed_data" : "transaction", status, address: owner, transactionHash: "typedDataJson" in request || ["preparing", "prepared", "failed", "rejected"].includes(status) ? null : hash(request), signature, message: null, reviewRevision: "1", receipt: status === "confirmed" ? receipt : null };
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
    const quote: FundingQuote = { input: parseFundingInput(raw), account, recipient: owner, observedAtMs: now, amountAtoms: "10000000", estimatedFeeAtoms: estimatedFee, maxFeeAtoms: maxFee, minimumReceiveAtoms: String(10000000n - BigInt(maxFee)), protocolFeeAtoms: "0", forwardingFeeAtoms: estimatedFee, activationFeeAtoms: "0", sourceDex: "", accountMode: "disabled", allowanceAtoms: approval ? "0" : "10000000", sourceGas: { estimatedFeeWei: null, maximumFeeWei: null, reason: null }, warnings: [] };
    return quote;
  };
  const transport: FundingTransport = { async rpc(_url, method) { if (method === "eth_blockNumber") return "0x100"; throw Error(method); }, async info() { return []; }, async circle() { return { messages: [] }; }, async exchange(body) { posts.push(structuredClone(body)); events.push("post"); return exchange(body); } };
  const run = (options: FundingOptions = {}, raw: FundingInput = input, origin: typeof caller | null = caller) => runFunding(wallet, store, id, raw, origin, origin !== null, { prepare, transport, now: () => now, waitForProgress: false, observe: async () => observations, ...options });
  return { run, input, rows, operations, sends, posts, events, store, wallet, prepare, operation, evidence, transactions, hash, setSend: (fn: typeof send) => { send = fn; }, setExchange: (fn: typeof exchange) => { exchange = fn; }, setAccount: (value: EvmAccount) => { selected = value; }, setFee: (value: string, estimate = value) => { maxFee = value; estimatedFee = estimate; }, setObservation: (value: FundingObservation) => { observations = value; }, advance: () => { now += 1000; } };
}

/** A protocol actor separate from the app: advancing its stage does not invoke
 * the wallet, the app, or an exchange effect. Reopening merely reads receipts. */
function independentForwarder(f: ReturnType<typeof fixture>) {
  const deposit = f.input.direction === "deposit", nonce = `0x${"ee".repeat(32)}` as Hex;
  let destinationHash = `0x${"dd".repeat(32)}` as Hex, expiration = 12345678, block = 512, used = false, manual = false, cash = false, wrongRecipient = false, sourceVisible = true;
  const reattestations: string[] = [];
  let stage: "attesting" | "forwarding" | "received" = "attesting";
  const state = () => fundingState(f.rows.get(id)!);
  const sourceHash = () => deposit ? f.hash(state().steps.at(-1)!.request) : `0x${"cc".repeat(32)}`;
  const n = (value: number | bigint, size: number) => numberToHex(value, { size });
  const w = evidenceAddressWord, chain = FUNDING_CHAINS[f.input.chainId], zero = `0x${"0".repeat(40)}`;
  const wire = () => concatHex([
    n(1, 4), n(deposit ? chain.domain : 19, 4), n(deposit ? 19 : chain.domain, 4), nonce,
    w(CCTP.tokenMessenger), w(CCTP.tokenMessenger), w(deposit ? CCTP.forwarder : zero), n(deposit ? 1000 : 2000, 4), n(deposit ? 1000 : 2000, 4),
    n(1, 4), w(deposit ? chain.usdc : CCTP.hyperEvmUsdc), w(wrongRecipient ? CCTP.coreDepositWallet : deposit ? CCTP.forwarder : owner), n(10000000n, 32), w(deposit ? owner : CCTP.coreDepositWallet),
    n(BigInt(state().quote.maxFeeAtoms), 32), n(200000n, 32), n(expiration, 32), deposit ? forwardHook(owner) : withdrawalHook(owner, state().withdrawal!.nonce),
  ]);
  const log = (signature: string, indexed: Record<string, unknown>, types: string[], values: unknown[], address: string, hash = destinationHash as string) => ({ address, topics: encodeEventTopics({ abi: parseAbi([signature]), args: indexed } as never), data: encodeAbiParameters(types.map(type => ({ type })), values as never), transactionHash: hash, blockNumber: "0x123", logIndex: "0x1", removed: false });
  const burn = () => log("event CrossChainWithdraw(address indexed from, bytes32 indexed to, uint256 value, uint32 destinationDomain, uint64 indexed coreNonce)", { from: owner, to: w(owner), coreNonce: BigInt(state().withdrawal!.nonce) }, ["uint256", "uint32"], [10000000n, chain.domain], CCTP.coreDepositWallet, sourceHash());
  const destinationLogs = () => {
    const decoded = decodeCctpMessage(wire());
    const received = log("event MessageReceived(address indexed caller, uint32 sourceDomain, bytes32 indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody)", { caller: CCTP.forwarder, nonce, finalityThresholdExecuted: deposit ? 1000 : 2000 }, ["uint32", "bytes32", "bytes"], [decoded.sourceDomain, decoded.sender, decoded.messageBody], CCTP.messageTransmitter);
    const minted = log("event Transfer(address indexed from, address indexed to, uint256 value)", { from: zero, to: deposit ? CCTP.forwarder : owner }, ["uint256"], [9800000n], deposit ? CCTP.hyperEvmUsdc : chain.usdc);
    return deposit ? [received, minted,
      log("event Transfer(address indexed from, address indexed to, uint256 value)", { from: CCTP.forwarder, to: CCTP.coreDepositWallet }, ["uint256"], [9800000n], CCTP.hyperEvmUsdc),
      cash ? log("event Transfer(address indexed from, address indexed to, uint256 value)", { from: owner, to: "0x2000000000000000000000000000000000000000" }, ["uint256"], [9800000n], CCTP.coreDepositWallet) : log("event SendAsset(address indexed coreRecipient, uint64 coreAmount, uint32 destinationDex)", { coreRecipient: owner }, ["uint64", "uint32"], [980000000n, 0], CCTP.coreDepositWallet),
    ] : [received, minted];
  };
  const transport: FundingTransport = {
    async rpc(url, method, params) {
      if (method === "eth_blockNumber") return `0x${block.toString(16)}`;
      if (method === "eth_call") return encodeAbiParameters([{ type: "uint256" }], [used || stage === "received" ? 1n : 0n]);
      if (method === "eth_getBlockByNumber") return { timestamp: "0x6b49d200" };
      if (method === "eth_getLogs") return !deposit && url === CCTP.hyperEvmRpc ? sourceVisible ? [burn()] : [] : stage === "received" ? destinationLogs() : [];
      if (method === "eth_getTransactionReceipt") {
        if (!deposit && params[0] === sourceHash()) return sourceVisible ? { status: "0x1", transactionHash: sourceHash(), blockNumber: "0x123", logs: [burn()] } : null;
        return stage === "received" ? { status: "0x1", transactionHash: destinationHash, blockNumber: "0x123", logs: destinationLogs() } : null;
      }
      throw Error(`Unexpected forwarding read ${method}`);
    },
    async circle(path) {
      expect(path).toBe(`/v2/messages/${deposit ? chain.domain : 19}?transactionHash=${sourceHash()}`);
      return { sourceTxHash: sourceHash(), messages: stage === "attesting" ? [] : [{ message: wire(), cctpVersion: 2, status: "complete", attestation: `0x${"11".repeat(65)}`, forwardState: stage === "received" && !manual ? "COMPLETE" : "FAILED", forwardTxHash: stage === "received" && !manual ? destinationHash : null }] };
    },
    async reattest(value) { reattestations.push(value); return { nonce: value, message: "Re-attestation successfully requested for nonce." }; },
    async info() { return [{ hash: `0x${"ff".repeat(32)}`, time: Number(BigInt("0x6b49d200") * 1000n), delta: { type: "send", user: CCTP.coreDepositWallet, destination: owner, sourceDex: "spot", destinationDex: "", token: "USDC", amount: "9.8", nonce: "123" } }]; },
    async exchange() { throw Error("Observing forwarding must never submit a new withdrawal"); },
  };
  return { transport, advance: (next: typeof stage) => { stage = next; }, get destinationHash() { return destinationHash; }, sourceHash, reattestations, setSourceVisible: (value: boolean) => { sourceVisible = value; }, setBlock: (value: number) => { block = value; }, setExpiration: (value: number) => { expiration = value; }, setUsed: () => { used = true; }, setCash: () => { cash = true; }, setWrongRecipient: () => { wrongRecipient = true; }, completeManually: (hash: string) => { destinationHash = hash as Hex; manual = true; stage = "received"; } };
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
  await f.run(); f.setFee("300000"); await f.run(); expect(f.sends).toHaveLength(2); expect(f.sends[1]).toEqual(f.sends[0]); expect(f.rows.size).toBe(1);
  const request = f.sends[0] as EvmSendTransactionRequest;
  f.operations.set(request.requestId, f.operation(request)); f.transactions.set(f.hash(request), f.evidence(request));
  expect((await f.run()).phase).toBe("waiting_attestation"); expect(f.sends).toHaveLength(2);
});
for (const approval of [false, true]) test(`interrupted ${approval ? "approval" : "burn"} preparation resumes its exact Wallet request`, async () => {
  const f = fixture("deposit", approval);
  f.setSend(async request => { f.operations.set(request.requestId, f.operation(request, "preparing")); throw Error("Tile closed during Wallet simulation"); });
  await f.run(); const original = structuredClone(f.sends[0]!);
  f.rows.set(id, structuredClone(f.rows.get(id)!));
  const observed = await f.run({ execute: false });
  expect(observed.steps[0]!.status).toBe("preparing"); expect(f.sends).toHaveLength(1);
  f.setFee("500000"); f.setSend(async request => f.operation(request));
  const result = await f.run();
  expect(f.sends[1]).toEqual(original); expect(result.phase).toBe("waiting_attestation");
  expect(f.rows.size).toBe(1); expect(f.sends).toHaveLength(approval ? 3 : 2);
  // Only a never-dispatched burn can adopt current fees after its approval.
  expect(result.quote.maxFeeAtoms).toBe(approval ? "500000" : "200000");
  await f.run(); expect(f.sends).toHaveLength(approval ? 3 : 2);
});
test("closing after the burn was accepted restores its Wallet request and observes independent forwarding without another approval or burn", async () => {
  const f = fixture("deposit", true), controller = new AbortController(), forwarder = independentForwarder(f);
  f.setSend(async request => {
    if (f.sends.length === 2) controller.abort(new DOMException("Browser closed after burn submission", "AbortError"));
    return f.operation(request);
  });
  await expect(f.run({ signal: controller.signal, transport: forwarder.transport, observe: observeFunding })).rejects.toThrow("Browser closed");
  expect(f.sends).toHaveLength(2);
  const originalRequests = structuredClone(f.sends), persisted = structuredClone(f.rows.get(id)!);
  expect(fundingState(persisted).steps[1]!.dispatched).toBe(true);
  expect(fundingState(persisted).steps[1]!.operation).toBeNull();
  // Only durable rows and Wallet operations survive. No resident promise needs
  // to survive, and subsequent observation must not invoke an effect.
  f.rows.set(id, persisted); f.setSend(async () => { throw Error("Must not request another burn"); });
  const check = () => f.run({ execute: false, transport: forwarder.transport, observe: observeFunding });
  expect((await check()).phase).toBe("waiting_attestation");
  forwarder.advance("forwarding"); expect((await check()).phase).toBe("waiting_forwarding");
  forwarder.advance("received"); const result = await check();
  expect(result.phase).toBe("forwarded_to_core"); expect(result.sourceTransactionHash).toBe(forwarder.sourceHash());
  expect(result.destinationTransactionHash).toBe(forwarder.destinationHash); expect(result.receivedUsdc).toBe("9.8");
  expect(result.observation?.evidence).toMatchObject({ coreExecutionProven: false });
  expect(f.sends).toEqual(originalRequests); expect(f.posts).toHaveLength(0);
});
test("cancelling an attestation read does not cancel protocol forwarding or require the source transaction again", async () => {
  const f = fixture(), forwarder = independentForwarder(f), controller = new AbortController();
  const transport = { ...forwarder.transport, async circle() { controller.abort(new DOMException("Tile closed during attestation check", "AbortError")); throw controller.signal.reason; } };
  await expect(f.run({ signal: controller.signal, transport, observe: observeFunding })).rejects.toThrow("Tile closed");
  expect(fundingState(f.rows.get(id)!).steps[0]!.operation?.status).toBe("confirmed");
  const request = structuredClone(f.sends[0]!);
  forwarder.advance("received"); // The independent protocol actor finishes while the app is closed.
  const result = await f.run({ transport: forwarder.transport, observe: observeFunding });
  expect(result.phase).toBe("forwarded_to_core"); expect(result.receivedUsdc).toBe("9.8");
  expect(f.sends).toEqual([request]); expect(f.rows.size).toBe(1);
});
test("a reopened transfer that only approved USDC waits for explicit continuation before its first burn", async () => {
  const f = fixture("deposit", true); f.setSend(async request => f.operation(request, "submitted"));
  await f.run(); const approval = f.sends[0] as EvmSendTransactionRequest;
  expect(f.sends).toHaveLength(1); expect(fundingState(f.rows.get(id)!).steps[1]!.dispatched).toBe(false);
  f.rows.set(id, structuredClone(f.rows.get(id)!));
  f.operations.set(approval.requestId, f.operation(approval)); f.transactions.set(f.hash(approval), f.evidence(approval));
  const status = await f.run({ execute: false });
  expect(status.sourceTransactionHash).toBeNull(); expect(f.sends).toHaveLength(1);
  f.setSend(async request => f.operation(request));
  await f.run(); expect(f.sends).toHaveLength(2); expect(f.sends[0]).toEqual(approval);
});
test("browser closure after withdrawal submission reconciles its original burn and destination mint without posting again", async () => {
  const f = fixture("withdraw"), controller = new AbortController(), forwarder = independentForwarder(f);
  f.setExchange(async () => { controller.abort(new DOMException("Browser closed after withdrawal acceptance", "AbortError")); throw controller.signal.reason; });
  await expect(f.run({ signal: controller.signal })).rejects.toThrow("Browser closed");
  const saved = fundingState(f.rows.get(id)!), envelope = structuredClone(saved.envelope);
  expect(saved.exchangeDispatched).toBe(true); expect(saved.exchangeAccepted).toBe(false);
  expect(f.posts).toEqual([envelope]); expect(f.sends).toHaveLength(1);
  f.rows.set(id, structuredClone(f.rows.get(id)!)); forwarder.advance("received");
  const result = await f.run({ transport: forwarder.transport, observe: observeFunding });
  expect(result.state).toBe("complete"); expect(result.receivedUsdc).toBe("9.8");
  expect(result.sourceTransactionHash).toBeNull(); expect(result.destinationTransactionHash).toBe(forwarder.destinationHash);
  expect(f.posts).toEqual([envelope]); expect(f.sends).toHaveLength(1);
});
test("a withdrawal with a lost exchange reply completes from its destination receipt when source system receipts are hidden", async () => {
  const f = fixture("withdraw"), forwarder = independentForwarder(f);
  f.setExchange(async () => { throw Error("Exchange reply lost after acceptance"); });
  await f.run();
  const signed = structuredClone(fundingState(f.rows.get(id)!).envelope);
  f.rows.set(id, structuredClone(f.rows.get(id)!));
  forwarder.advance("received"); forwarder.setSourceVisible(false);
  const reads: string[] = [];
  const transport: FundingTransport = { ...forwarder.transport, async rpc(url, method, params, signal) {
    expect(url).toBe(FUNDING_CHAINS["1"].rpc);
    reads.push(method);
    return forwarder.transport.rpc(url, method, params, signal);
  } };
  const result = await f.run({ transport, observe: observeFunding });
  expect(result.state).toBe("complete"); expect(result.receivedUsdc).toBe("9.8"); expect(result.sourceTransactionHash).toBeNull();
  expect(result.observation?.evidence).toMatchObject({ sourceTransactionHashKnown: false, sourceReceiptRequired: false, destinationDomain: 0, mint: { coreNonce: "1800000000000", proofKind: "cctp_withdrawal_destination_receipt" } });
  expect(result.message).not.toContain("reply lost");
  expect(f.posts).toEqual([signed]); expect(f.sends).toHaveLength(1);
  reads.length = 0;
  expect((await f.run({ transport, observe: observeFunding })).state).toBe("complete");
  expect(reads).toEqual(["eth_getTransactionReceipt"]);
  expect(f.posts).toEqual([signed]); expect(f.sends).toHaveLength(1);
  const recovered = await recoverFunding(f.wallet, f.store, id, caller, true, { method: "wallet", transport });
  expect(recovered.state).toBe("complete"); expect(recovered.recovery?.methods).toEqual([]);
  expect(f.posts).toEqual([signed]); expect(f.sends).toHaveLength(1);
});
test("historical log failure uses indexed hashes only as hints and still requires the exact withdrawal receipt", async () => {
  const f = fixture("withdraw"), forwarder = independentForwarder(f); await f.run(); forwarder.advance("received");
  let pagesRead = 0;
  const transport: FundingTransport = { ...forwarder.transport,
    async rpc(url, method, params, signal) {
      expect(url).toBe(FUNDING_CHAINS["1"].rpc);
      if (method === "eth_getLogs") throw Error("Historical logs require archive access");
      return forwarder.transport.rpc(url, method, params, signal);
    },
    async *withdrawalMints(input) {
      expect(input).toEqual({ chainId: "1", recipient: owner, amountAtoms: "10000000", fromBlock: "0x100" });
      pagesRead++; yield [`0x${"22".repeat(32)}`]; // RPC fixture returns a different receipt: it cannot be accepted for this hint.
      pagesRead++; yield [forwarder.destinationHash];
      throw Error("No more index pages should be needed after exact receipt proof");
    },
  };
  const result = await f.run({ execute: false, transport, observe: observeFunding });
  expect(result.state).toBe("complete"); expect(result.destinationTransactionHash).toBe(forwarder.destinationHash); expect(pagesRead).toBe(2);
  expect(f.sends).toHaveLength(1); expect(f.posts).toHaveLength(1);
});
test("failed destination discovery remains unavailable rather than asserting a missing burn or resending", async () => {
  const f = fixture("withdraw"), forwarder = independentForwarder(f);
  f.setExchange(async () => { throw Error("Lost exchange reply"); }); await f.run();
  const transport: FundingTransport = { ...forwarder.transport,
    async rpc(url, method, params, signal) {
      if (method === "eth_getLogs") throw Error("Funding RPC rate limited");
      return forwarder.transport.rpc(url, method, params, signal);
    },
    async *withdrawalMints() { yield []; },
  };
  const result = await f.run({ transport, observe: observeFunding });
  expect(result.phase).toBe("verification_unavailable"); expect(result.state).toBe("pending");
  expect(result.message).toContain("rate limited"); expect(result.message).toContain("no new withdrawal");
  expect(f.posts).toHaveLength(1); expect(f.sends).toHaveLength(1);
  forwarder.advance("received");
  const complete = await f.run({ transport: forwarder.transport, observe: observeFunding });
  expect(complete.state).toBe("complete"); expect(complete.message).not.toContain("rate limited");
  expect(f.posts).toHaveLength(1); expect(f.sends).toHaveLength(1);
});
test("destination history unavailability does not block a retained source burn awaiting Circle attestation", async () => {
  const f = fixture("withdraw"), forwarder = independentForwarder(f); await f.run();
  const first = await f.run({ execute: false, transport: forwarder.transport, observe: observeFunding });
  expect(first.phase).toBe("waiting_attestation");
  const transport: FundingTransport = { ...forwarder.transport,
    async rpc(url, method, params, signal) {
      if (url === FUNDING_CHAINS["1"].rpc && method === "eth_getLogs") throw Error("Destination log history unavailable");
      return forwarder.transport.rpc(url, method, params, signal);
    },
    async *withdrawalMints() { yield []; },
  };
  const result = await f.run({ execute: false, transport, observe: observeFunding });
  expect(result.phase).toBe("waiting_attestation"); expect(result.sourceTransactionHash).toBe(forwarder.sourceHash());
  expect(f.sends).toHaveLength(1); expect(f.posts).toHaveLength(1);
});
test("a completed withdrawal reports a changed fee without inventing a signed fee cap", async () => {
  const f = fixture("withdraw"), forwarder = independentForwarder(f); f.setFee("300000"); await f.run(); forwarder.advance("received");
  const result = await f.run({ transport: forwarder.transport, observe: observeFunding });
  expect(result.state).toBe("complete");
  expect(result.observation?.evidence).toMatchObject({ feeExecutedAtoms: "200000", quotedFeeAtoms: "300000", feeChangedSinceQuote: true });
});
test("legacy deposit quotes do not report an unobserved standard account mode", async () => {
  const f = fixture(); await f.run();
  const row = f.rows.get(id)!, state = JSON.parse(row.state_json); state.quote.accountMode = "standard";
  const historical = { ...row, state_json: stable(state) };
  expect(fundingResult(historical).quote.accountMode).toBeNull();
  expect(fundingResult(historical).quote.sourceDex).toBe(""); expect(historical.revision).toBe(row.revision);
  expect(f.sends).toHaveLength(1);
});
for (const direction of ["deposit", "withdraw"] as const) test(`${direction} manual recovery completes only the original destination mint without another source debit`, async () => {
  const f = fixture(direction), forwarder = independentForwarder(f);
  await f.run(); forwarder.advance("forwarding");
  const original = structuredClone(f.sends), sourcePosts = f.posts.length;
  f.setSend(async request => { forwarder.completeManually(f.hash(request)); return f.operation(request); });
  const result = await recoverFunding(f.wallet, f.store, id, caller, true, { method: "wallet", transport: forwarder.transport });
  expect(result.phase).toBe(direction === "deposit" ? "forwarded_to_core" : "complete");
  expect(result.receivedUsdc).toBe("9.8"); expect(result.recovery?.methods).toEqual([]);
  expect(f.sends).toHaveLength(original.length + 1); expect(f.posts).toHaveLength(sourcePosts);
  expect(f.sends.slice(0, original.length)).toEqual(original);
  const request = f.sends.at(-1) as EvmSendTransactionRequest;
  expect(request.chainId).toBe(direction === "deposit" ? "999" : "1");
  expect(request.to).toBe(direction === "deposit" ? CCTP.forwarder : CCTP.messageTransmitter); expect(request.valueWei).toBe("0");
  const call = decodeFunctionData({ abi: CCTP_RECOVERY_ABI, data: request.data as Hex });
  expect(call.functionName).toBe(direction === "deposit" ? "mintAndForward" : "receiveMessage");
  const saved = fundingState(f.rows.get(id)!).recoverySteps!;
  expect(saved).toHaveLength(1); expect(saved[0]!.request).toEqual(request);
  expect(call.args as readonly unknown[]).toEqual([saved[0]!.message, saved[0]!.attestation]);
  await recoverFunding(f.wallet, f.store, id, caller, true, { method: "wallet", transport: forwarder.transport });
  expect(f.sends).toHaveLength(original.length + 1); expect(f.posts).toHaveLength(sourcePosts);
});
test("an expired attestation is refreshed through Circle before destination recovery without another burn", async () => {
  const f = fixture(), forwarder = independentForwarder(f); await f.run(); forwarder.advance("forwarding"); forwarder.setExpiration(100);
  const options = { transport: forwarder.transport };
  const waiting = await recoverFunding(f.wallet, f.store, id, caller, true, { ...options, method: "wallet" });
  expect(waiting.recovery?.methods).toEqual(["circle"]); expect(f.sends).toHaveLength(1);
  await recoverFunding(f.wallet, f.store, id, caller, true, { ...options, method: "circle" });
  expect(forwarder.reattestations).toEqual([`0x${"ee".repeat(32)}`]); expect(f.sends).toHaveLength(1);
  forwarder.setExpiration(1000000);
  f.setSend(async request => { forwarder.completeManually(f.hash(request)); return f.operation(request); });
  expect((await recoverFunding(f.wallet, f.store, id, caller, true, { ...options, method: "wallet" })).receivedUsdc).toBe("9.8");
  expect(f.sends).toHaveLength(2);
});
test("an expired prepared Wallet recovery can be superseded by fresh attestation using tools without a manual decline", async () => {
  const f = fixture(), forwarder = independentForwarder(f); await f.run(); forwarder.advance("forwarding"); forwarder.setExpiration(1000);
  f.setSend(async request => f.operation(request, "prepared"));
  await recoverFunding(f.wallet, f.store, id, caller, true, { method: "wallet", transport: forwarder.transport });
  const original = structuredClone(f.sends.at(-1)!);
  forwarder.setBlock(2000);
  const expired = await f.run({ execute: false, transport: forwarder.transport, observe: observeFunding });
  expect(expired.recovery?.status).toBe("waiting_attestation"); expect(expired.recovery?.methods).toEqual(["circle"]);
  await recoverFunding(f.wallet, f.store, id, caller, true, { method: "circle", transport: forwarder.transport });
  expect(forwarder.reattestations).toHaveLength(1); forwarder.setExpiration(1000000);
  f.setSend(async request => { forwarder.completeManually(f.hash(request)); return f.operation(request); });
  const result = await recoverFunding(f.wallet, f.store, id, caller, true, { method: "wallet", transport: forwarder.transport });
  expect(result.receivedUsdc).toBe("9.8"); expect(f.sends).toHaveLength(3);
  const history = fundingState(f.rows.get(id)!).recoverySteps!;
  expect(history).toHaveLength(2); expect(history[0]!.request).toEqual(original);
  expect(history[1]!.request.requestId).not.toBe(original.requestId);
});
test("expired destination preparation resumes with fresh attestation for the original CCTP nonce", async () => {
  const f = fixture(), forwarder = independentForwarder(f); await f.run(); forwarder.advance("forwarding"); forwarder.setExpiration(1000);
  f.setSend(async request => { f.operations.set(request.requestId, f.operation(request, "preparing")); throw Error("Closed during destination simulation"); });
  const options = { method: "wallet" as const, transport: forwarder.transport };
  await recoverFunding(f.wallet, f.store, id, caller, true, options);
  const source = structuredClone(f.sends[0]!), original = structuredClone(f.sends.at(-1)!);
  forwarder.setBlock(2000);
  const observed = await f.run({ execute: false, transport: forwarder.transport, observe: observeFunding });
  expect(observed.recovery?.methods).toEqual(["circle"]); expect(f.sends).toHaveLength(2);
  await recoverFunding(f.wallet, f.store, id, caller, true, { ...options, method: "circle" });
  forwarder.setExpiration(1000000);
  f.setSend(async request => { forwarder.completeManually(f.hash(request)); return f.operation(request); });
  const result = await recoverFunding(f.wallet, f.store, id, caller, true, options);
  expect(result.receivedUsdc).toBe("9.8"); expect(f.sends).toHaveLength(3); expect(f.posts).toHaveLength(0);
  const history = fundingState(f.rows.get(id)!).recoverySteps!;
  expect(history).toHaveLength(2); expect(history[0]!.request).toEqual(original);
  expect(history[1]!.request.requestId).not.toBe(original.requestId);
  expect(decodeCctpMessage(history[1]!.message).nonce).toBe(decodeCctpMessage(history[0]!.message).nonce);
  expect(f.sends[0]).toEqual(source); expect(f.sends.filter(request => "to" in request && request.to === CCTP.tokenMessenger)).toHaveLength(1);
  await recoverFunding(f.wallet, f.store, id, caller, true, options); expect(f.sends).toHaveLength(3);
});
test("lost destination Wallet reply preserves exact recovery bytes across refreshed Circle observations", async () => {
  const f = fixture(), forwarder = independentForwarder(f); await f.run(); forwarder.advance("forwarding");
  f.setSend(async () => { throw Error("Destination reply lost"); });
  const options = { method: "wallet" as const, transport: forwarder.transport };
  await recoverFunding(f.wallet, f.store, id, caller, true, options);
  const original = structuredClone(f.sends.at(-1)!);
  forwarder.setExpiration(13000000); f.setSend(async request => f.operation(request, "prepared"));
  const result = await recoverFunding(f.wallet, f.store, id, caller, true, options);
  expect(result.recovery?.status).toBe("pending"); expect(f.sends.at(-1)).toEqual(original);
  expect(fundingState(f.rows.get(id)!).recoverySteps).toHaveLength(1); expect(f.sends).toHaveLength(3);
});
test("temporary withdrawal burn RPC absence cannot corrupt durable destination recovery history", async () => {
  const f = fixture("withdraw"), forwarder = independentForwarder(f); await f.run(); forwarder.advance("forwarding");
  f.setSend(async request => f.operation(request, "prepared"));
  await recoverFunding(f.wallet, f.store, id, caller, true, { method: "wallet", transport: forwarder.transport });
  const original = structuredClone(f.sends.at(-1)!);
  forwarder.setSourceVisible(false);
  const waiting = await f.run({ execute: false, transport: forwarder.transport, observe: observeFunding });
  expect(waiting.phase).toBe("waiting_source");
  const restored = fundingState(f.rows.get(id)!);
  expect(restored.withdrawalSourceTransactionHash).toBe(forwarder.sourceHash());
  expect(restored.recoverySteps![0]!.request).toEqual(original);
  forwarder.setSourceVisible(true); f.setSend(async request => { forwarder.completeManually(f.hash(request)); return f.operation(request); });
  const result = await recoverFunding(f.wallet, f.store, id, caller, true, { method: "wallet", transport: forwarder.transport });
  expect(result.state).toBe("complete"); expect(f.sends.at(-1)).toEqual(original);
  expect(fundingState(f.rows.get(id)!).recoverySteps).toHaveLength(1); expect(f.posts).toHaveLength(1);
});
test("consumed CCTP nonce blocks recovery even when Circle and destination receipt observations are incomplete", async () => {
  const f = fixture(), forwarder = independentForwarder(f); await f.run(); forwarder.advance("forwarding"); forwarder.setUsed();
  const result = await recoverFunding(f.wallet, f.store, id, caller, true, { method: "wallet", transport: forwarder.transport });
  expect(result.recovery?.status).toBe("unavailable"); expect(result.recovery?.methods).toEqual([]); expect(f.sends).toHaveLength(1);
});
test("a proven cash fallback offers only account transfer, never another mint", async () => {
  const f = fixture(), forwarder = independentForwarder(f); await f.run(); forwarder.setCash(); forwarder.advance("received");
  const result = await recoverFunding(f.wallet, f.store, id, caller, true, { method: "wallet", transport: forwarder.transport });
  expect(result.phase).toBe("forwarded_to_core_cash"); expect(result.recovery?.methods).toEqual(["perps"]); expect(f.sends).toHaveLength(1);
  expect(result.observation?.evidence).toMatchObject({ nonceUsed: true, coreCash: { recipient: owner, deliveredAtoms: "9800000" } });
});
test("a mismatching Circle recipient and a changed caller cannot authorize recovery", async () => {
  const f = fixture(), forwarder = independentForwarder(f); await f.run(); forwarder.advance("forwarding"); forwarder.setWrongRecipient();
  const result = await recoverFunding(f.wallet, f.store, id, caller, true, { method: "wallet", transport: forwarder.transport });
  expect(result.phase).toBe("waiting_attestation"); expect(f.sends).toHaveLength(1);
  await expect(recoverFunding(f.wallet, f.store, id, null, false, { method: "wallet", transport: forwarder.transport })).rejects.toThrow("original inputs and caller");
  expect(f.sends).toHaveLength(1);
});
test("a definitively rejected destination review can be reviewed again while retaining its original attempt", async () => {
  const f = fixture(), forwarder = independentForwarder(f); await f.run(); forwarder.advance("forwarding");
  f.setSend(async request => f.operation(request, "rejected"));
  const options = { method: "wallet" as const, transport: forwarder.transport };
  const declined = await recoverFunding(f.wallet, f.store, id, caller, true, options);
  expect(declined.recovery?.methods).toEqual(["wallet"]); expect(declined.recovery?.walletStatus).toBe("rejected");
  const original = structuredClone(f.sends.at(-1)!);
  f.setSend(async request => { forwarder.completeManually(f.hash(request)); return f.operation(request); });
  expect((await recoverFunding(f.wallet, f.store, id, caller, true, options)).receivedUsdc).toBe("9.8");
  const history = fundingState(f.rows.get(id)!).recoverySteps!;
  expect(history).toHaveLength(2); expect(history[0]!.request).toEqual(original);
  expect(history[1]!.request.requestId).not.toBe(original.requestId); expect(f.sends).toHaveLength(3);
});
test("concurrent recovery invocations cannot both dispatch new destination Wallet requests", async () => {
  const f = fixture(), forwarder = independentForwarder(f); await f.run(); forwarder.advance("forwarding");
  f.setSend(async request => f.operation(request, "prepared"));
  const results = await Promise.allSettled([0, 1].map(() => recoverFunding(f.wallet, f.store, id, caller, true, { method: "wallet", transport: forwarder.transport })));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  expect(f.sends).toHaveLength(2); expect(fundingState(f.rows.get(id)!).recoverySteps).toHaveLength(1);
});
test("Circle refresh is not presented as an unsupported gas-free forwarding retry for ready attestations", async () => {
  const f = fixture(), forwarder = independentForwarder(f); await f.run(); forwarder.advance("forwarding");
  await expect(recoverFunding(f.wallet, f.store, id, caller, true, { method: "circle", transport: forwarder.transport })).rejects.toThrow("does not expose a forwarding-retry API");
  expect(forwarder.reattestations).toHaveLength(0); expect(f.sends).toHaveLength(1);
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
test("changing fees after approval refreshes one undispatched burn for its first Wallet review", async () => {
  const f = fixture("deposit", true);
  f.setSend(async request => {
    if (f.sends.length === 1) f.setFee("300001", "280000");
    return f.operation(request);
  });
  const result = await f.run({ prepare: async (wallet, input, options) => {
    const quote = await f.prepare(wallet, input, options);
    return { ...quote, allowanceAtoms: f.sends.length ? "10000000" : "0" };
  } });
  expect(result.phase).toBe("waiting_attestation"); expect(f.sends).toHaveLength(2); expect(f.rows.size).toBe(1);
  const approval = f.sends[0] as EvmSendTransactionRequest, burn = f.sends[1] as EvmSendTransactionRequest;
  expect(approval.to).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
  expect(decodeFunctionData({ abi: TOKEN_MESSENGER_ABI, data: burn.data as `0x${string}` }).args[5]).toBe(300001n);
  expect(result.quote.maxFeeAtoms).toBe("300001"); expect(result.quote.minimumReceiveAtoms).toBe("9699999");
  expect(fundingState(f.rows.get(id)!).steps[0]!.request).toEqual(approval);
  await f.run(); expect(f.sends).toHaveLength(2);
});
test("even continuously rising pre-review quotes never require a second funding operation", async () => {
  const f = fixture(); let fee = 200000;
  const result = await f.run({ prepare: async (wallet, input, options) => {
    f.setFee(String(++fee)); return f.prepare(wallet, input, options);
  } });
  expect(result.phase).toBe("waiting_attestation"); expect(f.sends).toHaveLength(1);
  expect(result.quote.maxFeeAtoms).toBe("200002"); expect(f.rows.size).toBe(1);
});
test("an adequate original cap is retained when only the new high forwarding estimate rises", async () => {
  const f = fixture(); let quoted = false;
  const result = await f.run({ prepare: async (wallet, input, options) => {
    if (quoted) f.setFee("210000", "199999");
    quoted = true; return f.prepare(wallet, input, options);
  } });
  expect(result.phase).toBe("waiting_attestation"); expect(f.sends).toHaveLength(1);
  expect(result.quote.maxFeeAtoms).toBe("200000"); expect(result.quote.estimatedFeeAtoms).toBe("199999");
  expect(result.quote.minimumReceiveAtoms).toBe("9800000");
  const burn = f.sends[0] as EvmSendTransactionRequest;
  expect(decodeFunctionData({ abi: TOKEN_MESSENGER_ABI, data: burn.data as `0x${string}` }).args[5]).toBe(200000n);
});
test("published fee-changed records with no Wallet burn resume the same approval and transfer", async () => {
  const f = fixture("deposit", true);
  f.setSend(async request => f.operation(request, f.sends.length === 1 ? "submitted" : "confirmed"));
  await f.run();
  const approval = f.sends[0] as EvmSendTransactionRequest;
  const row = f.rows.get(id)!, saved = fundingState(row);
  saved.lastError = "Current forwarding or activation fees exceed this saved transfer's cap. The burn was not requested. Prepare a new transfer to review the updated fees.";
  f.rows.set(id, { ...row, phase: "fee_changed", state_json: stable(saved) });
  expect(fundingResult(f.rows.get(id)!).state).toBe("review");
  expect(fundingResult(f.rows.get(id)!).message).toContain("Continue this transfer");
  f.operations.set(approval.requestId, f.operation(approval)); f.transactions.set(f.hash(approval), f.evidence(approval)); f.setFee("400000");
  const result = await f.run();
  expect(result.phase).toBe("waiting_attestation"); expect(f.sends).toHaveLength(2); expect(f.rows.size).toBe(1);
  expect(fundingState(f.rows.get(id)!).steps[0]!.request).toEqual(approval);
  expect(result.quote.maxFeeAtoms).toBe("400000");
});
test("a moving high tier does not block a prepared burn whose current estimate fits its unchanged cap", async () => {
  const f = fixture(); f.setSend(async request => f.operation(request, "prepared"));
  await f.run(); const original = structuredClone(f.sends[0]);
  f.setFee("210000", "199999");
  const result = await f.run();
  expect(result.state).toBe("review"); expect(result.phase).toBe("wallet_0_prepared");
  expect(f.sends).toHaveLength(2); expect(f.sends[1]).toEqual(original);
  expect(result.quote.maxFeeAtoms).toBe("200000");
});
test("a concurrent first dispatch prevents an older quote refresh from changing or sending its request", async () => {
  const f = fixture(); let prepareCount = 0;
  let release!: () => void, paused!: () => void;
  const quoteReady = new Promise<void>(resolve => { paused = resolve; });
  const resumeQuote = new Promise<void>(resolve => { release = resolve; });
  const first = f.run({ prepare: async (wallet, input, options) => {
    const quote = await f.prepare(wallet, input, options);
    if (++prepareCount === 2) { paused(); await resumeQuote; }
    return quote;
  } });
  await quoteReady; f.setFee("300000");
  expect((await f.run()).phase).toBe("waiting_attestation");
  release(); await expect(first).rejects.toThrow("Revision conflict");
  expect(f.sends).toHaveLength(1);
  expect(fundingState(f.rows.get(id)!).quote.maxFeeAtoms).toBe("300000");
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
test("quotes resolve default account state consistently with saved withdrawal source and retain explicit fallback", async () => {
  let mode = "default", webData3: unknown = null;
  const modeQueries: string[] = [];
  const readWallet = { async accounts() { return { accounts: [account] }; }, async callContract() { return { result: encodeAbiParameters([{ type: "uint256" }], [0n]) }; } } as unknown as EvmWalletClient;
  const transport: FundingTransport = {
    async rpc(_url, method, params) {
      if (method === "eth_blockNumber") return "0x100";
      expect(method).toBe("eth_call");
      const call = params[0] as { to: string; data: `0x${string}` };
      if (call.to === CCTP.coreUserExists) return encodeAbiParameters([{ type: "bool" }], [false]);
      const decoded = decodeFunctionData({ abi: CORE_DEPOSIT_ABI, data: call.data });
      const values = { enabledDestinationDexes: true, isDexForwardingDisabled: false, newCoreAccountFee: 100_000_000n, calculateCrossChainWithdrawalFee: 1_200_000n, cctpMaxFee: 0n };
      const value = values[decoded.functionName];
      return typeof value === "boolean" ? encodeAbiParameters([{ type: "bool" }], [value]) : encodeAbiParameters([{ type: "uint256" }], [value]);
    },
    async info(body) { modeQueries.push(String(body.type)); if (body.type === "userAbstraction") return mode; if (body.type === "webData3") return webData3; throw Error("Unexpected account read"); },
    async circle() { return [{ finalityThreshold: 1000, minimumFee: 0, forwardFee: { low: 200000, med: 200000, high: 200000 } }]; },
    async exchange() { throw Error("Quote must not submit"); },
  };
  const deposit = await quoteFunding(readWallet, { environment: "mainnet", direction: "deposit", chainId: "1", amount: "10" }, { transport });
  expect(deposit.accountMode).toBeNull(); expect(deposit.accountModeResolution).toBeNull(); expect(modeQueries).toEqual([]);
  expect(deposit.activationFeeAtoms).toBe("1000000"); expect(deposit.minimumReceiveAtoms).toBe("8800000"); expect(deposit.allowanceAtoms).toBe("0");
  const withdraw = { environment: "mainnet", direction: "withdraw", chainId: "1", amount: "10" } as const;
  await expect(quoteFunding(readWallet, withdraw, { transport })).rejects.toThrow("sourceBalance");
  const fallback = await quoteFunding(readWallet, { ...withdraw, sourceBalance: "perps" }, { transport });
  expect(fallback.sourceDex).toBe(""); expect(fallback.accountModeResolution).toMatchObject({ balanceSource: "unknown", source: "webData3", basis: "unavailable" });
  expect(fallback.warnings.some(warning => warning.includes("could not be verified"))).toBe(true);
  const sharedFallback = await quoteFunding(readWallet, { ...withdraw, sourceBalance: "unified" }, { transport });
  expect(sharedFallback.sourceDex).toBe("spot"); expect(sharedFallback.warnings.some(warning => warning.includes("explicitly selected"))).toBe(true);
  for (const effective of [undefined, "unifiedAccount", "portfolioMargin"]) {
    webData3 = { userState: { user: owner, serverTime: 1800000000000, ...(effective ? { abstraction: effective } : {}) } };
    const quote = await quoteFunding(readWallet, withdraw, { transport });
    expect(quote.accountMode).toBe("default"); expect(quote.sourceDex).toBe(effective ? "spot" : "");
    expect(quote.accountModeResolution).toMatchObject({ balanceSource: effective ? "unified" : "perps", source: "webData3", effectiveAbstraction: effective ?? "default", serverTime: 1800000000000 });
    await expect(quoteFunding(readWallet, { ...withdraw, sourceBalance: effective ? "perps" : "unified" }, { transport })).rejects.toThrow("conflicts");
    const f = fixture("withdraw"); f.setSend(async request => f.operation(request, "prepared"));
    const result = await f.run({ prepare: quoteFunding, transport });
    expect(result.quote.sourceDex).toBe(quote.sourceDex);
    expect(fundingState(f.rows.get(id)!).withdrawal?.sourceDex).toBe(quote.sourceDex);
    const request = structuredClone(f.sends[0]!); expect(f.posts).toHaveLength(0);
    // The quote's resolution must never rewrite historical action bytes when
    // the account subsequently changes mode and the same operation is resumed.
    webData3 = { userState: { user: owner, serverTime: 1800000001000, abstraction: effective ? "disabled" : "unifiedAccount" } };
    const before = modeQueries.length;
    const retained = await f.run({ prepare: quoteFunding, transport, execute: false });
    expect(modeQueries).toHaveLength(before); expect(retained.quote).toEqual(result.quote);
    expect(fundingState(f.rows.get(id)!).withdrawal?.sourceDex).toBe(quote.sourceDex);
    expect(f.sends).toEqual([request]);
  }
  mode = "unifiedAccount";
  expect((await quoteFunding(readWallet, withdraw, { transport })).sourceDex).toBe("spot");
  await expect(quoteFunding(readWallet, { ...withdraw, sourceBalance: "perps" }, { transport })).rejects.toThrow("conflicts");
});
test("Circle's observed message-not-found404 is pending, other404routes are errors", async () => {
  const transport = createFundingTransport((async () => new Response(JSON.stringify({ error: "Message not found for provided parameters" }), { status: 404 })) as unknown as typeof fetch);
  expect(await transport.circle(`/v2/messages/0?transactionHash=0x${"11".repeat(32)}`)).toEqual({ messages: [] });
  await expect(transport.circle("/v2/burn/USDC/fees/0/19")).rejects.toThrow("404");
});
