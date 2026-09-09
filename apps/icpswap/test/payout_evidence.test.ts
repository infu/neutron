import { describe, expect, test } from "bun:test";
import type { JsonValue, ScopedKernelClient } from "neutron-tools/app";
import type { ActionPrepared } from "../src/action_backend.ts";
import { readPayoutEvidence, type PayoutTransaction } from "../src/payout_evidence.ts";

const ID = "e1".repeat(16), OWNER = "3rurp-vyaaa-aaaay-aacua-cai", POOL = "mohjv-bqaaa-aaaag-qjyia-cai";
const ICP = "ryjl3-tyaaa-aaaaa-aaaba-cai", USDC = "xevnm-gaaaa-aaaar-qafnq-cai", INDEX = "qhbym-qaaaa-aaaaa-aaafq-cai";
const OWNER_ACCOUNT = "79f5cf27183332894fd130553216ffcb05e55d36cbcddebad4b266297559e675";
const POOL_ACCOUNT = "bca85666f3d2de1d135d399a9ccc96d38090601e784e1e5467b87fb3334ec1e0";
const DISPATCH = "1788911602141119044", OBSERVED = "1788912850346000000", BIG = "9007199254740993123456789";
const methods = { mint: "mint", increase: "increaseLiquidity", claim: "claim", decrease: "decreaseLiquidity", close: "decreaseLiquidity", withdraw: "withdraw" };

function prepared(kind: keyof typeof methods = "claim"): ActionPrepared {
  return {
    operation: { id: ID, input_json: "{}", plan_json: "", funding_json: "[]", result_json: "", state: "settlement_pending", detail: "Protocol succeeded", revision: "4", created_at: DISPATCH, updated_at: DISPATCH,
      effects: [{ key: "liquidity", method: methods[kind], canister: POOL, state: "succeeded", dispatched_at: DISPATCH, completed_at: OBSERVED, result_nat: "9", result_amount0: "100000", result_amount1: "0" }] },
    plan: { pool: POOL, owner: OWNER, token0: { address: ICP, standard: "ICRC1" }, token1: { address: USDC, standard: "ICRC2" },
      request: { kind, pool: POOL, position_id: "9", amount0: "500000", amount1: "100000", liquidity: "100", withdraw_token: USDC, withdraw_amount: "50000" } },
  };
}
function transfer(overrides: Partial<PayoutTransaction> = {}): PayoutTransaction {
  return { blockIndex: "38274747", operation: "transfer", timestampNs: (BigInt(DISPATCH) + 1n).toString(), amountAtoms: BIG, feeAtoms: "10000", balanceEffectAtoms: BIG,
    from: { kind: "icp_account_identifier", accountIdentifierHex: POOL_ACCOUNT }, to: { kind: "icp_account_identifier", accountIdentifierHex: OWNER_ACCOUNT }, spender: null,
    memoHex: "00000000000f21a2", memoComplete: true, ...overrides };
}
function icrcTransfer(overrides: Partial<PayoutTransaction> = {}): PayoutTransaction {
  return transfer({ blockIndex: "779771", from: { kind: "icrc", owner: POOL, subaccountHex: null }, to: { kind: "icrc", owner: OWNER, subaccountHex: "0".repeat(64) }, ...overrides });
}
function page(ledger = ICP, transactions: unknown[] = [transfer()]) {
  return { version: 1, ledger, owner: OWNER, observedAtNs: OBSERVED, available: true, error: null,
    source: { kind: "index", canister: INDEX, ledgerVerified: false }, transactions,
    pagination: { beforeBlock: null, nextBeforeBlock: "38274747", oldestBlock: "111", hasMore: true, completeToOldest: false },
    observation: { indexedAccountBalanceAtoms: BIG, newestAccountBlock: "38274748", indexedBlocks: "38274749", indexedBlocksError: null } };
}
function exact(ledger = ICP, tx = transfer(), ledgerVerified = true) {
  return { version: 1, ledger, owner: OWNER, blockIndex: tx.blockIndex, observedAtNs: OBSERVED, available: true, error: null, transaction: tx,
    source: { kind: ledgerVerified ? "ledger" : "index", canister: ledgerVerified ? ledger : INDEX, method: ledgerVerified ? "query_blocks" : "get_account_transactions", ledgerVerified, archived: false },
    chainLength: "38274930", diagnostics: [] as string[] };
}
function wallet(reply: (name: string, args: Record<string, unknown>) => unknown | Promise<unknown> = (_name, args) => page(args.ledger as string)) {
  const calls: Array<{ target: string; name: string; arguments: Record<string, unknown> }> = [];
  const kernel = {
    callTool: async (request: { target: string; name: string; arguments: Record<string, unknown> }) => {
      expect(request.target).toBe("app:wallet:background");
      expect(["wallet_account_transactions_v1", "wallet_transaction_v1"]).toContain(request.name);
      calls.push(request);
      return await reply(request.name, request.arguments) as JsonValue;
    },
  } as unknown as Pick<ScopedKernelClient, "callTool">;
  return { kernel, calls };
}

describe("ICPSwap payout evidence", () => {
  test("exact successful zero-output claim requires no Wallet lookup", async () => {
    const action = prepared(); action.operation.effects[0]!.result_amount0 = "0";
    const { kernel, calls } = wallet();
    const evidence = await readPayoutEvidence({ prepared: action, kernel, owner: OWNER, payoutBlocks: [{ ledger: ICP, blockIndex: "38274747" }] });
    expect(evidence).toMatchObject({ status: "not_required", settlementVerified: false, operationLinkVerified: false, ledgers: [], explicitBlocks: [] });
    expect(calls).toEqual([]);
  });

  test.each(["requested", "uncertain", "failed"])("%s protocol effect does not trigger Wallet reads or invent zero", async state => {
    const action = prepared(); action.operation.effects[0]!.state = state;
    const { kernel, calls } = wallet();
    expect(await readPayoutEvidence({ prepared: action, kernel, owner: OWNER })).toMatchObject({ status: "not_applicable", effect: null, ledgers: [] });
    expect(calls).toEqual([]);
  });

  test("missing or mismatched retained success is not replaced by the operation state or plan", async () => {
    for (const change of [(a: ActionPrepared) => { a.operation.effects = []; }, (a: ActionPrepared) => { a.operation.effects[0]!.canister = OWNER; }, (a: ActionPrepared) => { a.operation.effects[0]!.method = "mint"; }]) {
      const action = prepared(); action.operation.state = "complete"; change(action);
      const { kernel, calls } = wallet();
      expect((await readPayoutEvidence({ prepared: action, kernel, owner: OWNER })).status).toBe("not_applicable");
      expect(calls).toEqual([]);
    }
  });

  test("recent history retains exact facts and continuation without claiming amount-based settlement", async () => {
    const action = prepared(), before = JSON.stringify(action), { kernel, calls } = wallet();
    const evidence = await readPayoutEvidence({ prepared: action, kernel, owner: OWNER });
    expect(calls.map(call => call.arguments)).toEqual([{ ledger: ICP, limit: 25 }]);
    expect(evidence).toMatchObject({ status: "observed", settlementVerified: false, operationLinkVerified: false });
    const ledger = evidence.ledgers[0]!;
    expect(ledger.protocolAmountAtoms).toBe("100000");
    expect(ledger.coverage).toMatchObject({ source: { kind: "index", ledgerVerified: false }, pagination: { nextBeforeBlock: "38274747", hasMore: true, completeToOldest: false }, observation: { indexedAccountBalanceAtoms: BIG, indexedBlocks: "38274749" } });
    expect(ledger.candidates).toHaveLength(1);
    expect(ledger.candidates[0]).toMatchObject({ classification: "contextual_candidate", operationLinkVerified: false, transaction: transfer() });
    expect(ledger.candidates[0]!.reason).toContain("do not establish linkage");
    expect(JSON.stringify(action)).toBe(before);
    expect(() => JSON.stringify(evidence)).not.toThrow();
  });

  test("filters sender, recipient, time, operation and non-default ICRC subaccounts", async () => {
    const txs = [transfer(), transfer({ timestampNs: DISPATCH }), transfer({ timestampNs: (BigInt(DISPATCH) - 1n).toString() }), transfer({ from: { kind: "icp_account_identifier", accountIdentifierHex: OWNER_ACCOUNT } }), transfer({ to: { kind: "icp_account_identifier", accountIdentifierHex: POOL_ACCOUNT } }),
      transfer({ operation: "mint" }), transfer({ amountAtoms: "0" }), icrcTransfer(), icrcTransfer({ from: { kind: "icrc", owner: POOL, subaccountHex: "1".repeat(64) } }), icrcTransfer({ to: { kind: "icrc", owner: OWNER, subaccountHex: "1".repeat(64) } })];
    const { kernel } = wallet(() => page(ICP, txs));
    const ledger = (await readPayoutEvidence({ prepared: prepared(), kernel, owner: OWNER })).ledgers[0]!;
    expect(ledger.inspectedTransactions).toBe(10); expect(ledger.excludedTransactions).toBe(7);
    expect(ledger.candidates).toHaveLength(3);
  });

  test("empty complete history is an observation, not proof of missing payout or settlement", async () => {
    const response = page(ICP, []); response.pagination = { beforeBlock: null, nextBeforeBlock: null, oldestBlock: null, hasMore: false, completeToOldest: true } as unknown as typeof response.pagination;
    const { kernel } = wallet(() => response);
    const evidence = await readPayoutEvidence({ prepared: prepared(), kernel, owner: OWNER });
    expect(evidence).toMatchObject({ status: "observed", settlementVerified: false, operationLinkVerified: false });
    expect(evidence.ledgers[0]!.candidates).toEqual([]);
    expect(evidence.reason).toContain("does not prove settlement or a missing payout");
  });

  test("zero-output decrease is not relabeled as a no-payout claim or a Wallet observation", async () => {
    const action = prepared("decrease"); action.operation.effects[0]!.result_amount0 = "0";
    const { kernel, calls } = wallet();
    const evidence = await readPayoutEvidence({ prepared: action, kernel, owner: OWNER });
    expect(evidence.status).toBe("not_applicable"); expect(evidence.settlementVerified).toBe(false);
    expect(evidence.reason).toContain("No Wallet observation was requested"); expect(calls).toEqual([]);
  });

  test("structured unavailable history preserves its observation context and diagnostic", async () => {
    const response = { ...page(ICP, []), available: false, error: "No index is configured for this ledger.", source: { kind: "index", canister: null, ledgerVerified: false } };
    const { kernel } = wallet(() => response);
    const evidence = await readPayoutEvidence({ prepared: prepared(), kernel, owner: OWNER });
    expect(evidence.status).toBe("unavailable");
    expect(evidence.ledgers[0]).toMatchObject({ status: "unavailable", coverage: { observedAtNs: OBSERVED, source: { canister: null } }, candidates: [], errors: [response.error] });
  });

  test("one unavailable ledger or malformed row preserves the remaining observations", async () => {
    const action = prepared("decrease"); action.operation.effects[0]!.result_amount1 = "60000";
    const { kernel } = wallet((_name, args) => {
      if (args.ledger === ICP) throw new Error("Index offline");
      return page(USDC, [icrcTransfer({ memoHex: null, memoComplete: false }), { ...icrcTransfer(), amountAtoms: 123 }]);
    });
    const evidence = await readPayoutEvidence({ prepared: action, kernel, owner: OWNER });
    expect(evidence.status).toBe("partial");
    expect(evidence.ledgers[0]).toMatchObject({ status: "unavailable", candidates: [], errors: ["Index offline"] });
    expect(evidence.ledgers[1]).toMatchObject({ status: "partial", candidates: [{ transaction: { memoHex: null, memoComplete: false, amountAtoms: BIG } }] });
    expect(evidence.errors).toHaveLength(2);
  });

  test("unknown actual outputs remain unknown; mint refunds do not use predicted token consumption", async () => {
    const action = prepared("mint"), { kernel, calls } = wallet((_name, args) => page(args.ledger as string, args.ledger === ICP ? [transfer()] : [icrcTransfer()]));
    action.plan.expected_amount0 = "500000"; action.plan.expected_amount1 = "100000";
    const evidence = await readPayoutEvidence({ prepared: action, kernel, owner: OWNER });
    expect(calls).toHaveLength(2);
    expect(evidence.ledgers.map(ledger => ({ ledger: ledger.ledger, purpose: ledger.purpose, amount: ledger.protocolAmountAtoms, received: ledger.candidates[0]?.transaction.amountAtoms }))).toEqual([
      { ledger: ICP, purpose: "refund", amount: null, received: BIG }, { ledger: USDC, purpose: "refund", amount: null, received: BIG },
    ]);
    const unknown = prepared(); unknown.operation.effects[0]!.result_amount0 = null;
    expect((await readPayoutEvidence({ prepared: unknown, kernel, owner: OWNER })).ledgers[0]!.protocolAmountAtoms).toBeNull();
  });

  test.each(["ledger", "owner", "version", "source", "observation"])("invalid %s cannot produce credible index candidates", async field => {
    const response: Record<string, unknown> = page();
    response[field] = field === "ledger" ? USDC : field === "owner" ? POOL : field === "version" ? 2 : field === "source" ? { kind: "index", canister: INDEX, ledgerVerified: true } : {};
    const { kernel } = wallet(() => response);
    const evidence = await readPayoutEvidence({ prepared: prepared(), kernel, owner: OWNER });
    expect(evidence.status).toBe("unavailable"); expect(evidence.ledgers[0]!.candidates).toEqual([]); expect(evidence.errors.length).toBeGreaterThan(0);
  });

  test("explicit verified ledger and index fallback blocks remain contextual candidates", async () => {
    const tx = transfer({ amountAtoms: "100000", balanceEffectAtoms: "100000" });
    for (const verified of [true, false]) {
      const { kernel, calls } = wallet((name) => name === "wallet_account_transactions_v1" ? page(ICP, []) : exact(ICP, tx, verified));
      const evidence = await readPayoutEvidence({ prepared: prepared(), kernel, owner: OWNER, payoutBlocks: [{ ledger: ICP, blockIndex: tx.blockIndex }] });
      expect(calls[1]!.arguments).toEqual({ ledger: ICP, blockIndex: tx.blockIndex, source: "auto" });
      expect(evidence.explicitBlocks[0]).toMatchObject({ status: "candidate", source: { ledgerVerified: verified }, chainLength: "38274930", transaction: tx,
        candidate: { operationLinkVerified: false, source: { ledgerVerified: verified } } });
      expect(evidence.settlementVerified).toBe(false); expect(evidence.operationLinkVerified).toBe(false);
    }
  });

  test("unavailable recent history does not discard a separately verified explicit payout block", async () => {
    const { kernel } = wallet(name => { if (name === "wallet_account_transactions_v1") throw new Error("Index offline"); return exact(); });
    const evidence = await readPayoutEvidence({ prepared: prepared(), kernel, owner: OWNER, payoutBlocks: [{ ledger: ICP, blockIndex: transfer().blockIndex }] });
    expect(evidence.status).toBe("partial"); expect(evidence.explicitBlocks[0]!.source?.ledgerVerified).toBe(true); expect(evidence.explicitBlocks[0]!.status).toBe("candidate");
  });

  test.each(["reply block", "transaction block", "recipient", "time", "other ledger"])("explicit block with wrong %s does not match the saved payout", async scenario => {
    const response = exact(); let ledger = ICP;
    if (scenario === "reply block") response.blockIndex = "1";
    if (scenario === "transaction block") response.transaction = transfer({ blockIndex: "1" });
    if (scenario === "recipient") response.transaction = transfer({ to: { kind: "icp_account_identifier", accountIdentifierHex: POOL_ACCOUNT } });
    if (scenario === "time") response.transaction = transfer({ timestampNs: "0" });
    if (scenario === "other ledger") { ledger = USDC; response.ledger = USDC; response.source.canister = USDC; }
    const { kernel } = wallet(name => name === "wallet_account_transactions_v1" ? page(ICP, []) : response);
    // Withdraw only names USDC as a payout ledger, so ICP is unrelated here.
    const action = scenario === "other ledger" ? prepared("withdraw") : prepared();
    if (scenario === "other ledger") { ledger = ICP; response.ledger = ICP; response.source.canister = ICP; }
    const evidence = await readPayoutEvidence({ prepared: action, kernel, owner: OWNER, payoutBlocks: [{ ledger, blockIndex: transfer().blockIndex }] });
    const block = evidence.explicitBlocks[0]!;
    expect(block.status).toBe(scenario.endsWith("block") ? "unavailable" : "not_matched");
    expect(block.candidate).toBeNull(); expect(evidence.settlementVerified).toBe(false);
  });

  test("saved swap reads only its output ledger after exact retained pool success", async () => {
    const action = prepared();
    action.plan = { pool: POOL, input_address: ICP, output_address: USDC };
    action.operation.effects = [{ key: "swap", canister: POOL, method: "depositFromAndSwap", state: "succeeded", dispatched_at: DISPATCH, completed_at: OBSERVED, result_nat: BIG }];
    const { kernel, calls } = wallet(() => page(USDC, [icrcTransfer()]));
    const evidence = await readPayoutEvidence({ prepared: action, kernel, owner: OWNER });
    expect(calls.map(call => call.arguments.ledger)).toEqual([USDC]);
    expect(evidence.ledgers[0]).toMatchObject({ ledger: USDC, purpose: "output", protocolAmountAtoms: BIG, candidates: [{ transaction: { amountAtoms: BIG } }] });
    expect(evidence.settlementVerified).toBe(false);
  });

  test("cancelled observations return diagnostics without new reads or journal mutation", async () => {
    const action = prepared("mint"), original = JSON.stringify(action), { kernel, calls } = wallet();
    const controller = new AbortController(); controller.abort(new Error("Cancelled"));
    const evidence = await readPayoutEvidence({ prepared: action, kernel, owner: OWNER, signal: controller.signal });
    expect(evidence.status).toBe("unavailable"); expect(evidence.errors.every(error => error.includes("Cancelled"))).toBe(true);
    expect(calls).toEqual([]); expect(JSON.stringify(action)).toBe(original);
  });
});
