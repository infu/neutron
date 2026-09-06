import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { isJsonValue, type SelfCallObject } from "neutron-tools/app";
import { generateAppMethodSchemaArtifact, validateAppMethodArgs } from "neutron-scripts/src/method_schema.js";
import { browserEvmRpc, createBrowserEvmRpc } from "../src/browser_rpc.ts";
import {
  executeBrowserOperation,
  prepareBrowserOperation,
  readBrowserOperation,
  reconcileBrowserOperation,
  type OperationKernel,
} from "../src/browser_operations.ts";

// This key and signer exist only in this offline fixture. The RPC transport below
// intercepts every POST; no test can reach an EVM network or a canister.
const signer = privateKeyToAccount(`0x${"01".repeat(32)}`);
const TO = `0x${"22".repeat(20)}` as Hex;
const BLOCK_HASH = `0x${"33".repeat(32)}`;
const identity: SelfCallObject = {
  caller: { app_id: "uniswap", installation_uid: "17", endpoint: "app:uniswap:tile:main" },
  request_id: "ab".repeat(16),
};
const intent: SelfCallObject = {
  account_id: "main", chain_id: "1",
  operation: { transaction: { to: TO, value: "7", data: "0x", access_list: [] } },
};
const copy = <T>(value: T): T => structuredClone(value);
const methodSchemas = generateAppMethodSchemaArtifact(
  JSON.parse(readFileSync(new URL("../neutron.json", import.meta.url), "utf8")),
  readFileSync(new URL("../backend/main.mo", import.meta.url), "utf8"),
);
function checkArguments(method: string, args: unknown[]) {
  if (!isJsonValue(args)) throw new Error("Fixture expected JSON method arguments");
  expect(validateAppMethodArgs(methodSchemas, method, args).errors).toEqual([]);
}

function operationWire(requestIntent = intent) {
  return {
    caller: copy(identity.caller), operation_id: "1", request_id: identity.request_id,
    account_id: "main", chain_id: "1", kind: "transaction", status: "preparing",
    address: signer.address, transaction_hash: null as string | null,
    replacement_hash: null as string | null, signature: null, message: null as string | null,
    review_revision: "1", receipt_json: null as string | null, finality: null as string | null,
    created_at: "1000000", updated_at: "1000000", intent: copy(requestIntent),
    review: {
      nonce: "0", gas_limit: "0", max_fee_per_gas: "2", max_priority_fee_per_gas: "1",
      gas_price: null, balance: "1000000000", simulation: "Awaiting simulation", observed_at: "1000000",
    },
    prepared_transaction: {
      transaction_type: "eip1559", to: TO, value: "7", data: "0x", access_list: [],
      chain_id: "1", nonce: "0", gas_limit: "0", max_fee_per_gas: "2",
      max_priority_fee_per_gas: "1", gas_price: null,
    },
  };
}
type Wire = ReturnType<typeof operationWire>;
type RpcCall = { url: string; init: RequestInit; method: string; params: unknown[] };
type BackendCall = { kind: "query" | "update"; method: string; args: unknown[] };
const restore: Array<() => void> = [];
afterEach(() => { for (const reset of restore.splice(0)) reset(); });

function fixture(options: { finishNonceRace?: boolean; executeNonceRace?: boolean } = {}) {
  const http: RpcCall[] = [], backend: BackendCall[] = [];
  let saved: Wire | null = null;
  let raw: Hex | null = null;
  let signatures = 0;
  let finishCount = 0;
  let executeCount = 0;
  let accepted = false;
  let broadcastFailure: "none" | "after_accept" | "before_accept" = "none";
  let mined = false;
  let balance = "0x3b9aca00";

  const fetch = (async (url: RequestInfo | URL, init: RequestInit = {}) => {
    const envelope = JSON.parse(String(init.body)) as { id: string; method: string; params: unknown[] };
    const { method, params } = envelope;
    http.push({ url: String(url), init, method, params: copy(params) });
    let result: unknown;
    switch (method) {
      case "eth_chainId": result = "0x1"; break;
      case "eth_getBlockByNumber": result = { number: "0x100", hash: BLOCK_HASH, baseFeePerGas: "0x1", transactions: saved?.transaction_hash && accepted ? [saved.transaction_hash] : [] }; break;
      case "eth_getTransactionCount": result = "0x0"; break;
      case "eth_getBalance": result = balance; break;
      case "eth_gasPrice": result = "0x2"; break;
      case "eth_maxPriorityFeePerGas": result = "0x1"; break;
      case "eth_estimateGas": {
        const tx = params[0] as { nonce: string };
        result = tx.nonce === "0x0" ? "0x5208" : "0xa410";
        break;
      }
      case "eth_call": result = "0x"; break;
      case "eth_sendRawTransaction":
        expect(params).toEqual([raw]);
        if (broadcastFailure !== "before_accept") accepted = true;
        if (broadcastFailure !== "none") throw new TypeError("Connection closed before the POST response");
        result = raw ? keccak256(raw) : null;
        break;
      case "eth_getTransactionByHash":
        expect(params).toEqual([saved?.transaction_hash]);
        result = accepted ? { hash: saved?.transaction_hash, from: signer.address, to: TO, nonce: `0x${BigInt(saved!.prepared_transaction.nonce).toString(16)}`, input: "0x", value: "0x7", blockNumber: mined ? "0x100" : null, blockHash: mined ? BLOCK_HASH : null } : null;
        break;
      case "eth_getTransactionReceipt":
        expect(params).toEqual([saved?.transaction_hash]);
        result = accepted && mined ? { transactionHash: saved?.transaction_hash, blockNumber: "0x100", blockHash: BLOCK_HASH, status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x2", logs: [] } : null;
        break;
      default: throw new Error(`Unexpected browser RPC ${method}`);
    }
    return Response.json({ jsonrpc: "2.0", id: envelope.id, result });
  }) as typeof globalThis.fetch;
  const rpc = createBrowserEvmRpc({ fetch, endpoints: { "1": "https://fixture.invalid/ethereum" } });
  const requestSpy = spyOn(browserEvmRpc, "request").mockImplementation(rpc.request);
  restore.push(() => requestSpy.mockRestore());
  const current = () => {
    if (!saved) throw new Error("No fixture operation");
    return saved;
  };
  const kernel = {
    async querySelf(method: string, args: unknown[]) {
      checkArguments(method, args);
      backend.push({ kind: "query", method, args: copy(args) });
      if (method === "evm_wallet_operation_v1") return saved ? { ok: copy(saved) } : { err: "not_found" };
      if (method === "evm_wallet_superseding_v1") return { ok: null };
      if (method === "evm_wallet_submission_v1") {
        expect(saved?.transaction_hash).not.toBeNull();
        if (!raw) return { err: "No retained signed transaction" };
        return { ok: { chain_id: "1", transaction_hash: current().transaction_hash, raw_transaction: raw } };
      }
      throw new Error(`Unexpected private query ${method}`);
    },
    async updateSelf(method: string, args: unknown[]) {
      checkArguments(method, args);
      backend.push({ kind: "update", method, args: copy(args) });
      const input = args[0] as Record<string, any>;
      if (method === "evm_wallet_accounts_v1") return { ok: [{ id: "main", slot: "main", address: signer.address, public_key: new Uint8Array([2, ...new Uint8Array(32).fill(1)]), namespace_version: "1" }] };
      if (method === "evm_wallet_prepare_browser_v1") {
        expect(input.request.identity).toEqual(identity);
        if (saved && JSON.stringify(input.request.intent) !== JSON.stringify(saved.intent)) return { err: "request_id_conflict: original intent is immutable" };
        if (!saved) {
          saved = operationWire(input.request.intent);
          saved.review.balance = input.observation.balance;
          saved.review.nonce = input.observation.pending_nonce;
          saved.prepared_transaction.nonce = input.observation.pending_nonce;
        }
        return { ok: copy(saved) };
      }
      if (method === "evm_wallet_finish_prepare_browser_v1") {
        expect(input.identity).toEqual(identity);
        expect(input.review_revision).toBe(current().review_revision);
        finishCount++;
        if (options.finishNonceRace && finishCount === 1) {
          current().prepared_transaction.nonce = "1";
          current().review.nonce = "1";
          current().review_revision = "2";
          current().message = "The nonce changed; estimate the updated candidate.";
        } else {
          current().status = "prepared";
          current().prepared_transaction.gas_limit = input.gas_limit;
          current().review.gas_limit = input.gas_limit;
          current().review.simulation = input.simulation;
          if (input.balance !== undefined) current().review.balance = input.balance;
          current().review_revision = String(BigInt(current().review_revision) + 1n);
        }
        return { ok: copy(saved) };
      }
      if (method === "evm_wallet_execute_v1") {
        executeCount++;
        expect(input.identity).toEqual(identity);
        if (current().status !== "prepared") return { ok: copy(saved) };
        expect(input.review_revision).toBe(current().review_revision);
        if (options.executeNonceRace && executeCount === 1) {
          current().status = "preparing";
          current().prepared_transaction.nonce = "1";
          current().review.nonce = "1";
          current().review_revision = String(BigInt(current().review_revision) + 1n);
          current().message = "The nonce changed; estimate the updated candidate.";
          return { ok: copy(saved) };
        }
        signatures++;
        const tx = current().prepared_transaction;
        raw = await signer.signTransaction({ chainId: 1, type: "eip1559", to: tx.to, value: BigInt(tx.value), data: tx.data as Hex, nonce: Number(tx.nonce), gas: BigInt(tx.gas_limit), maxFeePerGas: BigInt(tx.max_fee_per_gas), maxPriorityFeePerGas: BigInt(tx.max_priority_fee_per_gas) });
        current().transaction_hash = keccak256(raw);
        current().status = "signed";
        return { ok: copy(saved) };
      }
      if (method === "evm_wallet_observe_browser_v1") {
        expect(input.identity).toEqual(identity);
        expect(input.transaction_hash).toBe(current().transaction_hash);
        const transaction = JSON.parse(input.transaction_json);
        if (input.receipt_json) {
          expect(JSON.parse(input.canonical_block_json).hash).toBe(BLOCK_HASH);
          current().receipt_json = input.receipt_json;
          current().finality = input.finalized_block_json ? "finalized" : "included";
          current().status = "confirmed";
        } else current().status = transaction ? "submitted" : "unknown";
        current().message = input.broadcast_error ?? null;
        return { ok: copy(saved) };
      }
      if (method === "evm_wallet_status_v1") {
        expect(input.refresh).toBe(false);
        if (current().status === "signing") current().status = "unknown";
        return { ok: copy(saved) };
      }
      throw new Error(`Unexpected backend effect ${method}`);
    },
  } as unknown as OperationKernel;
  return {
    kernel, http, backend,
    state: () => ({ saved: copy(saved), raw, signatures, executeCount, finishCount }),
    load: (value: Wire) => { saved = copy(value); },
    failBroadcast: (value: typeof broadcastFailure) => { broadcastFailure = value; },
    mine: () => { mined = true; },
    balance: (value: string) => { balance = value; },
  };
}

test("preparation performs individual direct RPC reads and persists the exact simulated candidate before approval", async () => {
  const app = fixture();
  const operation = await prepareBrowserOperation(app.kernel, identity, intent);
  expect(operation.status).toBe("prepared");
  expect(operation.preparedTransaction).toMatchObject({ nonce: "0", gasLimit: "21000", to: TO, value: "7" });
  expect(app.state().signatures).toBe(0);
  expect(app.backend.every(call => call.method !== "evm_wallet_execute_v1")).toBe(true);
  expect(app.http.filter(call => call.method === "eth_sendRawTransaction")).toHaveLength(0);
  expect(app.http.map(call => call.method)).toEqual([
    "eth_chainId", "eth_getBlockByNumber", "eth_getTransactionCount", "eth_gasPrice", "eth_maxPriorityFeePerGas",
    "eth_getBalance", "eth_getTransactionCount", "eth_estimateGas", "eth_call", "eth_getTransactionCount", "eth_getTransactionCount",
  ]);
  for (const call of app.http) {
    expect(call.url).toBe("https://fixture.invalid/ethereum");
    expect(Array.isArray(JSON.parse(String(call.init.body)))).toBe(false);
    expect(call.init.credentials).toBe("omit");
  }
  const estimate = app.http.find(call => call.method === "eth_estimateGas")!;
  const simulation = app.http.find(call => call.method === "eth_call")!;
  expect(estimate.params[1]).toBe("0x100");
  expect(simulation.params).toEqual([{ ...(estimate.params[0] as object), gas: "0x5208" }, "0x100"]);
  const finish = app.backend.find(call => call.method === "evm_wallet_finish_prepare_browser_v1")!;
  expect(finish.args[0]).toMatchObject({ balance: "1000000000", pending_nonce: "0", mined_nonce: "0", gas_estimate: "21000", gas_limit: "21000", simulation: "0x" });
  expect(app.backend.map(call => call.method)).not.toContain("evm_wallet_prepare_v1");
  expect(app.backend.map(call => call.method)).not.toContain("evm_wallet_read_contract_v1");
});

test("a lost broadcast reply retains the accepted hash without retrying or signing twice", async () => {
  const app = fixture();
  const prepared = await prepareBrowserOperation(app.kernel, identity, intent);
  app.failBroadcast("after_accept");
  const result = await executeBrowserOperation(app.kernel, prepared);
  expect(result.status).toBe("submitted");
  expect(result.transactionHash).toBe(keccak256(app.state().raw!));
  expect(result.message).toContain("Broadcast outcome requires reconciliation");
  expect(app.state().signatures).toBe(1);
  expect(app.http.filter(call => call.method === "eth_sendRawTransaction")).toHaveLength(1);
  const before = app.http.length;
  const replay = await prepareBrowserOperation(app.kernel, identity, intent);
  expect(replay.transactionHash).toBe(result.transactionHash);
  expect(app.http).toHaveLength(before);
  expect(app.state().signatures).toBe(1);
});

test("an explicit reconciliation may rebroadcast only the retained bytes, without executing or signing again", async () => {
  const app = fixture();
  const prepared = await prepareBrowserOperation(app.kernel, identity, intent);
  app.failBroadcast("before_accept");
  const uncertain = await executeBrowserOperation(app.kernel, prepared);
  expect(uncertain.status).toBe("unknown");
  const retained = app.state().raw;
  expect(app.http.filter(call => call.method === "eth_sendRawTransaction")).toHaveLength(1);
  app.failBroadcast("none");
  const result = await reconcileBrowserOperation(app.kernel, uncertain);
  expect(result.status).toBe("submitted");
  expect(result.transactionHash).toBe(uncertain.transactionHash);
  expect(app.http.filter(call => call.method === "eth_sendRawTransaction").map(call => call.params)).toEqual([[retained], [retained]]);
  expect(app.state().signatures).toBe(1);
  expect(app.state().executeCount).toBe(1);
});

test("canonical receipt reconciliation observes finality without another broadcast", async () => {
  const app = fixture();
  const submitted = await executeBrowserOperation(app.kernel, await prepareBrowserOperation(app.kernel, identity, intent));
  app.mine();
  const confirmed = await reconcileBrowserOperation(app.kernel, submitted);
  expect(confirmed.status).toBe("confirmed");
  expect(confirmed.finality).toBe("finalized");
  expect(confirmed.transactionHash).toBe(submitted.transactionHash);
  expect(app.http.filter(call => call.method === "eth_sendRawTransaction")).toHaveLength(1);
  expect(app.http.filter(call => call.method === "eth_getBlockByNumber").slice(-3).map(call => call.params[0])).toEqual(["0x100", "safe", "finalized"]);
  expect(app.state().signatures).toBe(1);
});

test("a nonce changed during preparation is estimated and simulated again before review", async () => {
  const app = fixture({ finishNonceRace: true });
  const result = await prepareBrowserOperation(app.kernel, identity, intent);
  expect(result.status).toBe("prepared");
  expect(result.review).toMatchObject({ nonce: "1", gasLimit: "42000" });
  expect(result.preparedTransaction).toMatchObject({ nonce: "1", gasLimit: "42000" });
  expect(app.http.filter(call => call.method === "eth_estimateGas").map(call => (call.params[0] as { nonce: string }).nonce)).toEqual(["0x0", "0x1"]);
  expect(app.state().signatures).toBe(0);
});

test("a nonce changed at approval returns a freshly simulated review and requires another explicit execute", async () => {
  const app = fixture({ executeNonceRace: true });
  const prepared = await prepareBrowserOperation(app.kernel, identity, intent);
  app.balance("0x77359400");
  const changed = await executeBrowserOperation(app.kernel, prepared);
  expect(changed.status).toBe("prepared");
  expect(changed.review).toMatchObject({ nonce: "1", gasLimit: "42000", balance: "2000000000" });
  expect(changed.reviewRevision).not.toBe(prepared.reviewRevision);
  expect(app.state().signatures).toBe(0);
  expect(app.state().executeCount).toBe(1);
  expect(app.http.filter(call => call.method === "eth_sendRawTransaction")).toHaveLength(0);
  const submitted = await executeBrowserOperation(app.kernel, changed);
  expect(submitted.status).toBe("submitted");
  expect(app.state().signatures).toBe(1);
  expect(app.state().executeCount).toBe(2);
});

test.each(["preparing", "prepared"])("a changed intent for an existing %s request fails before any RPC", async (status) => {
  const app = fixture();
  app.load({ ...operationWire(), status });
  const changed: SelfCallObject = { ...intent, operation: { transaction: { to: `0x${"44".repeat(20)}`, value: "7", data: "0x", access_list: [] } } };
  await expect(prepareBrowserOperation(app.kernel, identity, changed)).rejects.toThrow("request_id_conflict");
  expect(app.http).toHaveLength(0);
  expect(app.state().signatures).toBe(0);
});

test.each(["signing", "unknown"])("a saved %s signature without a transaction hash is never re-executed during reconciliation", async (status) => {
  const app = fixture();
  app.load({ ...operationWire(), status, message: "Signer response lost" });
  const saved = await readBrowserOperation(app.kernel, identity);
  expect(saved).not.toBeNull();
  const result = await reconcileBrowserOperation(app.kernel, saved!);
  expect(result.status).toBe("unknown");
  expect(result.transactionHash).toBeNull();
  expect(app.http).toHaveLength(0);
  expect(app.state().executeCount).toBe(0);
  expect(app.state().signatures).toBe(0);
});

async function replacementFixture(originalMinedAfterReplacementLookupFails = false) {
  const replacementIdentity = { ...identity, request_id: "cd".repeat(16) };
  const raw = await signer.signTransaction({ chainId: 1, type: "eip1559", to: TO, value: 7n, data: "0x", nonce: 0, gas: 21000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
  const replacementRaw = await signer.signTransaction({ chainId: 1, type: "eip1559", to: TO, value: 7n, data: "0x", nonce: 0, gas: 21000n, maxFeePerGas: 4n, maxPriorityFeePerGas: 2n });
  const original = { ...operationWire(), status: "unknown", transaction_hash: keccak256(raw) };
  const replacement = {
    ...operationWire(), status: "unknown", operation_id: "2", request_id: replacementIdentity.request_id,
    transaction_hash: keccak256(replacementRaw),
    intent: { account_id: "main", chain_id: "1", operation: { replacement: { operation_id: "1", cancel: false, max_fee_per_gas: "4", max_priority_fee_per_gas: "2" } } },
  };
  const records = new Map<string, Wire>([[String(identity.request_id), original], [replacementIdentity.request_id, replacement]]);
  const http: Array<{ method: string; params: unknown[] }> = [];
  const observations: string[] = [];
  const fetch = (async (_url: RequestInfo | URL, init: RequestInit = {}) => {
    const { id, method, params } = JSON.parse(String(init.body)) as { id: string; method: string; params: unknown[] };
    http.push({ method, params: copy(params) });
    const replacementLookup = params[0] === replacement.transaction_hash;
    let result: unknown;
    if (method === "eth_chainId") result = "0x1";
    else if (method === "eth_getTransactionByHash" || method === "eth_getTransactionReceipt") {
      if (replacementLookup && originalMinedAfterReplacementLookupFails) throw new Error("Replacement lookup unavailable");
      const found = replacementLookup || originalMinedAfterReplacementLookupFails;
      result = !found ? null : method === "eth_getTransactionByHash"
        ? { hash: params[0], from: signer.address, to: TO, nonce: "0x0", input: "0x", value: "0x7", blockNumber: "0x100", blockHash: BLOCK_HASH }
        : { transactionHash: params[0], blockNumber: "0x100", blockHash: BLOCK_HASH, status: "0x1", gasUsed: "0x5208", effectiveGasPrice: "0x2", logs: [] };
    } else if (method === "eth_getBlockByNumber") result = { number: "0x100", hash: BLOCK_HASH, transactions: [originalMinedAfterReplacementLookupFails ? original.transaction_hash : replacement.transaction_hash] };
    else throw new Error(`Recovery must not sign, submit, or use unrelated RPC: ${method}`);
    return Response.json({ jsonrpc: "2.0", id, result });
  }) as typeof globalThis.fetch;
  const rpc = createBrowserEvmRpc({ fetch });
  const requestSpy = spyOn(browserEvmRpc, "request").mockImplementation(rpc.request);
  restore.push(() => requestSpy.mockRestore());
  const kernel = {
    async querySelf(method: string, args: unknown[]) {
      checkArguments(method, args);
      const input = args[0] as { identity: { request_id: string } };
      const operation = records.get(input.identity.request_id);
      if (!operation) return { err: "not_found" };
      if (method === "evm_wallet_operation_v1") return { ok: copy(operation) };
      if (method === "evm_wallet_superseding_v1") return { ok: operation === original ? copy(replacement) : null };
      throw new Error(`Unexpected recovery query ${method}`);
    },
    async updateSelf(method: string, args: unknown[]) {
      checkArguments(method, args);
      if (method !== "evm_wallet_observe_browser_v1") throw new Error(`Recovery must not execute or sign: ${method}`);
      const input = args[0] as Record<string, any>;
      const operation = records.get(input.identity.request_id)!;
      expect(input.transaction_hash).toBe(operation.transaction_hash);
      observations.push(operation.operation_id);
      if (input.receipt_json) {
        operation.status = "confirmed";
        operation.receipt_json = input.receipt_json;
        operation.finality = "finalized";
      } else if (operation === original && replacement.status === "confirmed") {
        operation.status = "replaced";
        operation.replacement_hash = replacement.transaction_hash;
      }
      return { ok: copy(operation) };
    },
  } as unknown as OperationKernel;
  const operation = await readBrowserOperation(kernel, identity);
  if (!operation) throw new Error("Missing original fixture operation");
  return { kernel, operation, original, replacement, http, observations };
}

test("checking an original request first reconciles its retained replacement after a lost replacement broadcast reply", async () => {
  const app = await replacementFixture();
  const result = await reconcileBrowserOperation(app.kernel, app.operation);
  expect(result.status).toBe("replaced");
  expect(result.transactionHash).toBe(app.original.transaction_hash);
  expect(result.replacementTransactionHash).toBe(app.replacement.transaction_hash);
  expect(app.replacement.status).toBe("confirmed");
  expect(app.observations).toEqual(["2", "1"]);
  expect(app.http.filter(call => call.method === "eth_getTransactionByHash").map(call => call.params[0])).toEqual([app.replacement.transaction_hash, app.original.transaction_hash]);
  expect(app.http.filter(call => call.method === "eth_sendRawTransaction")).toHaveLength(0);
});

test("a failed replacement lookup still allows the original request to reconcile its own mined receipt", async () => {
  const app = await replacementFixture(true);
  const result = await reconcileBrowserOperation(app.kernel, app.operation);
  expect(result.status).toBe("confirmed");
  expect(result.transactionHash).toBe(app.original.transaction_hash);
  expect(result.replacementTransactionHash).toBeNull();
  expect(result.finality).toBe("finalized");
  expect(app.replacement.status).toBe("unknown");
  expect(app.observations).toEqual(["1"]);
  expect(app.http.filter(call => call.method === "eth_getTransactionByHash").map(call => call.params[0])).toEqual([app.replacement.transaction_hash, app.original.transaction_hash]);
});
