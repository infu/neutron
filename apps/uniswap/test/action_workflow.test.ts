import { expect, test } from "bun:test";
import { getAddress, keccak256, stringToHex } from "viem";
import type { EvmAccount, EvmOperationResult, EvmOperationStatusRequest, EvmReceipt, EvmSendTransactionRequest, EvmTransactionResult, EvmWalletClient } from "neutron-tools/evm_wallet";
import { createActionStore } from "../src/action_store.ts";
import { actionAttemptId, actionInvocation, actionResult, latestAction, parseActionIntent, parseActionState, reconcileAction, runAction, type ActionEnvelope, type ActionOptions, type PrepareAction } from "../src/action_workflow.ts";
import { positionManager, V3_POSITION_MANAGER } from "../src/positions.ts";

const address = getAddress("0x1111111111111111111111111111111111111111"), contract = getAddress("0x2222222222222222222222222222222222222222");
const caller = { appId: "agent", installationUid: "17" };
const account: EvmAccount = { accountId: "main", address, publicKey: `0x02${"66".repeat(32)}`, keyFingerprint: `0x${"77".repeat(32)}`, namespaceVersion: "1" };
const envelope: ActionEnvelope = { operationId: "ab".repeat(16), kind: "swap", chainId: "1", accountId: "main", input: { amountIn: "3000000", recipient: address } };
const receipt: EvmReceipt = { blockNumber: "21000001", blockHash: `0x${"99".repeat(32)}`, status: "success", gasUsed: "50000", effectiveGasPriceWei: "10000000", finality: "included", observedAtNs: "1800000000000000000", logs: [] };

function fixture(approvals = 2, requested = envelope) {
  const rows = new Map<string, Record<string, string>>(), operations = new Map<string, EvmOperationResult>(), transactions = new Map<string, EvmTransactionResult>();
  const sends: EvmSendTransactionRequest[] = [], events: string[] = [], tracked: { chain_id: string; protocol: string; token_id: string }[] = [];
  let now = 1_800_000_000_000, validity = 1200, preparations = 0, approved = 0, selected = account;
  let afterWrite = (_row: Record<string, string>) => {};
  const kernel = {
    async querySelf(method: string, args: unknown[]) {
      if (method === "uniswap_action_get_v1") return structuredClone(rows.get(String(args[0])) ?? null);
      if (method === "uniswap_position_refs_v1") return structuredClone(tracked.filter((item) => item.chain_id === args[0]));
      if (method === "uniswap_action_page_v1") return { rows: [...rows.values()].map(({ input_json: _input, state_json: _state, ...summary }) => summary), next_cursor: null };
      throw new Error(`Unexpected query ${method}`);
    },
    async updateSelf(method: string, args: unknown[]) {
      const input = args[0] as Record<string, string>;
      if (method === "uniswap_position_track_v1") {
        const value = { chain_id: input.chain_id!, protocol: input.protocol!, token_id: input.token_id! };
        if (!tracked.some((item) => JSON.stringify(item) === JSON.stringify(value))) tracked.push(value);
        return value;
      }
      if (method === "uniswap_action_begin_v1") {
        const existing = rows.get(input.id!);
        if (existing) {
          if (existing.input_json !== input.input_json || existing.summary !== input.summary) throw new Error("Different immutable intent");
          return structuredClone(existing);
        }
        const row: Record<string, string> = { ...input, revision: "0", created_at: String(now * 1e6), updated_at: String(now * 1e6) };
        rows.set(row.id!, row); events.push("persist:begin"); afterWrite(row); return structuredClone(row);
      }
      if (method !== "uniswap_action_update_v1") throw new Error(`Unexpected update ${method}`);
      const current = rows.get(input.id!)!;
      if (input.state_json === current.state_json && input.phase === current.phase) return structuredClone(current);
      if (current.revision !== input.expected_revision) throw new Error("Action revision conflict");
      const row: Record<string, string> = { ...current, state_json: input.state_json!, phase: input.phase!, revision: String(BigInt(current.revision!) + 1n), updated_at: String(now * 1e6) };
      rows.set(row.id!, row); events.push(`persist:${row.phase}`); afterWrite(row); return structuredClone(row);
    },
  };
  const store = createActionStore(kernel as unknown as Parameters<typeof createActionStore>[0]);
  const hash = (request: EvmSendTransactionRequest) => keccak256(stringToHex(request.requestId));
  function operation(request: EvmSendTransactionRequest, status: EvmOperationResult["status"] = "submitted"): EvmOperationResult {
    return { requestId: request.requestId, accountId: request.accountId, chainId: request.chainId, operationId: "1", kind: "transaction", status, address, transactionHash: ["submitted", "confirmed", "signed"].includes(status) ? hash(request) : null, signature: null, reviewRevision: "1", message: null, receipt: status === "confirmed" ? receipt : null };
  }
  function evidence(request: EvmSendTransactionRequest, confirmed = false): EvmTransactionResult {
    return { chainId: request.chainId, transactionHash: hash(request), walletRequestMatches: null,
      transaction: { from: address, to: request.to, data: request.data, valueWei: request.valueWei, nonce: "0", blockNumber: confirmed ? receipt.blockNumber : null, blockHash: confirmed ? receipt.blockHash : null },
      receipt: confirmed ? receipt : null, observedAtNs: "1800000000000000000", source: "evm_rpc" };
  }
  let onSend = async (request: EvmSendTransactionRequest) => operation(request);
  const confirm = async () => {
    for (const [id, op] of operations) if (op.status === "submitted") {
      const request = sends.find((sent) => sent.requestId === id)!;
      operations.set(id, { ...op, status: "confirmed", receipt }); transactions.set(hash(request), evidence(request, true));
      if (request.data !== "0x03") approved += 1;
    }
  };
  let onWait = confirm;
  const wallet = {
    async accounts() { events.push("wallet:accounts"); return { accounts: [selected] }; },
    async operationStatus(request: EvmOperationStatusRequest) { events.push("wallet:status"); return structuredClone(operations.get(request.requestId) ?? { ...request, status: "not_found" }); },
    async transaction({ transactionHash }: { transactionHash: string }) {
      events.push("wallet:transaction");
      const result = transactions.get(transactionHash); if (!result) throw new Error("Missing transaction fixture"); return structuredClone(result);
    },
    async sendTransaction(request: EvmSendTransactionRequest) {
      sends.push(structuredClone(request)); events.push(`wallet:send:${request.data}`);
      const result = await onSend(request); operations.set(request.requestId, result);
      if (result.transactionHash && !transactions.has(result.transactionHash)) transactions.set(result.transactionHash, evidence(request, result.status === "confirmed"));
      return result;
    },
  } as unknown as EvmWalletClient;
  const prepare: PrepareAction = async ({ envelope: input, account: pinned, now: clock }) => {
    preparations += 1; events.push("prepare");
    expect(input).toEqual(requested); expect(pinned).toEqual(account);
    return { chainId: input.chainId, accountId: input.accountId, accountAddress: pinned.address, deadline: String(Math.floor(clock() / 1000) + validity), summary: "Perform requested action", details: { amountIn: input.input.amountIn ?? "0" },
      steps: [
        ...Array.from({ length: Math.max(0, approvals - approved) }, (_, i) => ({ label: `Token approval ${i + 1}`, kind: "approval" as const, transaction: { chainId: input.chainId, accountId: input.accountId, to: contract, value: "0", data: `0x0${i + 1}` as `0x${string}` } })),
        { label: "Final action", kind: "transaction", transaction: { chainId: input.chainId, accountId: input.accountId, to: requested.kind === "liquidity" ? positionManager(requested.chainId, requested.input.protocol === "v4" ? "v4" : "v3") : contract, value: "0", data: "0x03" } },
      ] };
  };
  const options: ActionOptions = { now: () => now, wait: async () => { events.push("wait"); await onWait(); } };
  return {
    store, wallet, rows, operations, transactions, sends, events, tracked, prepare, options, operation, evidence, hash, confirm,
    preparations: () => preparations,
    advance(ms: number) { now += ms; }, validity(seconds: number) { validity = seconds; },
    sendWith(callback: typeof onSend) { onSend = callback; }, waitWith(callback: typeof onWait) { onWait = callback; },
    writeWith(callback: typeof afterWrite) { afterWrite = callback; }, accountWith(value: EvmAccount) { selected = value; },
    run(extra: ActionOptions = {}, origin = caller, agentMode = true) { return runAction(wallet, store, requested, origin, agentMode, prepare, { ...options, ...extra }); },
  };
}

function liquidityGasFixture(approvals = 0, protocol: "v3" | "v4" = "v3") {
  const input: ActionEnvelope = { ...envelope, kind: "liquidity", input: protocol === "v3" ? { operation: "increase", protocol, tokenId: "1362740", maxAmountA: "300000", maxAmountB: "120000000000000" } : { operation: "collect", protocol, tokenId: "396714" } };
  const f = fixture(approvals, input); let estimates = 0;
  f.wallet.estimateTransaction = async request => {
    estimates += 1; f.events.push("wallet:estimate");
    return { ...request, address, status: "available", gasLimit: "231999", gasPriceWei: "10", baseFeePerGasWei: "9", maxPriorityFeePerGasWei: "1", maxFeePerGasWei: "19", estimatedFeeWei: "2319990", maximumFeeWei: "4407981", blockNumber: "25934514", observedAtNs: "1788890000000000000", feeBasis: "base_fee_plus_priority", postingCosts: "not_applicable", reasons: [], source: "evm_rpc" };
  };
  return { ...f, input, estimates: () => estimates };
}

test("the complete action runs every approval in order and verifies the final transaction receipt", async () => {
  const f = fixture(), result = await f.run();
  expect(result.state).toBe("complete"); expect(result.steps.map((step) => step.status)).toEqual(["confirmed", "confirmed", "confirmed"]);
  expect(f.sends.map((request) => request.data)).toEqual(["0x01", "0x02", "0x03"]);
  expect(f.events.indexOf("persist:step_0_confirmed")).toBeLessThan(f.events.indexOf("wallet:send:0x02"));
  expect(f.events.indexOf("persist:step_1_confirmed")).toBeLessThan(f.events.indexOf("wallet:send:0x03"));
  expect(f.events.filter((event) => event === "wait")).toHaveLength(3);
  expect(result.transactionHash).toBe(f.hash(f.sends[2]!));
  const page = await f.store.page(); expect(page.rows[0]?.operationId).toBe(envelope.operationId); expect(page.rows[0]?.humanOwned).toBe(false);
  expect(await f.run()).toEqual(result); expect(f.sends).toHaveLength(3);
});

test("resuming an included action rechecks a reorganized final receipt without sending again", async () => {
  const f = fixture(0);
  expect((await f.run()).state).toBe("complete");
  const request = f.sends[0]!;
  // The receipt was included, not finalized. The Wallet and its independent
  // transaction read now report that the same transaction is pending again.
  f.operations.set(request.requestId, f.operation(request, "submitted"));
  f.transactions.set(f.hash(request), f.evidence(request));
  const cancel = new AbortController();
  f.waitWith(async () => { cancel.abort(new Error("Waiting for reinclusion")); cancel.signal.throwIfAborted(); });
  await expect(f.run({ signal: cancel.signal })).rejects.toThrow("Waiting for reinclusion");
  const pending = actionResult((await f.store.get(envelope.operationId))!);
  expect(pending.state).toBe("pending"); expect(pending.steps[0]?.status).toBe("submitted");
  expect(f.sends).toHaveLength(1);
  await f.confirm();
  expect((await f.run()).state).toBe("complete"); expect(f.sends).toHaveLength(1);
});

test("a crash after persisting requested but before send resumes the same exact Wallet request", async () => {
  const f = fixture(0), abort = new AbortController();
  f.writeWith((row) => { if (row.phase === "step_0_requested") abort.abort(new Error("Page closed")); });
  await expect(f.run({ signal: abort.signal })).rejects.toThrow("Page closed");
  expect(f.sends).toHaveLength(0);
  const saved = parseActionState((await f.store.get(envelope.operationId))!);
  expect(saved.steps[0]?.unresolvedDispatch).toBe(true);
  f.writeWith(() => {});
  expect((await f.run()).state).toBe("complete"); expect(f.sends).toHaveLength(1);
  expect(f.sends[0]).toEqual(saved.steps[0]?.request); expect(f.preparations()).toBe(1);
});

test("a lost reply retries the original ID while valid and never renews an expired ambiguous dispatch", async () => {
  const f = fixture(0);
  f.sendWith(async () => { throw new Error("Reply lost"); });
  expect((await f.run()).state).toBe("pending");
  expect((await f.run()).state).toBe("pending");
  expect(f.sends[0]).toEqual(f.sends[1]); expect(f.preparations()).toBe(1);
  f.advance(1_300_000);
  expect((await f.run()).state).toBe("pending"); expect(f.sends).toHaveLength(2); expect(f.rows.size).toBe(1);
  const request = f.sends[0]!;
  f.operations.set(request.requestId, f.operation(request, "confirmed")); f.transactions.set(f.hash(request), f.evidence(request, true));
  expect((await f.run()).state).toBe("complete"); expect(f.sends).toHaveLength(2);
});

test("an old prepared status poll cannot erase a later unresolved dispatch and refresh its expired intent", async () => {
  const f = fixture(0);
  f.sendWith(async (request) => f.operation(request, "prepared"));
  expect((await f.run()).state).toBe("review");
  f.sendWith(async () => { throw new Error("Reply lost after another review"); });
  expect((await f.run()).state).toBe("pending");
  f.advance(1_300_000);
  expect((await f.run()).state).toBe("pending");
  expect(f.rows.size).toBe(1); expect(f.preparations()).toBe(1); expect(f.sends).toHaveLength(2);
  expect(parseActionState((await f.store.get(envelope.operationId))!).steps[0]?.unresolvedDispatch).toBe(true);
});

test("expired known-unsigned plans freeze the predecessor and reuse already confirmed allowances", async () => {
  const f = fixture(1); f.validity(10);
  f.waitWith(async () => { await f.confirm(); f.advance(20_000); f.validity(1200); });
  const result = await f.run(), successor = actionAttemptId(envelope.operationId, "1");
  expect(result.state).toBe("complete"); expect(result.recordId).toBe(successor);
  expect(f.sends.map((request) => request.data)).toEqual(["0x01", "0x03"]);
  const previous = (await f.store.get(envelope.operationId))!;
  expect(previous.phase).toBe("superseded"); expect(parseActionState(previous).successor).toBe(successor);
  expect(parseActionIntent((await latestAction(f.store, envelope.operationId))!).envelope).toEqual(envelope);
  expect(f.preparations()).toBe(2);
  expect((await f.run()).recordId).toBe(successor); expect(f.sends).toHaveLength(2);
});

test("changed input, caller, execution mode and signing identity cannot resume a saved action", async () => {
  const f = fixture(0); await f.run(); const calls = f.events.length;
  await expect(runAction(f.wallet, f.store, { ...envelope, input: { ...envelope.input, amountIn: "6000000" } }, caller, true, f.prepare)).rejects.toThrow("different inputs");
  await expect(f.run({}, { ...caller, installationUid: "18" })).rejects.toThrow("another caller");
  await expect(runAction(f.wallet, f.store, envelope, null, false, f.prepare)).rejects.toThrow("another caller");
  expect(f.events).toHaveLength(calls);
  f.accountWith({ ...account, namespaceVersion: "2" }); await expect(f.run()).rejects.toThrow("signing identity changed");
  expect(f.sends).toHaveLength(1);
});

test("successful approval alone cannot complete an action whose final transaction is rejected", async () => {
  const f = fixture(1); f.sendWith(async (request) => f.operation(request, request.data === "0x03" ? "rejected" : "submitted"));
  const result = await f.run(); expect(result.state).toBe("stopped"); expect(result.steps.map((step) => step.status)).toEqual(["confirmed", "rejected"]);
  expect(result.transactionHash).toBeNull(); expect(f.sends).toHaveLength(2);
});

test.each(["success", "reverted"] as const)("an independently observed %s receipt overrides stale pending prose and tracking state", async (outcome) => {
  const f = fixture(1);
  f.sendWith(async (request) => {
    if (request.data !== "0x03") return f.operation(request);
    const evidence = f.evidence(request, true);
    evidence.receipt = { ...receipt, status: outcome, finality: "safe" };
    f.transactions.set(f.hash(request), evidence);
    return { ...f.operation(request), message: "Transaction is known to the provider and awaits a receipt." };
  });
  const result = await f.run();
  expect(result.state).toBe(outcome === "success" ? "complete" : "stopped");
  expect(result.steps.map((step) => step.status)).toEqual(["confirmed", outcome === "success" ? "confirmed" : "reverted"]);
  expect(result.steps[1]?.receipt).toEqual({ status: outcome, blockNumber: receipt.blockNumber, finality: "safe" });
  expect(result.message).toContain(outcome === "success" ? "succeeded" : "reverted");
  expect(result.message).toContain(receipt.blockNumber);
  expect(result.message).toContain("safe");
  expect(result.message).not.toContain("awaits a receipt");
  // Cancellation can race the persist that first observed a terminal receipt.
  // The same saved evidence must not become pending in that catch path or history.
  const saved = (await f.store.get(envelope.operationId))!;
  expect(actionResult(saved, "pending", "Tracking paused")).toEqual(result);
  expect(actionResult(saved)).toEqual(result);
  expect(f.sends).toHaveLength(2);
  expect(result.positionTokenIds).toEqual([]);
});

test("a claimed successful receipt with different transaction calldata stays incomplete", async () => {
  const f = fixture(0);
  f.sendWith(async (request) => {
    const evidence = f.evidence(request, true); evidence.transaction!.data = "0xdead"; f.transactions.set(f.hash(request), evidence);
    return f.operation(request, "confirmed");
  });
  const result = await f.run(); expect(result.state).toBe("stopped"); expect(result.message).toContain("does not execute the saved action");
});

test("authenticated replacements complete only when their sender, destination, data and value match", async () => {
  for (const matching of [true, false]) {
    const f = fixture(0), replacementHash = `0x${"88".repeat(32)}`;
    f.sendWith(async (request) => {
      const replacement = f.evidence(request, true); replacement.transactionHash = replacementHash;
      if (!matching) replacement.transaction!.to = address;
      f.transactions.set(replacementHash, replacement);
      return { ...f.operation(request), status: "replaced", replacementTransactionHash: replacementHash };
    });
    const result = await f.run(); expect(result.state).toBe(matching ? "complete" : "stopped"); expect(result.transactionHash).toBe(replacementHash);
  }
});

test("confirmed NFT mint receipts retain discoverable position IDs without indexer availability", async () => {
  const input: ActionEnvelope = { ...envelope, kind: "liquidity", input: { operation: "mint", protocol: "v3" } }, f = fixture(0, input);
  f.sendWith(async (request) => {
    const evidence = f.evidence(request, true);
    evidence.receipt = { ...receipt, logs: [{ address: V3_POSITION_MANAGER, data: "0x", logIndex: "0", topics: [keccak256(stringToHex("Transfer(address,address,uint256)")), `0x${"0".repeat(64)}`, `0x${address.slice(2).padStart(64, "0")}`, `0x${(1234n).toString(16).padStart(64, "0")}`] }] };
    f.transactions.set(f.hash(request), evidence); return f.operation(request, "confirmed");
  });
  const result = await f.run(); expect(result.state).toBe("complete"); expect(result.positionTokenIds).toEqual(["1234"]);
  expect(await f.store.positionRefs("1")).toEqual([{ chainId: "1", protocol: "v3", tokenId: "1234" }]);
  expect(actionResult((await f.store.get(input.operationId))!).positionTokenIds).toEqual(["1234"]);
  await f.run(); expect(f.tracked).toHaveLength(1);
});

test("pause is forwarded to the active public Wallet review and leaves the exact dispatch recoverable", async () => {
  const f = fixture(0), cancellation = new AbortController();
  f.wallet.sendTransaction = async (_request, options) => {
    expect(options?.signal).toBe(cancellation.signal);
    cancellation.abort(new Error("Owner paused the action")); options?.signal?.throwIfAborted();
    throw new Error("Unreachable");
  };
  await expect(f.run({ signal: cancellation.signal })).rejects.toThrow("Owner paused the action");
  const saved = parseActionState((await f.store.get(envelope.operationId))!);
  expect(saved.steps[0]?.unresolvedDispatch).toBe(true); expect(saved.successor).toBeNull();
});

test("concurrent continuations keep identical deterministic requests and preserve later CAS progress", async () => {
  const f = fixture(1);
  const results = await Promise.all([f.run(), f.run()]);
  expect(results.every((result) => result.state === "complete")).toBe(true);
  expect(new Set(f.sends.map((request) => request.requestId)).size).toBe(2);
  for (const request of f.sends) expect(f.sends.filter((item) => item.requestId === request.requestId).every((item) => JSON.stringify(item) === JSON.stringify(request))).toBe(true);
  expect(parseActionState((await f.store.get(envelope.operationId))!).steps.every((step) => step.operation?.status === "confirmed")).toBe(true);
});

test("receipt observations explicitly omit unrelated log payloads instead of duplicating them in self-call metadata", async () => {
  const f = fixture(0), largeData = `0x${"ab".repeat(40_000)}`;
  const largeReceipt = { ...receipt, logs: [{ address: contract, topics: [], data: largeData, logIndex: "0" }] };
  f.sendWith(async (request) => {
    const evidence = f.evidence(request, true); evidence.receipt = largeReceipt; f.transactions.set(f.hash(request), evidence);
    return { ...f.operation(request, "confirmed"), receipt: largeReceipt };
  });
  expect((await f.run()).state).toBe("complete");
  const record = (await f.store.get(envelope.operationId))!, saved = parseActionState(record).steps[0]!;
  expect(saved.receiptLogsFiltered).toBe(true); expect(saved.operationReceiptLogsOmitted).toBe(1); expect(saved.evidenceReceiptLogsOmitted).toBe(1);
  expect(saved.operation?.receipt?.logs).toEqual([]); expect(saved.evidence?.receipt?.logs).toEqual([]);
  expect(record.state_json).not.toContain(largeData);
});


test.each([0, 1])("interrupted Wallet preparation with %i approvals resumes its exact request before expiry", async approvals => {
  const f = fixture(approvals);
  f.sendWith(async request => { f.operations.set(request.requestId, f.operation(request, "preparing")); throw new Error("Reply lost during Wallet simulation"); });
  expect((await f.run()).state).toBe("pending");
  const first = structuredClone(f.sends[0]!);
  expect(parseActionState((await f.store.get(envelope.operationId))!).steps[0]!.unresolvedDispatch).toBe(true);
  f.sendWith(async request => f.operation(request, "confirmed"));
  expect((await f.run()).state).toBe("complete");
  expect(f.sends[1]).toEqual(first); expect(f.sends).toHaveLength(approvals + 2);
  expect(f.preparations()).toBe(1); expect(f.rows.size).toBe(1);
});

test("a returned preparing operation yields continuation and resumes the same Wallet request", async () => {
  const f = fixture(0);
  f.sendWith(async request => f.operation(request, "preparing"));
  expect((await f.run()).state).toBe("review"); expect(f.sends).toHaveLength(1);
  f.sendWith(async request => f.operation(request, "confirmed"));
  expect((await f.run()).state).toBe("complete"); expect(f.sends).toHaveLength(2);
  expect(f.sends[1]).toEqual(f.sends[0]); expect(f.preparations()).toBe(1);
});

test.each([false, true])("expired preparing observation cannot renew an uncertain action, released marker cleared=%s", async releasedMarkerCleared => {
  const f = fixture(0);
  f.sendWith(async request => { f.operations.set(request.requestId, f.operation(request, "preparing")); throw new Error("Wallet response lost"); });
  expect((await f.run()).state).toBe("pending");
  if (releasedMarkerCleared) {
    const row = f.rows.get(envelope.operationId)!;
    const state = JSON.parse(row.state_json!);
    state.steps[0].unresolvedDispatch = false; state.steps[0].operation = f.operation(f.sends[0]!, "preparing");
    row.state_json = JSON.stringify(state); row.phase = "step_0_preparing";
  }
  f.advance(1_300_000);
  expect((await f.run()).state).toBe("pending");
  expect(f.sends).toHaveLength(1); expect(f.preparations()).toBe(1); expect(f.rows.size).toBe(1);
  const state = parseActionState((await f.store.get(envelope.operationId))!);
  expect(state.steps[0]!.unresolvedDispatch).toBe(!releasedMarkerCleared);
  expect(state.successor).toBeNull();
  const request = f.sends[0]!;
  f.operations.set(request.requestId, f.operation(request, "confirmed")); f.transactions.set(f.hash(request), f.evidence(request, true));
  expect((await f.run()).state).toBe("complete"); expect(f.sends).toHaveLength(1);
});

test("receipt-only reconciliation recovers an interrupted mint without invoking Wallet recovery or sending again", async () => {
  const input: ActionEnvelope = { ...envelope, kind: "liquidity", input: { operation: "mint", protocol: "v3", maxAmountA: "1000000", maxAmountB: "500000000000000" } };
  const f = fixture(0, input);
  f.waitWith(async () => { throw new Error("Agent turn interrupted"); });
  await expect(f.run()).rejects.toThrow("Agent turn interrupted");
  const request = f.sends[0]!, before = (await f.store.get(input.operationId))!;
  expect(actionResult(before).steps[0]!.status).toBe("submitted");
  const evidence = f.evidence(request, true);
  evidence.receipt = { ...receipt, finality: "finalized", logs: [
    { address: V3_POSITION_MANAGER, data: "0x", logIndex: "0", topics: [keccak256(stringToHex("Transfer(address,address,uint256)")), `0x${"0".repeat(64)}`, `0x${address.slice(2).padStart(64, "0")}`, `0x${(1362740n).toString(16).padStart(64, "0")}`] },
    { address: contract, data: `0x${"ab".repeat(40000)}`, logIndex: "1", topics: [] },
  ] };
  f.transactions.set(f.hash(request), evidence);
  const eventsBefore = f.events.length;
  const result = await reconcileAction({ transaction: f.wallet.transaction }, f.store, input.operationId);
  expect(result?.state).toBe("complete"); expect(result?.phase).toBe("complete");
  expect(result?.positionTokenIds).toEqual(["1362740"]);
  expect(result?.steps[0]).toMatchObject({ requestId: request.requestId, checked: true, receipt: { status: "success", blockNumber: receipt.blockNumber, finality: "finalized" } });
  expect(f.events.slice(eventsBefore)).toEqual(["wallet:transaction", "persist:complete"]);
  expect(f.sends).toHaveLength(1); expect(f.preparations()).toBe(1); expect(f.tracked).toHaveLength(0);
  const saved = (await f.store.get(input.operationId))!;
  expect(saved.input_json).toBe(before.input_json);
  expect(parseActionState(saved).steps[0]!.evidenceReceiptLogsOmitted).toBe(1);
  expect(actionResult(saved).positionTokenIds).toEqual(["1362740"]);
});

test("receipt reconciliation stops after confirming approval and never starts a queued transaction", async () => {
  const f = fixture(1);
  f.waitWith(async () => { throw new Error("Paused after approval submission"); });
  await expect(f.run()).rejects.toThrow("Paused after approval submission");
  await f.confirm();
  const result = await reconcileAction({ transaction: f.wallet.transaction }, f.store, envelope.operationId);
  expect(result?.state).toBe("pending"); expect(result?.phase).toBe("step_0_confirmed");
  expect(result?.steps.map((step) => [step.status, step.checked])).toEqual([["confirmed", true], ["queued", false]]);
  expect(result?.message).toContain("did not approve, send or renew");
  expect(f.sends).toHaveLength(1); expect(f.preparations()).toBe(1);
});

test("a lost dispatch with no saved hash stays unknown through receipt-only reconciliation, even after expiry", async () => {
  const f = fixture(0);
  f.sendWith(async () => { throw new Error("Reply lost"); });
  expect((await f.run()).state).toBe("pending"); f.advance(1_300_000);
  const before = (await f.store.get(envelope.operationId))!, eventsBefore = f.events.length;
  const result = await reconcileAction({ transaction: f.wallet.transaction }, f.store, envelope.operationId);
  expect(result?.state).toBe("pending"); expect(result?.steps[0]).toMatchObject({ status: "unknown", transactionHash: null, checked: false, receipt: null });
  expect(result?.message).toContain("no saved transaction hash");
  expect(f.events.slice(eventsBefore).every((event) => event.startsWith("persist:"))).toBe(true);
  expect(parseActionState((await f.store.get(envelope.operationId))!).steps).toEqual(parseActionState(before).steps);
  expect(f.sends).toHaveLength(1); expect(f.rows.size).toBe(1); expect(f.preparations()).toBe(1);
});

test.each(["AGENT_CONSENT_DENIED", "AGENT_MODE_REVOKED"] as const)("%s survives saved-state recovery without pretending execution was rejected", async (code) => {
  const f = fixture(1), reason = "Full-range mint conflicts with the owner's concentrated-position instruction";
  f.sendWith(async request => {
    if (request.data === "0x03") throw Object.assign(new Error(reason), { code });
    return f.operation(request, "confirmed");
  });
  const result = await f.run(), request = f.sends[1]!, failure = { requestId: request.requestId, code, message: reason };
  expect(result.state).toBe("stopped");
  expect(result.steps.map(step => step.status)).toEqual(["confirmed", "unknown"]);
  expect(result.message).toContain(code); expect(result.message).toContain(reason);
  expect(result.message).toContain("does not prove the request was unsigned or submitted");
  const saved = (await f.store.get(envelope.operationId))!;
  expect(parseActionState(saved).steps[1]).toMatchObject({ authorizationFailure: failure, dispatched: true, unresolvedDispatch: true, operation: null, evidence: null });
  // A new parsed journal snapshot has all the evidence: no in-memory catch
  // result or whole-model-step transcript is needed to explain the stop.
  expect(actionResult(JSON.parse(JSON.stringify(saved)))).toEqual(result);
  expect(actionResult(saved, "pending", "Tracking paused")).toEqual(result);
  f.advance(1_300_000);
  const defaultRead = await reconcileAction({ transaction: f.wallet.transaction }, f.store, envelope.operationId);
  expect(defaultRead?.state).toBe("stopped"); expect(defaultRead?.message).toBe(result.message);
  expect(defaultRead?.phase).toBe(result.phase);
  expect(defaultRead?.steps[1]).not.toHaveProperty("authorizationFailure");
  const read = await reconcileAction({ transaction: f.wallet.transaction }, f.store, envelope.operationId, { includeAuthorization: true });
  expect(read?.steps[0]?.authorizationFailure).toBeNull();
  expect(read?.steps[1]).toMatchObject({ status: "unknown", requestId: request.requestId, transactionHash: null, receipt: null, checked: false, authorizationFailure: failure });
  // Explicit continuation may inspect the original request, but an absent or
  // older prepared Wallet row must not replay the denied review or renew it.
  expect((await f.run()).state).toBe("stopped");
  f.operations.set(request.requestId, f.operation(request, "prepared"));
  expect((await f.run()).state).toBe("stopped");
  expect(f.sends).toHaveLength(2); expect(f.rows.size).toBe(1); expect(f.preparations()).toBe(1);
});

test("a later authenticated receipt resolves a revoked review without erasing its historical error", async () => {
  const f = fixture(0);
  f.sendWith(async () => { throw Object.assign(new Error("Agent invocation revoked"), { code: "AGENT_MODE_REVOKED" }); });
  expect((await f.run()).state).toBe("stopped");
  const request = f.sends[0]!;
  f.operations.set(request.requestId, f.operation(request, "confirmed"));
  f.transactions.set(f.hash(request), f.evidence(request, true));
  const result = await f.run();
  expect(result.state).toBe("complete"); expect(result.message).toContain("succeeded");
  const read = await reconcileAction({ transaction: f.wallet.transaction }, f.store, envelope.operationId, { includeAuthorization: true });
  expect(read?.state).toBe("complete"); expect(read?.steps[0]?.authorizationFailure?.code).toBe("AGENT_MODE_REVOKED");
  expect(read?.steps[0]?.receipt?.status).toBe("success"); expect(f.sends).toHaveLength(1);
});

test("an authoritative unsigned Wallet rejection remains distinct from a retained authorization error", async () => {
  const f = fixture(0);
  f.sendWith(async () => { throw Object.assign(new Error("Owner denied review"), { code: "AGENT_CONSENT_DENIED" }); });
  await f.run();
  const request = f.sends[0]!;
  f.operations.set(request.requestId, { ...f.operation(request, "rejected"), message: "Rejected by owner" });
  const result = await f.run();
  expect(result.state).toBe("stopped"); expect(result.steps[0]?.status).toBe("rejected");
  expect(result.message).toBe("Rejected by owner");
  expect((await reconcileAction({ transaction: f.wallet.transaction }, f.store, envelope.operationId))?.message).toBe("Rejected by owner");
  expect(f.sends).toHaveLength(1);
});

test("retaining a denied review merges concurrent receipt evidence instead of replacing it with unknown", async () => {
  const f = fixture(0);
  f.sendWith(async request => {
    const saved = (await f.store.get(envelope.operationId))!, state = parseActionState(saved);
    state.steps[0] = { ...state.steps[0]!, unresolvedDispatch: false, operation: f.operation(request, "confirmed"), evidence: f.evidence(request, true) };
    await f.store.update(saved, state, "complete");
    throw Object.assign(new Error("This concurrent review was denied"), { code: "AGENT_CONSENT_DENIED" });
  });
  const result = await f.run();
  expect(result.state).toBe("complete"); expect(result.phase).toBe("complete"); expect(result.steps[0]?.status).toBe("confirmed");
  const state = parseActionState((await f.store.get(envelope.operationId))!);
  expect(state.steps[0]?.authorizationFailure?.code).toBe("AGENT_CONSENT_DENIED");
  expect(state.steps[0]?.evidence?.receipt?.status).toBe("success"); expect(f.sends).toHaveLength(1);
});

test("legacy unknown rows never infer rejection from an absent hash", async () => {
  const f = fixture(0);
  f.sendWith(async () => { throw new Error("Old reply lost with no durable reason"); });
  await f.run();
  const result = await reconcileAction({ transaction: f.wallet.transaction }, f.store, envelope.operationId, { includeAuthorization: true });
  expect(result?.state).toBe("pending");
  expect(result?.steps[0]).toMatchObject({ status: "unknown", transactionHash: null, authorizationFailure: null });
  expect(f.sends).toHaveLength(1);
});

test("revoking the whole invocation preserves the last dispatch without bypassing cancelled journal access", async () => {
  const f = fixture(0), controller = new AbortController();
  f.sendWith(async () => {
    const error = Object.assign(new Error("Agent mode revoked"), { code: "AGENT_MODE_REVOKED" });
    controller.abort(error); throw error;
  });
  await expect(f.run({ signal: controller.signal })).rejects.toThrow("Agent mode revoked");
  const saved = (await f.store.get(envelope.operationId))!;
  expect(parseActionState(saved).steps[0]).toMatchObject({ dispatched: true, unresolvedDispatch: true });
  expect(parseActionState(saved).steps[0]).not.toHaveProperty("authorizationFailure");
  const read = await reconcileAction({ transaction: f.wallet.transaction }, f.store, envelope.operationId, { includeAuthorization: true });
  expect(read?.state).toBe("pending"); expect(read?.steps[0]).toMatchObject({ status: "unknown", authorizationFailure: null });
  expect(f.sends).toHaveLength(1);
});

test("receipt reconciliation clears stale completion when its transaction disappears in a reorganization", async () => {
  const f = fixture(0); await f.run();
  const request = f.sends[0]!, evidence = f.evidence(request);
  evidence.transaction = null; f.transactions.set(f.hash(request), evidence);
  const result = await reconcileAction({ transaction: f.wallet.transaction }, f.store, envelope.operationId);
  expect(result?.state).toBe("pending"); expect(result?.phase).toBe("step_0_unknown");
  expect(result?.steps[0]).toMatchObject({ status: "unknown", checked: true, receipt: null });
  expect(actionResult((await f.store.get(envelope.operationId))!).state).toBe("pending");
  expect(f.sends).toHaveLength(1);
});

test("receipt reconciliation exposes a finalized revert without contradictory pending prose", async () => {
  const f = fixture(0);
  f.waitWith(async () => { throw new Error("Tracking paused"); });
  await expect(f.run()).rejects.toThrow("Tracking paused");
  const request = f.sends[0]!, evidence = f.evidence(request, true);
  evidence.receipt = { ...receipt, status: "reverted", finality: "finalized" }; f.transactions.set(f.hash(request), evidence);
  const result = await reconcileAction({ transaction: f.wallet.transaction }, f.store, envelope.operationId);
  expect(result?.state).toBe("stopped"); expect(result?.phase).toBe("step_0_reverted");
  expect(result?.steps[0]?.receipt).toEqual({ status: "reverted", blockNumber: receipt.blockNumber, finality: "finalized" });
  expect(result?.message).toContain("reverted"); expect(result?.message).toContain("finalized"); expect(result?.message).not.toContain("awaiting");
  expect(f.sends).toHaveLength(1);
});

test.each([true, false])("receipt-only reconciliation verifies saved replacement execution, matching=%s", async (matching) => {
  const f = fixture(0), replacementHash = `0x${"88".repeat(32)}`;
  f.sendWith(async (request) => {
    const evidence = f.evidence(request); evidence.transactionHash = replacementHash;
    f.transactions.set(replacementHash, evidence);
    return { ...f.operation(request), status: "replaced", replacementTransactionHash: replacementHash };
  });
  f.waitWith(async () => { throw new Error("Tracking paused"); });
  await expect(f.run()).rejects.toThrow("Tracking paused");
  const evidence = f.transactions.get(replacementHash)!;
  evidence.receipt = receipt;
  evidence.transaction!.blockNumber = receipt.blockNumber; evidence.transaction!.blockHash = receipt.blockHash;
  if (!matching) evidence.transaction!.data = "0xdead";
  const result = await reconcileAction({ transaction: f.wallet.transaction }, f.store, envelope.operationId);
  expect(result?.state).toBe(matching ? "complete" : "stopped");
  expect(result?.steps[0]!.status).toBe(matching ? "confirmed" : "replaced");
  expect(result?.transactionHash).toBe(replacementHash); expect(f.sends).toHaveLength(1);
});

test("saved invocation and receipt reconciliation follow renewal while preserving original identity and inputs", async () => {
  const f = fixture(1); f.validity(10);
  f.waitWith(async () => { await f.confirm(); f.advance(20_000); f.validity(1200); });
  await f.run();
  const record = (await latestAction(f.store, envelope.operationId))!;
  const invocation = actionInvocation(record);
  expect(invocation).toMatchObject({ operationId: envelope.operationId, recordId: actionAttemptId(envelope.operationId, "1"), toolName: "uniswap_swap_v2", caller, agentMode: true, humanOwned: false });
  expect(JSON.parse(invocation.argumentsJson)).toEqual({ ...envelope.input, operationId: envelope.operationId, chainId: envelope.chainId, accountId: envelope.accountId });
  const result = await reconcileAction({ transaction: f.wallet.transaction }, f.store, envelope.operationId);
  expect(result?.recordId).toBe(invocation.recordId); expect(result?.state).toBe("complete");
  expect(f.sends).toHaveLength(2); expect(f.rows.size).toBe(2);
  await expect(runAction(f.wallet, f.store, envelope, { ...caller, installationUid: "18" }, true, f.prepare)).rejects.toThrow("another caller");
});

test("receipt reconciliation preserves progress written by a concurrent continuation", async () => {
  const f = fixture(0); await f.run();
  let reads = 0;
  const transaction: EvmWalletClient["transaction"] = async (...args) => {
    if (reads++ === 0) {
      const record = (await f.store.get(envelope.operationId))!, state = parseActionState(record);
      state.plan.details.concurrentObservation = "preserve me";
      await f.store.update(record, state, record.phase);
    }
    return f.wallet.transaction(...args);
  };
  const result = await reconcileAction({ transaction }, f.store, envelope.operationId);
  expect(result?.state).toBe("complete"); expect(reads).toBe(2);
  expect(parseActionState((await f.store.get(envelope.operationId))!).plan.details.concurrentObservation).toBe("preserve me");
  expect(f.sends).toHaveLength(1);
});

test("receipt reconciliation does not present cached completion as a successful live read when RPC fails", async () => {
  const f = fixture(0); await f.run(); const before = (await f.store.get(envelope.operationId))!;
  await expect(reconcileAction({ transaction: async () => { throw new Error("RPC unavailable"); } }, f.store, envelope.operationId)).rejects.toThrow("RPC unavailable");
  expect(await f.store.get(envelope.operationId)).toEqual(before); expect(f.sends).toHaveLength(1);
});

test("reconciling an absent operation performs no Wallet call or journal creation", async () => {
  const f = fixture(0);
  expect(await reconcileAction({ transaction: f.wallet.transaction }, f.store, envelope.operationId)).toBeNull();
  expect(f.events).toEqual([]); expect(f.rows.size).toBe(0);
});

test("V3 increase estimates after its approvals and journals the exact gas cap before first dispatch", async () => {
  const f = liquidityGasFixture(1);
  f.sendWith(async request => {
    if (request.data === "0x03") {
      const state = parseActionState((await f.store.get(f.input.operationId))!);
      expect(state.steps[1]!.request).toEqual(request);
      expect(state.steps[1]!.dispatched).toBe(true); expect(state.steps[1]!.unresolvedDispatch).toBe(true);
      expect(state.plan.steps[1]!.transaction.gasLimit).toBe("331999");
      expect(state.plan.details.gasEstimate).toMatchObject({ gasLimit: "331999", additionalGas: "100000", observation: { gasLimit: "231999", blockNumber: "25934514", source: "evm_rpc" } });
    } else expect(request.gasLimit).toBeUndefined();
    return f.operation(request);
  });
  expect((await f.run()).state).toBe("complete");
  expect(f.estimates()).toBe(1);
  expect(f.events.indexOf("persist:step_0_confirmed")).toBeLessThan(f.events.indexOf("wallet:estimate"));
  expect(f.events.indexOf("wallet:estimate")).toBeLessThan(f.events.indexOf("persist:step_1_requested"));
  expect(f.sends[1]!.gasLimit).toBe("331999");
  const invocation = actionInvocation((await f.store.get(f.input.operationId))!);
  expect(invocation.toolName).toBe("uniswap_manage_liquidity_v1");
  expect(JSON.parse(invocation.gasEstimateJson!)).toMatchObject({ gasLimit: "331999", observation: { blockNumber: "25934514" } });
});

test("V4 collect saves the exact estimate and cap before sending and exposes both for recovery", async () => {
  const f = liquidityGasFixture(0, "v4");
  f.sendWith(async request => {
    const state = parseActionState((await f.store.get(f.input.operationId))!);
    expect(state.steps[0]!.request).toEqual(request);
    expect(state.steps[0]!.dispatched).toBe(true);
    expect(state.plan.steps[0]!.transaction.gasLimit).toBe("331999");
    expect(state.plan.details.gasEstimate).toMatchObject({ basis: "wallet_estimate_plus_v4_collect_reserve", additionalGas: "100000" });
    return f.operation(request);
  });
  expect((await f.run()).state).toBe("complete");
  const invocation = actionInvocation((await f.store.get(f.input.operationId))!);
  expect(JSON.parse(invocation.gasEstimateJson!)).toMatchObject({ gasLimit: "331999", observation: { blockNumber: "25934514" } });
  expect(f.sends).toHaveLength(1); expect(f.estimates()).toBe(1);
  expect((await f.run()).state).toBe("complete");
  expect(f.sends).toHaveLength(1); expect(f.estimates()).toBe(1);
});

test.each(["v3", "v4"] as const)("an interrupted %s liquidity action retains its exact gas cap and request on every explicit continuation", async (protocol) => {
  const f = liquidityGasFixture(0, protocol); f.sendWith(async () => { throw new Error("Reply lost after dispatch"); });
  expect((await f.run()).state).toBe("pending");
  const first = structuredClone(f.sends[0]!);
  expect(first.gasLimit).toBe("331999");
  f.wallet.estimateTransaction = async () => { throw new Error("A dispatched request must never be re-estimated"); };
  expect((await f.run()).state).toBe("pending");
  expect(f.sends[1]).toEqual(first); expect(f.estimates()).toBe(1);
  f.operations.set(first.requestId, f.operation(first, "confirmed")); f.transactions.set(f.hash(first), f.evidence(first, true));
  expect((await f.run()).state).toBe("complete"); expect(f.sends).toHaveLength(2); expect(f.preparations()).toBe(1);
});

test("an unavailable increase estimate leaves the final step undispatched after confirmed approval", async () => {
  const f = liquidityGasFixture(1);
  f.wallet.estimateTransaction = async () => { throw new Error("RPC estimate unavailable"); };
  await expect(f.run()).rejects.toThrow("RPC estimate unavailable");
  const saved = (await f.store.get(f.input.operationId))!, state = parseActionState(saved);
  expect(actionResult(saved).steps.map(step => step.status)).toEqual(["confirmed", "queued"]);
  expect(state.steps[1]!.dispatched).toBe(false); expect(state.steps[1]!.request.gasLimit).toBeUndefined();
  expect(state.plan.details.gasEstimate).toBeUndefined();
  expect(f.sends).toHaveLength(1); expect(f.rows.size).toBe(1);
});

test.each(["v3", "v4"] as const)("a released already-dispatched %s liquidity action keeps its original request without introducing an explicit gas cap", async (protocol) => {
  const f = liquidityGasFixture(0, protocol), cancellation = new AbortController();
  f.writeWith(row => { if (row.phase === "ready") cancellation.abort(new Error("Saved legacy plan")); });
  await expect(f.run({ signal: cancellation.signal })).rejects.toThrow("Saved legacy plan");
  const row = f.rows.get(f.input.operationId)!, state = JSON.parse(row.state_json!);
  state.steps[0].dispatched = true; state.steps[0].unresolvedDispatch = true;
  row.state_json = JSON.stringify(state); row.phase = "step_0_requested";
  f.writeWith(() => {});
  f.wallet.estimateTransaction = async () => { throw new Error("Legacy dispatched request must stay identical"); };
  f.sendWith(async request => f.operation(request, "confirmed"));
  expect((await f.run()).state).toBe("complete");
  expect(f.sends[0]).toEqual(state.steps[0].request); expect(f.sends[0]!.gasLimit).toBeUndefined();
  expect(f.estimates()).toBe(0); expect(f.preparations()).toBe(1);
});

test("saved gas cap changes cannot bypass consistency with the exact planned request", async () => {
  const f = liquidityGasFixture(); await f.run();
  const record = (await f.store.get(f.input.operationId))!, state = JSON.parse(record.state_json);
  state.steps[0].request.gasLimit = "999999";
  expect(() => parseActionState({ ...record, state_json: JSON.stringify(state) })).toThrow("transaction or dispatch identity changed");
});
