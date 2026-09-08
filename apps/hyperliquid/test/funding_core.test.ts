import { expect, test } from "bun:test";
import { hashTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { EvmAccount, EvmOperationResult, EvmReceipt, EvmSendTransactionRequest, EvmSignTypedDataRequest, EvmTransactionResult, EvmWalletClient } from "neutron-tools/evm_wallet";
import { fundingRequestId, runFunding, type FundingIntent, type FundingObservation, type FundingOptions, type FundingQuote, type FundingState, type FundingTransport } from "../src/funding.ts";
import { availableCoreCash, coreCashAction, coreCashTypedData, observedCashTransfers, recoverCoreFunding, type CoreFundingRecovery } from "../src/funding_core.ts";
import { CCTP, depositCalldata, parseFundingInput } from "../src/funding_protocol.ts";
import { stable, type RecordRow, type Store } from "../src/store.ts";

const signer = privateKeyToAccount(`0x${"11".repeat(32)}`), owner = signer.address, id = "ab".repeat(16), caller = { appId: "agent", installationUid: "17" };
const now = 1800000000000, sourceHash = `0x${"aa".repeat(32)}`, destinationHash = `0x${"bb".repeat(32)}`;
const account: EvmAccount = { accountId: "main", address: owner, publicKey: `0x02${"66".repeat(32)}`, keyFingerprint: `0x${"77".repeat(32)}`, namespaceVersion: "1" };
function fixture() {
  const input = parseFundingInput({ environment: "mainnet", direction: "deposit", chainId: "1", amount: "10" });
  const quote: FundingQuote = { input, account, recipient: owner.toLowerCase(), observedAtMs: now, amountAtoms: "10000000", estimatedFeeAtoms: "200000", maxFeeAtoms: "200000", minimumReceiveAtoms: "9800000", protocolFeeAtoms: "0", forwardingFeeAtoms: "200000", activationFeeAtoms: "0", sourceDex: "", accountMode: "disabled", allowanceAtoms: "10000000", sourceGas: { estimatedFeeWei: null, maximumFeeWei: null, reason: null }, warnings: [] };
  const intent: FundingIntent = { kind: "funding", version: 1, operationId: id, input, caller, agentMode: true, account };
  const proof: FundingObservation = { phase: "forwarded_to_core_cash", sourceTransactionHash: sourceHash, destinationTransactionHash: destinationHash, receivedAtoms: null, message: "Original CCTP mint routed to cash", evidence: { coreCash: { phase: "forwarded_to_core_cash", recipient: owner.toLowerCase(), deliveredAtoms: "9800000", coreAmountAtoms: "980000000", transactionHash: destinationHash, nonce: `0x${"cc".repeat(32)}`, blockNumber: "100", finality: "included", coreExecutionProven: false } } };
  proof.recovery = { status: "ready", methods: ["perps"], chainId: "999", gasSymbol: "HYPE", message: "Move the original deposit's cash to perps", transactionHash: destinationHash, walletStatus: null };
  const state: FundingState = { version: 1, quote, withdrawal: null, fromBlock: null, destinationFromBlock: "0x1", envelope: null, exchangeDispatched: false, exchangeAccepted: false, exchangeRejected: false, exchangeReply: null, observation: proof, lastError: null, steps: [{ kind: "transaction", label: "Deposit USDC through CCTP", request: { accountId: "main", chainId: "1", requestId: fundingRequestId(id, 0), to: CCTP.tokenMessenger, valueWei: "0", data: depositCalldata(input, owner, quote.maxFeeAtoms) }, dispatched: true, operation: null, evidence: null }] };
  const burnRequest = state.steps[0]!.request as EvmSendTransactionRequest;
  const receipt: EvmReceipt = { blockNumber: "100", blockHash: `0x${"99".repeat(32)}`, status: "success", gasUsed: "50000", effectiveGasPriceWei: "10000000", finality: "included", observedAtNs: "1800000000000000000", logs: [] };
  const burnOperation: EvmOperationResult = { accountId: "main", chainId: "1", requestId: burnRequest.requestId, operationId: "1", kind: "transaction", status: "confirmed", address: owner, transactionHash: sourceHash, signature: null, message: null, reviewRevision: "1", receipt };
  const burnTransaction: EvmTransactionResult = { chainId: "1", transactionHash: sourceHash, walletRequestMatches: null, transaction: { from: owner, to: burnRequest.to, data: burnRequest.data, valueWei: "0", nonce: "0", blockNumber: "100", blockHash: receipt.blockHash }, receipt, observedAtNs: receipt.observedAtNs, source: "evm_rpc" };
  state.steps[0]!.operation = burnOperation; state.steps[0]!.evidence = burnTransaction;
  let row: RecordRow = { id, root_id: id, input_json: stable(intent), state_json: stable(state), summary: "deposit", phase: "forwarded_to_core_cash", revision: "0", created_at: String(now), updated_at: String(now) };
  const events: string[] = [], requests: EvmSignTypedDataRequest[] = [], posts: unknown[] = [], operations = new Map<string, EvmOperationResult>();
  operations.set(burnRequest.requestId, burnOperation);
  let selected = account, balance: unknown = { balances: [{ token: 0, coin: "USDC", total: "19.8", hold: "0" }] }, mode = "disabled", ledger: unknown = [], observation = proof, nonceCalls = 0;
  const store: Store = {
    async get() { return structuredClone(row); }, async begin() { throw Error("Recovery must not create a second funding operation"); },
    async update(previous, nextState, phase) { if (previous.revision !== row.revision) throw Error("Revision conflict"); row = { ...previous, state_json: stable(nextState), revision: String(Number(row.revision) + 1), phase }; events.push(phase); return structuredClone(row); },
    async page() { return { rows: [row], nextCursor: null }; },
  };
  const signed = async (request: EvmSignTypedDataRequest): Promise<EvmOperationResult> => ({ accountId: "main", chainId: "42161", requestId: request.requestId, operationId: "7", kind: "typed_data", status: "signed", address: owner, transactionHash: null, signature: await signer.signTypedData(JSON.parse(request.typedDataJson)), message: null, reviewRevision: "1", receipt: null });
  let sign = signed, exchange = async (_value: unknown): Promise<unknown> => ({ status: "ok", response: { type: "default" } });
  const wallet = {
    async accounts() { return { accounts: [selected] }; },
    async operationStatus(request: { requestId: string }) { events.push("wallet_status"); return operations.get(request.requestId) ?? { accountId: "main", chainId: "42161", requestId: request.requestId, status: "not_found" }; },
    async transaction({ transactionHash }: { transactionHash: string }) { if (transactionHash !== sourceHash) throw Error("Unexpected source receipt"); return structuredClone(burnTransaction); },
    async signTypedData(request: EvmSignTypedDataRequest) { requests.push(structuredClone(request)); events.push("sign"); return sign(request); },
    async sendTransaction() { throw Error("Cash recovery cannot burn or mint"); },
  } as unknown as EvmWalletClient;
  const transport: FundingTransport = {
    async rpc() { throw Error("Receipt observations are supplied separately"); }, async circle() { throw Error("Cash recovery cannot submit a second mint"); },
    async info(body) { return body.type === "spotClearinghouseState" ? balance : body.type === "userAbstraction" ? mode : body.type === "userNonFundingLedgerUpdates" ? ledger : Promise.reject(Error("Unexpected info")); },
    async exchange(body) { posts.push(structuredClone(body)); events.push("post"); return exchange(body); },
  };
  const options: FundingOptions = { transport, now: () => now, nextNonce: async () => { nonceCalls++; return now + nonceCalls - 1; }, observe: async () => structuredClone(observation) };
  return {
    run: (opts: FundingOptions = {}, origin: typeof caller | null = caller, root = true) => recoverCoreFunding(wallet, store, id, origin, root, { ...options, ...opts }),
    reconcile: () => runFunding(wallet, store, id, input, caller, true, { ...options, execute: false }),
    row: () => row, journal: () => JSON.parse(row.state_json).coreRecovery as CoreFundingRecovery | undefined, state: () => JSON.parse(row.state_json) as FundingState,
    mutate: (fn: (state: FundingState) => void) => { const next = JSON.parse(row.state_json); fn(next); row.state_json = stable(next); },
    setBalance: (value: unknown) => { balance = value; }, setMode: (value: string) => { mode = value; }, setLedger: (value: unknown) => { ledger = value; },
    setAccount: (value: EvmAccount) => { selected = value; }, setObservation: (value: FundingObservation) => { observation = value; },
    setSign: (value: typeof sign) => { sign = value; }, setExchange: (value: typeof exchange) => { exchange = value; },
    signed, operations, requests, posts, events, nonceCalls: () => nonceCalls, proof, options, store, wallet,
  };
}

test("cash recovery matches independent official Python SDK typed-signature vector", async () => {
  // Official SDK 2fdb18f9517675ea03695a0962bd19eece9c83f0 user_signed_payload + sign_inner.
  const data = coreCashTypedData(coreCashAction("9800000", now));
  expect(hashTypedData(data)).toBe("0x88573e78f4662f91445187c9dc4d80c50020461b7db9ace042f5e4bff4ec5e20");
  expect(await signer.signTypedData(data)).toBe("0xf81a77e6ca5e66f5135175758c8a4e361f44ae9779af22e40f7031f79f9c6a2d4daee662cfcaf5e27d3222f4802c52b91e3165079dea8bc8a1e5eb8ce02745a01c");
  expect(data.message).toEqual({ hyperliquidChain: "Mainnet", amount: "9.8", toPerp: true, nonce: now });
});
test("only proven original deposit cash is moved to the same owner's perps with master Wallet review", async () => {
  const f = fixture(), result = await f.run();
  expect(f.requests).toHaveLength(1); expect(f.posts).toHaveLength(1); expect(f.nonceCalls()).toBe(1);
  expect(f.journal()!.action).toEqual(coreCashAction("9800000", now));
  expect(f.requests[0]!.chainId).toBe("42161"); expect(f.requests[0]!.accountId).toBe("main");
  expect(f.journal()!.exchangeAccepted).toBe(true); expect(result.phase).toBe("core_cash_accepted"); expect(result.state).not.toBe("complete");
  expect(f.events.indexOf("core_cash_ready")).toBeLessThan(f.events.indexOf("sign"));
  expect(f.events.indexOf("core_cash_submitting")).toBeLessThan(f.events.indexOf("post"));
  await f.run(); expect(f.posts).toHaveLength(1); expect(f.requests).toHaveLength(1); expect(f.nonceCalls()).toBe(1);
});
test("lost exchange reply resumes the identical envelope and nonce, even if its USDC has left cash", async () => {
  const f = fixture(); f.setExchange(async () => { throw Error("Response lost"); });
  await f.run(); const exact = stable(f.posts[0]), request = stable(f.requests[0]);
  f.setBalance({ balances: [] }); f.setExchange(async () => ({ status: "err", response: "Invalid nonce: already used" }));
  const result = await f.run();
  expect(stable(f.posts[1])).toBe(exact); expect(stable(f.requests[0])).toBe(request);
  expect(f.nonceCalls()).toBe(1); expect(f.requests).toHaveLength(1); expect(f.journal()!.exchangeRejected).toBe(false);
  expect(result.phase).toBe("core_cash_unknown"); expect(result.state).not.toBe("complete");
});
test("lost Wallet reply discovers its original durable signature without another signing request", async () => {
  const f = fixture(); f.setSign(async request => { f.operations.set(request.requestId, await f.signed(request)); throw Error("Response lost"); });
  await f.run(); expect(f.posts).toHaveLength(0);
  await f.run(); expect(f.requests).toHaveLength(1); expect(f.posts).toHaveLength(1); expect(f.nonceCalls()).toBe(1); expect(f.events).toContain("wallet_status");
});
test("a Wallet request not found after lost delivery is resent with the original exact request", async () => {
  const f = fixture(); f.setSign(async () => { throw Error("Not delivered"); });
  await f.run(); f.setSign(f.signed); await f.run();
  expect(f.requests).toHaveLength(2); expect(stable(f.requests[1])).toBe(stable(f.requests[0])); expect(f.nonceCalls()).toBe(1); expect(f.posts).toHaveLength(1);
});
test("available cash and original proof are required before allocating nonce or invoking Wallet", async () => {
  const f = fixture(); f.setBalance({ balances: [{ token: 0, coin: "USDC", total: "10", hold: "0.3" }] });
  const result = await f.run(); expect(result.phase).toBe("core_cash_waiting"); expect(f.nonceCalls()).toBe(0); expect(f.requests).toHaveLength(0);
  const other = fixture(); other.setObservation({ ...other.proof, phase: "forwarded_to_core" });
  await expect(other.run()).rejects.toThrow("verified CCTP cash-fallback receipt"); expect(other.requests).toHaveLength(0);
  const mismatched = fixture(); mismatched.setObservation({ ...mismatched.proof, evidence: { coreCash: { ...(mismatched.proof.evidence as any).coreCash, recipient: `0x${"44".repeat(20)}` } } });
  await expect(mismatched.run()).rejects.toThrow("verified CCTP cash-fallback receipt");
});
test("known unified collateral needs no cash-to-perps action or account-mode change", async () => {
  for (const mode of ["unifiedAccount", "portfolioMargin"]) {
    const f = fixture(); f.setMode(mode); const result = await f.run();
    expect(result.phase).toBe("core_cash_shared"); expect(result.message).toContain("no cash-to-perps transfer"); expect(f.requests).toHaveLength(0); expect(f.posts).toHaveLength(0); expect(f.nonceCalls()).toBe(0);
  }
});
test("accepted cash recovery remains settled after ordinary funding reconciliation refreshes the receipt view", async () => {
  const f = fixture(); await f.run();
  const result = await f.reconcile();
  expect(result.phase).toBe("forwarded_to_core_cash");
  expect(result.observation!.recovery!.status).toBe("ready");
  expect(result.recovery!.status).toBe("complete"); expect(result.recovery!.methods).toEqual([]);
  expect(result.state).toBe("pending"); expect(f.posts).toHaveLength(1); expect(f.requests).toHaveLength(1);
});
test("observed shared collateral remains settled after ordinary reconciliation without inventing a cash transfer", async () => {
  const f = fixture(); f.setMode("unifiedAccount"); await f.run();
  expect(f.state().coreShared).toEqual({ sourceTransactionHash: sourceHash, destinationTransactionHash: destinationHash, amountAtoms: "9800000", accountMode: "unifiedAccount" });
  const result = await f.reconcile();
  expect(result.phase).toBe("forwarded_to_core_cash"); expect(result.observation!.recovery!.status).toBe("ready");
  expect(result.recovery!.status).toBe("complete"); expect(result.recovery!.methods).toEqual([]);
  expect(result.recovery!.message).toContain("already available when checked");
  expect(result.state).toBe("pending"); expect(f.posts).toHaveLength(0); expect(f.requests).toHaveLength(0); expect(f.nonceCalls()).toBe(0);
});
test("caller, Wallet and retained exact request bindings cannot be replaced", async () => {
  const f = fixture(); await expect(f.run({}, null, false)).rejects.toThrow("original caller");
  f.setAccount({ ...account, keyFingerprint: `0x${"99".repeat(32)}` }); await expect(f.run()).rejects.toThrow("signing identity changed");
  const changed = fixture(); await changed.run(); changed.mutate(state => { (state.coreRecovery as CoreFundingRecovery).action.amount = "19.8"; });
  await expect(changed.run()).rejects.toThrow("Saved cash recovery changed");
});
test("a signature from a different account never reaches the exchange", async () => {
  const f = fixture(), another = privateKeyToAccount(`0x${"22".repeat(32)}`);
  f.setSign(async request => ({ ...await f.signed(request), signature: await another.signTypedData(JSON.parse(request.typedDataJson)) }));
  await expect(f.run()).rejects.toThrow("original account"); expect(f.posts).toHaveLength(0);
});
test("interrupted review persists the exact request and never submits the signed action after cancellation", async () => {
  const f = fixture(), abort = new AbortController();
  f.setSign(async request => { const operation = await f.signed(request); f.operations.set(request.requestId, operation); abort.abort(Error("Stopped")); return operation; });
  await expect(f.run({ signal: abort.signal })).rejects.toThrow("Stopped");
  expect(f.posts).toHaveLength(0); expect(f.journal()!.walletDispatched).toBe(true);
  await f.run(); expect(f.requests).toHaveLength(1); expect(f.posts).toHaveLength(1); expect(f.nonceCalls()).toBe(1);
});
test("concurrent recovery calls cannot dispatch competing signatures or transfers", async () => {
  const f = fixture(), results = await Promise.allSettled([f.run(), f.run()]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
  expect(f.posts).toHaveLength(1); expect(f.requests).toHaveLength(1);
});
test("definite rejection can be explicitly reviewed again while preserving all prior attempts", async () => {
  const denied = fixture(); denied.setSign(async request => ({ ...await denied.signed(request), status: "rejected", signature: null }));
  const result = await denied.run(); expect(result.phase).toBe("core_cash_stopped"); expect(result.message).toContain("without a signature");
  await denied.run({ execute: false }); expect(denied.requests).toHaveLength(1); expect(denied.posts).toHaveLength(0); expect(denied.nonceCalls()).toBe(1);
  denied.setSign(denied.signed); await denied.run(); expect(denied.requests).toHaveLength(2); expect(denied.posts).toHaveLength(1);
  expect(denied.journal()!.previousAttempts).toHaveLength(1); expect(denied.journal()!.previousAttempts![0]!.operation!.status).toBe("rejected");
  expect(denied.requests[1]!.requestId).not.toBe(denied.requests[0]!.requestId);
  const rejected = fixture(); rejected.setExchange(async () => ({ status: "err", response: "Transfer rejected" })); await rejected.run();
  await rejected.run({ execute: false }); expect(rejected.posts).toHaveLength(1); expect(rejected.nonceCalls()).toBe(1);
  rejected.setExchange(async () => ({ status: "ok", response: { type: "default" } })); await rejected.run();
  expect(rejected.journal()!.exchangeAccepted).toBe(true); expect(rejected.journal()!.previousAttempts![0]!.exchangeRejected).toBe(true);
  expect(rejected.journal()!.action.nonce).toBe(now + 1); expect(rejected.posts).toHaveLength(2);
});
test("read-only recovery does not request a signature, allocate nonce, or retransmit an uncertain action", async () => {
  const f = fixture(); await f.run({ execute: false }); expect(f.nonceCalls()).toBe(0); expect(f.requests).toHaveLength(0);
  f.setExchange(async () => { throw Error("Lost reply"); }); await f.run(); await f.run({ execute: false });
  expect(f.posts).toHaveLength(1); expect(f.nonceCalls()).toBe(1);
});
test("accepted cash recovery reports matching history only as contextual evidence", async () => {
  const f = fixture(); await f.run(); f.setLedger([{ hash: `0x${"dd".repeat(32)}`, time: now + 1, delta: { type: "accountClassTransfer", usdc: "9.8", toPerp: true } }]);
  const result = await f.run(); expect(result.message).toContain("contextual"); expect(result.state).not.toBe("complete"); expect(f.journal()!.observation!.transfers).toHaveLength(1); expect(f.posts).toHaveLength(1);
});
test("cash balances exclude holds, other tokens, malformed values and unavailable responses", () => {
  expect(availableCoreCash({ balances: [{ token: 0, coin: "USDC", total: "10.12345678", hold: "0.00000001" }, { token: 1, coin: "OTHER", total: "99", hold: "0" }] })).toBe("10123456");
  expect(availableCoreCash({ balances: [] })).toBe("0");
  for (const raw of [{}, { balances: [{ token: 0, coin: "USDC", total: "1", hold: "2" }] }, { balances: [{ token: 0, coin: "USDC", total: "1e8", hold: "0" }] }, { balances: [{ token: 0, coin: "FAKE", total: "99", hold: "0" }] }]) expect(() => availableCoreCash(raw)).toThrow();
});
test("unrelated or malformed ledger observations do not prove cash recovery", () => {
  const hash = `0x${"dd".repeat(32)}`, valid = { hash, time: now, delta: { type: "accountClassTransfer", toPerp: true, usdc: "9.8" } };
  expect(observedCashTransfers([valid, valid], "9.8", now)).toHaveLength(1);
  expect(observedCashTransfers([{ ...valid, time: now - 1 }, { ...valid, delta: { ...valid.delta, toPerp: false } }, { ...valid, delta: { ...valid.delta, usdc: "9.9" } }, { ...valid, delta: { ...valid.delta, usdc: "9.80000001" } }], "9.8", now)).toEqual([]);
});
