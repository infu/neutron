import { expect, test } from "bun:test";
import { getAddress, keccak256, stringToHex } from "viem";
import type { EvmAccount, EvmOperationResult, EvmOperationStatusRequest, EvmReceipt, EvmSendTransactionRequest, EvmTransactionResult, EvmWalletClient } from "neutron-tools/evm_wallet";
import { createStore, stable, type RecordRow } from "../src/store.ts";
import { attemptId, intentOf, latestRecord, requestId, runOperation, savedResult, stateOf, type RunOptions } from "../src/workflow.ts";
import { parseInput, type Plan } from "../src/plans.ts";
const owner = getAddress("0x1111111111111111111111111111111111111111"), contract = getAddress("0x2222222222222222222222222222222222222222");
const id = "ab".repeat(16), caller = { appId: "agent", installationUid: "17" };
const account: EvmAccount = { accountId: "main", address: owner, publicKey: "0x02" + "66".repeat(32), keyFingerprint: "0x" + "77".repeat(32), namespaceVersion: "1" };
const input = parseInput({ kind: "supply", chainId: "1", asset: contract, amount: "3000000000000000001" });
const receipt: EvmReceipt = { blockNumber: "21000001", blockHash: "0x" + "99".repeat(32), status: "success", gasUsed: "50000", effectiveGasPriceWei: "10000000", finality: "included", observedAtNs: "1800000000000000000", logs: [] };
function fixture(approvals = 2) {
  const rows = new Map<string, RecordRow>(), operations = new Map<string, EvmOperationResult>(), transactions = new Map<string, EvmTransactionResult>(), sends: EvmSendTransactionRequest[] = [], events: string[] = [];
  let now = 1800000000000, approved = 0, preparations = 0, selected = account, write = (_row: RecordRow) => {};
  const store = createStore({
    async querySelf(name: string, args: unknown[]) { if (name === "aave_get_v1") return structuredClone(rows.get(String(args[0])) ?? null); throw Error(name); },
    async updateSelf(name: string, args: unknown[]) {
      const input = args[0] as Record<string, string>, prior = rows.get(input.id!);
      if (name === "aave_begin_v1") {
        if (prior) { if (prior.input_json !== input.input_json || prior.summary !== input.summary) throw Error("Changed intent"); return structuredClone(prior); }
        const saved = { ...input, revision: "0", created_at: String(now), updated_at: String(now) } as RecordRow;
        rows.set(saved.id, saved); events.push("begin"); write(saved); return structuredClone(saved);
      }
      if (name === "aave_update_v1") {
        if (!prior) throw Error("Missing");
        if (prior.state_json === input.state_json && prior.phase === input.phase) return structuredClone(prior);
        if (prior.revision !== input.expected_revision) throw Error("Conflict");
        const saved = { ...prior, state_json: input.state_json!, phase: input.phase!, revision: String(BigInt(prior.revision) + 1n) };
        rows.set(saved.id, saved); events.push(saved.phase); write(saved); return structuredClone(saved);
      }
      throw Error(name);
    },
  } as unknown as Parameters<typeof createStore>[0]);
  const hash = (request: EvmSendTransactionRequest) => keccak256(stringToHex(request.requestId));
  const operation = (request: EvmSendTransactionRequest, status: EvmOperationResult["status"] = "submitted"): EvmOperationResult => ({ accountId: "main", chainId: request.chainId, requestId: request.requestId, operationId: "1", kind: "transaction", status, address: owner, transactionHash: ["submitted", "confirmed", "signed", "reverted"].includes(status) ? hash(request) : null, signature: null, reviewRevision: "1", message: null, receipt: status === "confirmed" ? receipt : null });
  const evidence = (request: EvmSendTransactionRequest, confirmed = false): EvmTransactionResult => ({ chainId: request.chainId, transactionHash: hash(request), walletRequestMatches: null, transaction: { from: owner, to: request.to, data: request.data, valueWei: request.valueWei, nonce: "0", blockNumber: confirmed ? receipt.blockNumber : null, blockHash: confirmed ? receipt.blockHash : null }, receipt: confirmed ? receipt : null, observedAtNs: receipt.observedAtNs, source: "evm_rpc" });
  let send = async (request: EvmSendTransactionRequest) => operation(request), statusError = "";
  const confirm = async () => { for (const [id, op] of operations) if (op.status === "submitted") { const request = sends.find((request) => request.requestId === id)!; operations.set(id, operation(request, "confirmed")); transactions.set(hash(request), evidence(request, true)); if (request.data !== "0x03") approved++; } };
  let wait = confirm;
  const wallet = {
    async accounts() { return { accounts: [selected] }; },
    async operationStatus(request: EvmOperationStatusRequest) { if (statusError) throw Error(statusError); expect(Object.keys(request).sort()).toEqual(["accountId", "chainId", "requestId"]); return structuredClone(operations.get(request.requestId) ?? { ...request, status: "not_found" }); },
    async transaction({ transactionHash }: { transactionHash: string }) { if (!transactions.has(transactionHash)) throw Error("RPC unavailable"); return structuredClone(transactions.get(transactionHash)); },
    async sendTransaction(request: EvmSendTransactionRequest) { sends.push(structuredClone(request)); events.push(`send:${request.data}`); const op = await send(request); operations.set(request.requestId, op); if (op.transactionHash && !transactions.has(op.transactionHash)) transactions.set(op.transactionHash, evidence(request, op.status === "confirmed")); return op; },
  } as unknown as EvmWalletClient;
  const prepare: NonNullable<RunOptions["prepare"]> = async (_wallet, selected, original) => {
    preparations++; expect(original).toEqual(input);
    const tx = { chainId: "1" as const, accountId: "main" as const, to: contract, valueWei: "0" };
    return { summary: "Fixture supply", chainId: "1", accountAddress: getAddress(selected.address), validUntil: String(Math.floor(now / 1000) + 1200), preview: {}, steps: [...Array.from({ length: Math.max(0, approvals - approved) }, (_, i) => ({ label: `Approve token ${i}`, kind: "approval" as const, transaction: { ...tx, data: `0x0${i + 1}` as `0x${string}` } })), { label: "Supply", kind: "transaction", transaction: { ...tx, data: "0x03" } }] } as Plan;
  };
  return { store, wallet, rows, operations, transactions, sends, events, operation, evidence, hash, confirm,
    run: (options: RunOptions = {}, origin: typeof caller | null = caller, agent = true) => runOperation(wallet, store, id, input, origin, agent, { now: () => now, wait: async () => wait(), prepare, ...options }),
    prepareCount: () => preparations, advance: () => { now += 1300000; }, sendWith: (f: typeof send) => { send = f; }, waitWith: (f: typeof wait) => { wait = f; }, writeWith: (f: typeof write) => { write = f; }, accountWith: (a: EvmAccount) => { selected = a; }, statusFails: (value: string) => { statusError = value; },
  };
}
test("all approvals precede the matching final receipt; repeated completion sends nothing", async () => {
  const f = fixture(), result = await f.run();
  expect(result.state).toBe("complete"); expect(result.steps.map((step) => step.status)).toEqual(["confirmed", "confirmed", "confirmed"]);
  expect(f.sends.map((request) => request.data)).toEqual(["0x01", "0x02", "0x03"]);
  expect(f.events.indexOf("step_0_requested")).toBeLessThan(f.events.indexOf("send:0x01"));
  expect(f.events.indexOf("step_1_confirmed")).toBeLessThan(f.events.indexOf("send:0x03"));
  expect((await f.run()).state).toBe("complete"); expect(f.sends).toHaveLength(3);
});
test("crash after durable dispatch resumes identical ID after reload", async () => {
  const f = fixture(0), abort = new AbortController();
  f.writeWith((row) => { if (row.phase === "step_0_requested") abort.abort(Error("Closed")); });
  await expect(f.run({ signal: abort.signal })).rejects.toThrow("Closed"); expect(f.sends).toHaveLength(0);
  const saved = stateOf((await f.store.get(id))!); expect(saved.steps[0]!.unresolved).toBe(true);
  f.writeWith(() => {}); expect((await f.run()).state).toBe("complete"); expect(f.sends[0]).toEqual(saved.steps[0]!.request);
});
test("lost reply reuses ID and blocks unsigned renewal while dispatch is ambiguous", async () => {
  const f = fixture(0); f.sendWith(async () => { throw Error("Lost reply"); });
  expect((await f.run()).state).toBe("pending"); expect((await f.run()).state).toBe("pending"); expect(f.sends[0]).toEqual(f.sends[1]);
  f.advance(); expect((await f.run()).state).toBe("pending"); expect(f.rows.size).toBe(1); expect(f.sends).toHaveLength(2);
  const sent = f.sends[0]!; f.operations.set(sent.requestId, f.operation(sent, "confirmed")); f.transactions.set(f.hash(sent), f.evidence(sent, true));
  expect((await f.run()).state).toBe("complete");
});
test("interrupted preparation retains uncertainty and resumes the exact Wallet request", async () => {
  const f = fixture(0);
  f.sendWith(async request => { f.operations.set(request.requestId, f.operation(request, "preparing")); throw Error("Browser closed during simulation"); });
  expect((await f.run()).state).toBe("pending");
  const original = structuredClone(f.sends[0]!);
  expect((await f.run({ execute: false })).state).toBe("pending");
  expect(stateOf((await f.store.get(id))!).steps[0]!.unresolved).toBe(true);
  expect(f.sends).toHaveLength(1);
  f.waitWith(async () => { throw Error("Unsigned preparation cannot complete by polling"); });
  f.sendWith(async request => f.operation(request, "confirmed"));
  expect((await f.run()).state).toBe("complete");
  expect(f.sends).toEqual([original, original]); expect(f.rows.size).toBe(1); expect(f.prepareCount()).toBe(1);
});
test("an explicit preparing reply yields and can continue without indefinite polling", async () => {
  const f = fixture(0);
  f.sendWith(async request => f.operation(request, "preparing"));
  f.waitWith(async () => { throw Error("Unsigned preparation cannot complete by polling"); });
  expect((await f.run()).state).toBe("review");
  expect(stateOf((await f.store.get(id))!).steps[0]!.unresolved).toBe(false);
  await f.run({ execute: false }); expect(f.sends).toHaveLength(1);
  f.sendWith(async request => f.operation(request, "confirmed"));
  expect((await f.run()).state).toBe("complete"); expect(f.sends[1]).toEqual(f.sends[0]);
});
test.each([false, true])("expired preparing retains its original signable request; old cleared marker=%s", async previouslyCleared => {
  const f = fixture(0);
  f.sendWith(async request => { f.operations.set(request.requestId, f.operation(request, "preparing")); throw Error("Lost reply"); });
  await f.run();
  if (previouslyCleared) {
    const row = (await f.store.get(id))!, state = stateOf(row);
    state.steps[0]!.unresolved = false; state.steps[0]!.operation = f.operation(f.sends[0]!, "preparing");
    await f.store.update(row, state, "step_0_preparing");
  }
  f.advance(); f.waitWith(async () => { throw Error("Expired preparation cannot complete by polling"); });
  const result = await f.run();
  expect(result.state).toBe(previouslyCleared ? "review" : "pending");
  expect(result.message).toContain(previouslyCleared ? "Wallet Activity" : "unresolved");
  expect(stateOf((await f.store.get(id))!).steps[0]!.unresolved).toBe(!previouslyCleared);
  expect(f.rows.size).toBe(1); expect(f.prepareCount()).toBe(1); expect(f.sends).toHaveLength(1);
});
test("an expired undispatched quote refreshes and retains the original input and caller", async () => {
  const f = fixture(1), abort = new AbortController();
  f.writeWith((row) => { if (row.phase === "ready") abort.abort(Error("Closed before dispatch")); });
  await expect(f.run({ signal: abort.signal })).rejects.toThrow("Closed before dispatch");
  expect(f.sends).toHaveLength(0); f.advance(); f.writeWith(() => {});
  expect((await f.run()).state).toBe("complete"); expect(f.rows.size).toBe(2);
  const next = (await latestRecord(f.store, id))!; expect(next.id).toBe(attemptId(id, "1")); expect(intentOf(next).input).toEqual(input); expect(intentOf(next).caller).toEqual(caller);
});
test("expired prepared lending requests remain original and signable without creating duplicate attempts", async () => {
  const f = fixture(0); f.sendWith(async (request) => f.operation(request, "prepared"));
  await f.run(); f.advance();
  for (let count = 0; count < 2; count++) {
    const result = await f.run(); expect(result.state).toBe("review"); expect(result.message).toContain("Wallet Activity");
  }
  expect((await f.run({ execute: false })).message).toContain("Wallet Activity");
  expect(f.rows.size).toBe(1); expect(f.sends).toHaveLength(1); expect(f.prepareCount()).toBe(1);
  const original = f.sends[0]!;
  f.operations.set(original.requestId, f.operation(original, "confirmed")); f.transactions.set(f.hash(original), f.evidence(original, true));
  expect((await f.run()).state).toBe("complete"); expect(f.sends).toHaveLength(1);
});
test("declining an expired original review stops the saved operation without renewing the rejection", async () => {
  const f = fixture(0); f.sendWith(async (request) => f.operation(request, "prepared")); await f.run(); f.advance();
  const original = f.sends[0]!; f.operations.set(original.requestId, f.operation(original, "rejected"));
  expect((await f.run()).state).toBe("stopped"); expect(f.rows.size).toBe(1); expect(f.sends).toHaveLength(1);
});

async function legacySuccessor(f: ReturnType<typeof fixture>) {
  const previous = (await f.store.get(id))!, state = stateOf(previous), nextId = attemptId(id, "1");
  await f.store.update(previous, { ...state, successor: nextId }, "renewing");
  const nextState = { ...state, successor: null, steps: state.steps.map((step, index) => ({ ...step, request: { ...step.request, requestId: requestId(nextId, index) }, dispatched: false, unresolved: false, operation: null, evidence: null })) };
  return f.store.begin({ id: nextId, root_id: id, input_json: stable({ ...intentOf(previous), attempt: "1" }), summary: previous.summary, state_json: stable(nextState), phase: "ready" });
}
test("restored legacy successors cannot dispatch while the original lending review remains open", async () => {
  const f = fixture(0); f.sendWith(async (request) => f.operation(request, "prepared")); await f.run(); await legacySuccessor(f);
  const result = await f.run(); expect(result.state).toBe("review"); expect(result.recordId).toBe(id); expect(result.message).toContain("earlier attempt");
  expect(f.sends).toHaveLength(1); expect(f.rows.size).toBe(2);
  const original = f.sends[0]!;
  f.operations.set(original.requestId, f.operation(original, "confirmed")); f.transactions.set(f.hash(original), f.evidence(original, true));
  const completedOriginal = await f.run(); expect(completedOriginal.state).toBe("stopped"); expect(completedOriginal.message).toContain("already completed");
  expect(f.sends).toHaveLength(1); expect((await latestRecord(f.store, id))!.id).toBe(attemptId(id, "1"));
  expect(await savedResult(f.store, id)).toEqual(completedOriginal);
});
test("legacy duplicate completions remain visible without another transaction", async () => {
  const f = fixture(0); f.sendWith(async (request) => f.operation(request, "prepared")); await f.run();
  const next = await legacySuccessor(f), state = stateOf(next), original = f.sends[0]!, successor = state.steps[0]!.request;
  for (const request of [original, successor]) {
    f.operations.set(request.requestId, f.operation(request, "confirmed")); f.transactions.set(f.hash(request), f.evidence(request, true));
  }
  state.steps[0] = { request: successor, dispatched: true, unresolved: false, operation: f.operation(successor, "confirmed"), evidence: f.evidence(successor, true) };
  await f.store.update(next, state, "complete");
  const result = await f.run(); expect(result.state).toBe("stopped"); expect(result.message).toContain("both an earlier attempt and its successor completed"); expect(f.sends).toHaveLength(1);
  expect(await savedResult(f.store, id)).toEqual(result);
});
test("legacy successors resume after an original approval confirms without duplicating the lending action", async () => {
  const f = fixture(1); f.sendWith(async (request) => f.operation(request, "prepared")); await f.run(); await legacySuccessor(f);
  expect((await f.run()).state).toBe("review"); expect(f.sends).toHaveLength(1);
  const original = f.sends[0]!; f.operations.set(original.requestId, f.operation(original, "submitted")); await f.confirm();
  f.sendWith(async request => f.operation(request));
  expect((await f.run()).state).toBe("complete"); expect(f.sends.filter(request => request.data === "0x03")).toHaveLength(1);
});
test("confirmed prerequisites survive expiry and status alone never requests a fresh review", async () => {
  const f = fixture(1); let first = true;
  f.waitWith(async () => { await f.confirm(); if (first) { first = false; f.advance(); } });
  expect((await f.run()).state).toBe("complete"); expect(f.sends.map((request) => request.data)).toEqual(["0x01", "0x03"]); expect(f.prepareCount()).toBe(2);
  const g = fixture(0); g.sendWith(async (request) => g.operation(request, "prepared")); await g.run(); g.advance();
  await g.run({ execute: false }); expect(g.sends).toHaveLength(1); expect(g.rows.size).toBe(1);
});
test("changed caller, inputs or signing identity cannot take over saved work", async () => {
  const f = fixture(0); f.sendWith(async (request) => f.operation(request, "prepared")); await f.run();
  await expect(f.run({}, null, false)).rejects.toThrow("original inputs and caller");
  await expect(f.run({}, { ...caller, installationUid: "18" })).rejects.toThrow("original inputs and caller");
  f.accountWith({ ...account, keyFingerprint: "0x" + "88".repeat(32) }); await expect(f.run()).rejects.toThrow("signing identity changed"); expect(f.sends).toHaveLength(1);
});
test.each(["rejected", "failed", "reverted"] as const)("%s cannot be reported as completed", async (status) => {
  const f = fixture(0); f.sendWith(async (request) => { const op = f.operation(request, status); if (status === "reverted") { op.receipt = { ...receipt, status: "reverted" }; f.transactions.set(f.hash(request), { ...f.evidence(request, true), receipt: op.receipt }); } return op; });
  expect((await f.run()).state).toBe("stopped"); expect(f.sends).toHaveLength(1);
});
test("successful receipt with different calldata is a replacement, not completion", async () => {
  const f = fixture(0); f.sendWith(async (request) => { const evidence = f.evidence(request, true); evidence.transaction!.data = "0x"; f.transactions.set(f.hash(request), evidence); return f.operation(request, "confirmed"); });
  expect((await f.run()).state).toBe("stopped");
});
test("same-payload speedup is accepted only through the original operation link", async () => {
  const f = fixture(0), replacementHash = "0x" + "55".repeat(32);
  f.sendWith(async (request) => { f.transactions.set(replacementHash, { ...f.evidence(request, true), transactionHash: replacementHash }); return { ...f.operation(request, "replaced"), transactionHash: f.hash(request), replacementTransactionHash: replacementHash }; });
  const result = await f.run(); expect(result.state).toBe("complete"); expect(result.transactionHash).toBe(replacementHash);
});
test("RPC failure retains saved progress without extra sends or false success", async () => {
  const f = fixture(0); f.sendWith(async (request) => f.operation(request, "prepared")); await f.run(); f.statusFails("RPC offline");
  await expect(f.run()).rejects.toThrow("RPC offline"); expect(f.sends).toHaveLength(1); expect(stateOf((await f.store.get(id))!).steps[0]!.request.requestId).toBe(requestId(id, 0));
});
test("concurrent continuations retain one durable identity and Wallet deduplicates it", async () => {
  const f = fixture(0); const results = await Promise.all([f.run(), f.run()]);
  expect(results.every((result) => result.state === "complete")).toBe(true); expect(f.rows.size).toBe(1); expect(new Set(f.sends.map((request) => request.requestId)).size).toBe(1);
});
test("a reorganization removes prior completion until its transaction is observed again", async () => {
  const f = fixture(0); await f.run(); const request = f.sends[0]!; f.operations.set(request.requestId, f.operation(request)); f.transactions.set(f.hash(request), f.evidence(request));
  expect((await f.run({ execute: false })).state).toBe("pending"); expect(f.sends).toHaveLength(1);
});
