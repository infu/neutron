import { expect, test } from "bun:test";
import type { EthereumProviderConnection } from "neutron-tools/app";
import { serializeError, toError } from "neutron-tools/protocol";
import type { EvmOperationStatusResult, EvmWalletClient } from "neutron-tools/evm_wallet";
import type { Hex } from "viem";
import {
  buildEthereumFundingPlan, executeBrowserFundingStep, executeEvmFundingStep,
  mergeEthereumFundingRecords, principalToEthereumWord,
  type EthereumFundingJournal, type EthereumFundingRecord,
} from "../src/ethereum.ts";

const route = { chainId: "1", tokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", helperAddress: "0x18901044688d3756c35ed2b36d93e6a5b8e00e68", minterAddress: "0xb25ea1d493b49a1ded42ac5b1208cc618f9a9b80", recipientPrincipal: "ryjl3-tyaaa-aaaaa-aaaba-cai" };
const plan = buildEthereumFundingPlan({ operationId: "11".repeat(16), amountAtoms: "1000000", payerAddress: "0x1111111111111111111111111111111111111111", principalWord: principalToEthereumWord(route.recipientPrincipal), subaccountWord: `0x${"ab".repeat(32)}`, route }, route, { approval: "22".repeat(16), deposit: "33".repeat(16) });
const hash = `0x${"55".repeat(32)}` as Hex;
const otherHash = `0x${"66".repeat(32)}` as Hex;
const fingerprint = `0x${"77".repeat(32)}`;
const json = (value: unknown) => JSON.stringify(value);
const initial = (): EthereumFundingRecord => ({ version: 1, invoiceId: plan.invoice.operationId, source: "browser", step: plan.steps.approval, state: "unknown", transactionHash: null, walletIntent: null, receipt: null, message: "Original request" });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function storage() {
  let value: EthereumFundingRecord | null = null, writes = 0, claims = 0;
  const journal: EthereumFundingJournal = {
    async read() { return value ? structuredClone(value) : null; },
    async claim(input) {
      if (value) return { claimed: false, record: structuredClone(value) };
      value = structuredClone(input); claims++;
      return { claimed: true, record: structuredClone(value) };
    },
    async record(previous, next) {
      writes++;
      hooks.beforeRecord?.();
      if (json(previous) !== json(value)) throw new Error("Concurrent funding journal change");
      value = structuredClone(next);
      if (hooks.loseRecordReply) { hooks.loseRecordReply = false; throw new Error("Committed record reply was lost"); }
      return structuredClone(value);
    },
  };
  const hooks = { beforeRecord: null as (() => void) | null, loseRecordReply: false };
  return { journal, hooks, read: () => value, set: (next: EthereumFundingRecord) => { value = structuredClone(next); }, writes: () => writes, claims: () => claims };
}
function contractRead(to: string, data: string): Hex {
  if (to.toLowerCase() === route.helperAddress) return `0x${"0".repeat(24)}${route.minterAddress.slice(2)}`;
  return `0x${(data.startsWith("0x70a08231") ? 1_000_000n : 0n).toString(16).padStart(64, "0")}`;
}
function browser() {
  const started = deferred<void>(), reply = deferred<Hex>();
  let sends = 0, receiptReads = 0;
  const connection = { close: async () => {}, provider: { async request({ method, params }: { method: string; params?: readonly unknown[] }): Promise<unknown> {
    if (method === "eth_requestAccounts") return [plan.invoice.payerAddress];
    if (method === "eth_chainId") return "0x1";
    if (method === "eth_getCode") return "0x6001";
    if (method === "eth_call") { const tx = params![0] as { to: string; data: string }; return contractRead(tx.to, tx.data); }
    if (method === "eth_sendTransaction") { sends++; started.resolve(); return reply.promise; }
    if (method === "eth_getTransactionReceipt") { receiptReads++; return null; }
    throw new Error(method);
  } } } as unknown as EthereumProviderConnection;
  return { connection, started: started.promise, reply: reply.resolve, sends: () => sends, receiptReads: () => receiptReads };
}

test("browser reentry after claim does not invalidate the sender's returned hash", async () => {
  const store = storage(), wallet = browser();
  const sending = executeBrowserFundingStep(plan, "approval", wallet.connection, store.journal);
  await wallet.started;
  const claimed = structuredClone(store.read());
  const observed = await executeBrowserFundingStep(plan, "approval", wallet.connection, store.journal);
  expect(observed).toEqual(claimed);
  expect(store.writes()).toBe(0); expect(wallet.receiptReads()).toBe(0);
  wallet.reply(hash);
  const sent = await sending;
  expect(sent.transactionHash).toBe(hash); expect(sent.state).toBe("submitted");
  expect(store.read()).toEqual(sent); expect(store.claims()).toBe(1); expect(wallet.sends()).toBe(1);
});

test("a concurrent status message merges without losing the send result", async () => {
  const store = storage(), wallet = browser();
  store.hooks.beforeRecord = () => {
    store.hooks.beforeRecord = null;
    store.set({ ...store.read()!, message: "Another observer is still checking this request" });
  };
  const sending = executeBrowserFundingStep(plan, "approval", wallet.connection, store.journal);
  await wallet.started; wallet.reply(hash);
  const result = await sending;
  expect(result.state).toBe("submitted"); expect(result.transactionHash).toBe(hash);
  expect(store.read()?.transactionHash).toBe(hash); expect(store.writes()).toBe(2); expect(wallet.sends()).toBe(1);
});

test("a lost successful record reply is recovered by reading without resend", async () => {
  const store = storage(), wallet = browser(); store.hooks.loseRecordReply = true;
  const sending = executeBrowserFundingStep(plan, "approval", wallet.connection, store.journal);
  await wallet.started; wallet.reply(hash);
  const sent = await sending;
  expect(sent.state).toBe("submitted"); expect(sent.transactionHash).toBe(hash);
  expect(store.read()).toEqual(sent); expect(store.writes()).toBe(1); expect(wallet.sends()).toBe(1);
});

test("a concurrent different hash is retained for review rather than overwritten", async () => {
  const store = storage(), wallet = browser();
  store.hooks.beforeRecord = () => { store.hooks.beforeRecord = null; store.set({ ...store.read()!, state: "submitted", transactionHash: otherHash }); };
  const sending = executeBrowserFundingStep(plan, "approval", wallet.connection, store.journal);
  const outcome = sending.then(() => null, error => error);
  await wallet.started; wallet.reply(hash);
  expect((await outcome)?.message).toContain("Conflicting Ethereum funding transaction hashes");
  expect(store.read()?.transactionHash).toBe(otherHash); expect(wallet.sends()).toBe(1);
});

test("a real message-bus round trip preserves browser rejection without resend", async () => {
  const store = storage(), wallet = browser();
  const rejection = toError(serializeError(Object.assign(new Error("User rejected"), { code: 4001 })));
  const original = wallet.connection.provider.request.bind(wallet.connection.provider);
  let sends = 0;
  wallet.connection.provider.request = async request => {
    if (request.method === "eth_sendTransaction") { sends++; throw rejection; }
    return original(request);
  };
  const rejected = await executeBrowserFundingStep(plan, "approval", wallet.connection, store.journal);
  expect(rejected.state).toBe("rejected"); expect(rejected.transactionHash).toBeNull();
  expect(rejected.message).toContain("declined");
  expect(await executeBrowserFundingStep(plan, "approval", wallet.connection, store.journal)).toEqual(rejected);
  expect(sends).toBe(1);
});

test("record merge preserves the strongest matching receipt and finality", () => {
  const previous = initial();
  const included: EthereumFundingRecord = { ...previous, state: "confirmed", transactionHash: hash, receipt: { status: "success", blockNumber: "123", finality: "included" } };
  const finalized: EthereumFundingRecord = { ...included, receipt: { ...included.receipt!, finality: "finalized" } };
  const stale: EthereumFundingRecord = { ...previous, message: "Still waiting" };
  expect(mergeEthereumFundingRecords(previous, finalized, included)).toEqual(finalized);
  expect(mergeEthereumFundingRecords(included, finalized, stale)).toEqual(finalized);
  expect(mergeEthereumFundingRecords(previous, stale, finalized)).toEqual(finalized);
  const reverted: EthereumFundingRecord = { ...finalized, state: "reverted", receipt: { ...finalized.receipt!, status: "reverted" } };
  expect(() => mergeEthereumFundingRecords(previous, finalized, reverted)).toThrow("Conflicting Ethereum receipt evidence");
  expect(() => mergeEthereumFundingRecords(previous, finalized, { ...included, receipt: { ...included.receipt!, blockNumber: "124" } })).toThrow("Conflicting Ethereum receipt evidence");
});

test("record merge refuses altered invoice, wallet, or exact transaction identity", () => {
  const previous = initial(), next: EthereumFundingRecord = { ...previous, state: "submitted", transactionHash: hash };
  const changes: Partial<EthereumFundingRecord>[] = [
    { invoiceId: "99".repeat(16) }, { source: "evm_wallet" },
    { step: { ...previous.step, requestId: "88".repeat(16) } },
    { step: { ...previous.step, transaction: { ...previous.step.transaction, data: "0x" } } },
    { walletIntent: { version: 1, kind: "transaction", request: { accountId: "main", chainId: "1", requestId: previous.step.requestId, to: previous.step.transaction.to, valueWei: "0", data: previous.step.transaction.data }, walletAddress: plan.invoice.payerAddress, walletKeyFingerprint: fingerprint } },
  ];
  for (const change of changes) expect(() => mergeEthereumFundingRecords(previous, { ...previous, ...change }, next)).toThrow("Conflicting Ethereum funding request identity");
  expect(() => mergeEthereumFundingRecords(previous, { ...next, transactionHash: otherHash }, next)).toThrow("Conflicting Ethereum funding transaction hashes");
});

test("Wallet prepared review resumes through the same ordinary provider request", async () => {
  const store = storage(), sentRequests: unknown[] = [];
  const identity = { accountId: "main" as const, chainId: "1", requestId: plan.steps.approval.requestId };
  const base = { ...identity, operationId: "17", kind: "transaction" as const, address: plan.invoice.payerAddress.toLowerCase(), transactionHash: null, signature: null, message: null, reviewRevision: "2", receipt: null };
  let status: EvmOperationStatusResult = { ...identity, status: "not_found" }, mined = false;
  const client = {
    async accounts() { return { accounts: [{ accountId: "main", address: plan.invoice.payerAddress.toLowerCase(), keyFingerprint: fingerprint }] }; },
    async callContract(tx: { to: string; data: string }) { return { result: contractRead(tx.to, tx.data) }; },
    async readContract() { return { code: "0x6001" }; },
    async operationStatus(request: unknown) { expect(request).toEqual(identity); return status; },
    async sendTransaction(request: unknown) {
      sentRequests.push(structuredClone(request));
      status = sentRequests.length === 1
        ? { ...base, status: "prepared", message: "Nonce changed; review this exact request again" }
        : { ...base, status: "submitted", transactionHash: hash };
      return status;
    },
    async sendTransactionRoot() { throw new Error("Nested calls must use the existing provider approval flow"); },
    async transaction(request: unknown) {
      expect(request).toEqual({ chainId: "1", transactionHash: hash });
      return { transaction: mined ? { from: plan.invoice.payerAddress, to: plan.steps.approval.transaction.to, data: plan.steps.approval.transaction.data, valueWei: "0" } : null,
        receipt: mined ? { status: "success", blockNumber: "123", finality: "safe" } : null };
    },
  } as unknown as EvmWalletClient;
  const prepared = await executeEvmFundingStep(plan, "approval", client, store.journal);
  expect(prepared.state).toBe("prepared"); expect(prepared.transactionHash).toBeNull(); expect(sentRequests).toHaveLength(1);
  const submitted = await executeEvmFundingStep(plan, "approval", client, store.journal);
  expect(submitted.state).toBe("submitted"); expect(submitted.transactionHash).toBe(hash); expect(sentRequests).toHaveLength(2);
  expect(sentRequests[0]).toEqual(sentRequests[1]);
  expect((sentRequests[1] as { requestId: string }).requestId).toBe(identity.requestId);
  await executeEvmFundingStep(plan, "approval", client, store.journal);
  expect(sentRequests).toHaveLength(2);
  mined = true;
  const confirmed = await executeEvmFundingStep(plan, "approval", client, store.journal);
  expect(confirmed.state).toBe("confirmed"); expect(confirmed.receipt?.finality).toBe("safe"); expect(store.claims()).toBe(1); expect(sentRequests).toHaveLength(2);
});
