import { expect, test } from "bun:test";
import { encodeFunctionResult, type Hex } from "viem";
import { bridgeComplete, bridgeEvmRequestId, bridgeLabel, executeBridgeDeposit, type BridgeClient, type BridgeIntent } from "../src/bridge.ts";
import type { EthereumProvider } from "../src/ethereum.ts";
const account = `0x${"11".repeat(20)}`, helper = `0x${"22".repeat(20)}`, minter = `0x${"33".repeat(20)}`, token = `0x${"44".repeat(20)}`;
const hash = `0x${"ab".repeat(32)}` as Hex, approvalHash = `0x${"cd".repeat(32)}` as Hex;
const helperAbi = [{ type: "function", name: "getMinterAddress", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] }] as const;
function intent(): BridgeIntent {
  return { id: "01".repeat(16), quote: { chainId: "1", ledger: "ss2fx-dyaaa-aaaar-qacoq-cai", minter: "sv3dd-oaaaa-aaaar-qacoa-cai", helperAddress: helper, helperMode: "subaccount", minterAddress: minter, tokenAddress: null, recipient: "aaaaa-aa", principalWord: `0x${"00".repeat(32)}`, subaccountWord: `0x${"00".repeat(32)}` }, source: "external", account, amount: "12", revision: "0", createdAt: "1", updatedAt: "1", eventCursor: "42", acceptedDeposit: null, mint: null, error: null, steps: ["reset_approval", "approval", "deposit"].map((kind) => ({ kind: kind as "deposit", state: "ready", operationId: null, transactionHash: null, error: null })) };
}
function store(initial = intent()) {
  let saved = structuredClone(initial);
  const client: BridgeClient = {
    effectiveHash: async () => null, recordReplacement: async () => { throw new Error("External browser fixture cannot prove a replacement"); },
    quote: async () => structuredClone(saved.quote), prepare: async () => structuredClone(saved), list: async () => [structuredClone(saved)], status: async () => structuredClone(saved), refresh: async () => structuredClone(saved),
    async claim(old, kind, operationId) { if (old.revision !== saved.revision) throw new Error("revision conflict"); const step = saved.steps.find((s) => s.kind === kind)!; if (step.state !== "ready") throw new Error("already claimed"); step.state = "unknown"; step.operationId = operationId; saved.revision = String(BigInt(saved.revision) + 1n); return structuredClone(saved); },
    async record(old, kind, state, transactionHash, error = null) { if (old.revision !== saved.revision) throw new Error("revision conflict"); Object.assign(saved.steps.find((s) => s.kind === kind)!, { state, transactionHash, error }); saved.revision = String(BigInt(saved.revision) + 1n); return structuredClone(saved); },
  };
  return { client, saved: () => structuredClone(saved) };
}
function provider(override: (method: string) => unknown = () => undefined): EthereumProvider {
  return { async request({ method }) { const value = override(method); if (value !== undefined) return value; if (method === "eth_requestAccounts") return [account]; if (method === "eth_chainId") return "0x1"; if (method === "eth_getCode") return "0x6001"; if (method === "eth_call") return encodeFunctionResult({ abi: helperAbi, functionName: "getMinterAddress", result: minter as Hex }); if (method === "eth_sendTransaction") return hash; if (method === "eth_getTransactionReceipt") return { status: "0x1" }; throw new Error(`Unexpected ${method}`); } };
}
test("accepted browser send with lost reply remains unknown and never resends after reload", async () => {
  const db = store(); let sends = 0; const wallet = provider((method) => { if (method === "eth_sendTransaction") { sends++; expect(db.saved().steps[2]?.state).toBe("unknown"); throw new Error("reply lost after broadcast"); } });
  await expect(executeBridgeDeposit({ intent: intent(), client: db.client, provider: wallet })).rejects.toThrow("reply lost");
  await expect(executeBridgeDeposit({ intent: structuredClone(db.saved()), client: db.client, provider: wallet })).rejects.toThrow("will not be resent");
  expect(sends).toBe(1); expect(db.saved().steps[2]?.state).toBe("unknown");
});
test("receipt timeout resumes the saved hash and cannot make a fresh deposit", async () => {
  const db = store(); let sends = 0, pending = true; const wallet = provider((method) => { if (method === "eth_sendTransaction") { sends++; return hash; } if (method === "eth_getTransactionReceipt") return pending ? null : { status: "0x1" }; });
  await expect(executeBridgeDeposit({ intent: intent(), client: db.client, provider: wallet, confirmationTimeoutMs: 1, pollIntervalMs: 0 })).rejects.toThrow("still pending"); expect(db.saved().steps[2]).toMatchObject({ state: "submitted", transactionHash: hash }); pending = false;
  await executeBridgeDeposit({ intent: db.saved(), client: db.client, provider: wallet }); expect(sends).toBe(1); expect(db.saved().steps[2]?.state).toBe("confirmed"); expect(bridgeComplete(db.saved())).toBe(false);
});
test("malformed receipt stays unresolved; an explicit revert is terminal", async () => {
  const db = store(); await expect(executeBridgeDeposit({ intent: intent(), client: db.client, provider: provider((m) => m === "eth_getTransactionReceipt" ? { bogus: true } : undefined) })).rejects.toThrow("invalid Ethereum receipt status"); expect(db.saved().steps[2]?.state).toBe("submitted");
  await expect(executeBridgeDeposit({ intent: db.saved(), client: db.client, provider: provider((m) => m === "eth_getTransactionReceipt" ? { status: "0x0" } : undefined) })).rejects.toThrow("failed on Ethereum"); expect(db.saved().steps[2]?.state).toBe("failed");
});
test("two Wallet tiles cannot claim and submit the same browser deposit", async () => {
  const db = store(); let sends = 0; const wallet = provider((m) => { if (m === "eth_sendTransaction") { sends++; return hash; } });
  const outcomes = await Promise.allSettled([executeBridgeDeposit({ intent: intent(), client: db.client, provider: wallet }), executeBridgeDeposit({ intent: intent(), client: db.client, provider: wallet })]); expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1); expect(sends).toBe(1);
});
test("unresolved EVM approval resumes the same request before deposit and preserves reset", async () => {
  const start = intent(); start.source = "evm"; start.quote.tokenAddress = token; start.steps[0]!.state = "confirmed"; start.steps[0]!.transactionHash = hash; start.steps[1]!.state = "unknown"; start.steps[1]!.operationId = bridgeEvmRequestId(start.id, "approval");
  const db = store(start), calls: string[] = []; const base = provider(); const wallet: EthereumProvider = { async request(args) { if (args.method === "eth_call" && (args.params as [{to:string}])[0].to !== helper) return `0x${12n.toString(16).padStart(64, "0")}`; return base.request(args); } };
  await executeBridgeDeposit({ intent: start, client: db.client, provider: wallet, evm: { send: async (id) => { calls.push(id); return id === start.steps[1]!.operationId ? approvalHash : hash; }, confirm: async () => undefined } });
  expect(calls).toEqual([start.steps[1]!.operationId!, bridgeEvmRequestId(start.id, "deposit")]); expect(db.saved().steps.map((s) => s.state)).toEqual(["confirmed", "confirmed", "confirmed"]);
});
test("minter acceptance or an unverified mint is not mint completion", () => {
  const saved = intent(); saved.steps[2]!.state = "confirmed"; saved.steps[2]!.transactionHash = hash; saved.acceptedDeposit = { logIndex: "3", blockNumber: "200", eventIndex: "90" }; expect(bridgeComplete(saved)).toBe(false); expect(bridgeLabel(saved)).toContain("awaiting its mint"); saved.mint = { ledgerBlockIndex: "44", eventIndex: "91", verifiedLedger: false }; expect(bridgeComplete(saved)).toBe(false); saved.mint.verifiedLedger = true; expect(bridgeComplete(saved)).toBe(true);
});
test("root Agent bridge cannot replay with IC Wallet's different caller identity", async () => {
  const saved = intent(); saved.source = { appId: "agent", installationUid: "51" }; const db = store(saved); let requests = 0; await expect(executeBridgeDeposit({ intent: saved, client: db.client, provider: provider(() => { requests++; }) })).rejects.toThrow("original root Agent"); expect(requests).toBe(0);
});

test("owner can recover a lost browser reply only by attaching an exact independently read transaction", async () => {
  const { createEvmWalletClient } = await import("neutron-tools/evm_wallet");
  const { attachExternalBridgeTransaction } = await import("../src/evm_bridge.ts");
  const { bridgeTransaction } = await import("../src/bridge.ts");
  const saved = intent(); saved.steps[2]!.state = "unknown";
  const db = store(saved), expected = bridgeTransaction(saved, "deposit");
  let wrong = true, reads = 0;
  const client = createEvmWalletClient({ async callTool(call) {
    expect(call.name).toBe("evm_transaction_v1"); reads++;
    return { chainId: "1", transactionHash: hash, transaction: { from: account, to: wrong ? token : expected.to, data: expected.data, valueWei: "12", nonce: "6", blockNumber: null, blockHash: null }, receipt: null, observedAtNs: "1", source: "evm_rpc", walletRequestMatches: null } as never;
  } });
  await expect(attachExternalBridgeTransaction(client, db.client, saved, "deposit", hash)).rejects.toThrow("does not match");
  expect(db.saved().steps[2]?.transactionHash).toBeNull();
  wrong = false;
  const attached = await attachExternalBridgeTransaction(client, db.client, saved, "deposit", hash);
  expect(attached.steps[2]).toMatchObject({ state: "submitted", transactionHash: hash });
  let sends = 0;
  await executeBridgeDeposit({ intent: attached, client: db.client, provider: provider((method) => { if (method === "eth_sendTransaction") sends++; }) });
  expect(reads).toBe(2); expect(sends).toBe(0); expect(db.saved().steps[2]?.state).toBe("confirmed");
});
