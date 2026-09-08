import { describe, expect, test } from "bun:test";
import type { JsonObject, MsgBusToolContext } from "neutron-tools/app";
import type { ActionBackend, ActionOperation, ActionPrepared } from "../src/action_backend.ts";
import { createDirectFundingRequest, createFundingRequest } from "../src/funding.ts";
import { eligibleDirectDepositRecoveries, runDepositRecovery } from "../src/recovery_workflow.ts";

const OWNER = "3rurp-vyaaa-aaaay-aacua-cai", POOL = "mohjv-bqaaa-aaaag-qjyia-cai";
const ICP = "ryjl3-tyaaa-aaaaa-aaaba-cai", USDC = "xevnm-gaaaa-aaaar-qafnq-cai";
const SOURCE = "aa".repeat(16), RECOVERY = "bb".repeat(16), REQUEST = "11".repeat(16), OTHER = "22".repeat(16);
const rootOwner = { appId: "agent", installationUid: "123", rootMode: true };
const humanOwner = { appId: "icpswap", installationUid: "456", rootMode: false };
const direct = createDirectFundingRequest({ requestId: REQUEST, ledger: ICP, pool: POOL, owner: OWNER, amountAtoms: "1000000", feeAtoms: "10000", nowMs: 1788000000000 });
const other = createFundingRequest({ requestId: OTHER, ledger: USDC, spender: POOL, amountAtoms: "2000000", nowMs: 1788000000000 });
const transferred = (namespace = "agent"): JsonObject => ({ status: "transferred", commandId: `${namespace}:${REQUEST}`, blockIndex: "9007199254740993", duplicate: false, message: null });
const pending = (namespace = "agent"): JsonObject => ({ status: "pending", commandId: `${namespace}:${REQUEST}`, blockIndex: null, duplicate: null, message: "Reply pending" });
const rejected: JsonObject = { status: "rejected", commandId: `agent:${OTHER}`, blockIndex: null, duplicate: null, message: "Second token was declined" };
const args: JsonObject = { operationId: RECOVERY, sourceOperationId: SOURCE, tokenIndex: 0 };

function fixture(options: { rootSource?: boolean; rootCaller?: boolean; confirmed?: boolean; walletFee?: string } = {}) {
  const sourceOwner = options.rootSource === false ? humanOwner : rootOwner;
  const currentOwner = options.rootCaller === false ? humanOwner : rootOwner;
  const sourceResult = options.confirmed === false ? pending(sourceOwner.rootMode ? "agent" : "icpswap") : transferred(sourceOwner.rootMode ? "agent" : "icpswap");
  const operation = (id: string, input: JsonObject): ActionOperation => ({ id, input_json: JSON.stringify(input), plan_json: "", funding_json: "", result_json: "",
    state: "prepared", detail: "Prepared", revision: "0", created_at: "1", updated_at: "1", effects: [] });
  const source: ActionPrepared = {
    operation: { ...operation(SOURCE, { version: 1, kind: "liquidity", owner: sourceOwner, input: { kind: "mint", pool: POOL } }),
      state: "funding_requested", funding_json: JSON.stringify([direct, other]),
      result_json: JSON.stringify({ kind: "wallet_funding_v1", results: [{ requestId: REQUEST, result: sourceResult }] }) },
    plan: { pool: POOL, owner: OWNER, token0: { address: ICP, standard: "ICP" }, token1: { address: USDC, standard: "ICRC2" },
      funding0: "1000000", funding1: "2000000", fee0: "10000", fee1: "10000" },
  };
  const records = new Map<string, ActionPrepared>([[SOURCE, source]]), calls: string[] = [], reviews: JsonObject[] = [];
  let deny = false, failMetadata = false, failSave = false, losePrepare = false, loseExecute = false;
  const context: MsgBusToolContext = { caller: { appId: currentOwner.appId, installationUid: currentOwner.installationUid, role: currentOwner.rootMode ? "background" : "tile",
    endpoint: currentOwner.rootMode ? "app:agent:background" : "app:icpswap:tile:main:instance:review" }, agentMode: currentOwner.rootMode, reportProgress() {},
    kernel: { callTool: async (call: any) => {
      calls.push(call.name);
      if (call.name !== "wallet_token_info_v1") throw new Error("Recovery must never call Wallet funding");
      if (failMetadata) throw new Error("Metadata unavailable");
      return { ledger: ICP, account: OWNER, symbol: "ICP", name: "Internet Computer", decimals: 8, feeAtoms: options.walletFee ?? "20000", balanceAtoms: "0", observedAtNs: "1" };
    } } as unknown as MsgBusToolContext["kernel"],
  };
  const backend = {
    actionGet: async (id: string) => structuredClone(records.get(id)?.operation ?? null),
    liquidityStatus: async (id: string) => { calls.push("source read"); return structuredClone(records.get(id) ?? null); },
    recoveryStatus: async (id: string) => structuredClone(records.get(id) ?? null),
    actionUpdate: async (request: any) => {
      calls.push("source save"); const prior = records.get(request.id)!;
      if (failSave || prior.operation.revision !== request.expected_revision) throw new Error("Source revision changed");
      prior.operation = { ...prior.operation, ...request, revision: String(BigInt(prior.operation.revision) + 1n) };
      return structuredClone(prior.operation);
    },
    recoveryPrepare: async (request: any) => {
      calls.push("prepare");
      const retained = records.get(request.id);
      if (retained) return structuredClone(retained);
      const result: ActionPrepared = { operation: operation(request.id, JSON.parse(request.input_json)),
        plan: { source_id: request.source_id, token_index: request.token_index, pool: POOL, owner: OWNER, token: { address: ICP, standard: "ICP" },
          gross_amount: "1010000", fee: "20000", credit_amount: "990000", observed_at: "1" } };
      records.set(request.id, result);
      if (losePrepare) { losePrepare = false; throw new Error("Preparation reply lost"); }
      return structuredClone(result);
    },
    recoveryExecute: async (request: any) => {
      calls.push("execute"); const prior = records.get(request.id)!;
      if (prior.operation.revision !== request.expected_revision) throw new Error("Recovery revision changed");
      prior.operation = { ...prior.operation, state: loseExecute ? "uncertain" : "complete", revision: "1", detail: loseExecute ? "Pool reply unknown; do not replay" : "Credited to pool-unused funds",
        effects: [{ key: "recover_deposit", state: loseExecute ? "uncertain" : "succeeded" }] };
      if (loseExecute) throw new Error("Execution reply lost");
      return structuredClone(prior);
    },
  } as unknown as ActionBackend;
  const dependencies = { backendFor: (kernel: MsgBusToolContext["kernel"]) => { expect(kernel).toBe(context.kernel); return backend; },
    authorize: async (_context: MsgBusToolContext, review: JsonObject) => { calls.push("review"); reviews.push(review); if (deny) throw new Error("Owner declined"); } };
  return { context, dependencies, records, source, calls, reviews,
    run: (value = args, invocation = context) => runDepositRecovery(value, invocation, dependencies),
    deny: () => { deny = true; }, failMetadata: () => { failMetadata = true; }, failSave: () => { failSave = true; },
    losePrepare: () => { losePrepare = true; }, loseExecute: () => { loseExecute = true; } };
}

describe("direct-funded deposit recovery", () => {
  test("UI eligibility accepts only fully evidenced direct transfers without a deposit effect", () => {
    const f = fixture();
    expect(eligibleDirectDepositRecoveries(f.source.operation, f.source.plan)).toEqual([{ tokenIndex: 0, ledger: ICP,
      grossAmount: "1010000", requestId: REQUEST, commandId: `agent:${REQUEST}`, blockIndex: "9007199254740993" }]);
    expect(eligibleDirectDepositRecoveries({ id: SOURCE } as ActionOperation, f.source.plan)).toEqual([]);
    expect(eligibleDirectDepositRecoveries(f.source.operation, {})).toEqual([]);
    const missing = fixture({ confirmed: false });
    expect(eligibleDirectDepositRecoveries(missing.source.operation, missing.source.plan)).toEqual([]);
    f.source.operation.effects = [{ key: "deposit0", state: "recovery_reserved" }];
    expect(eligibleDirectDepositRecoveries(f.source.operation, f.source.plan)).toEqual([]);
  });

  test("UI eligibility rejects mismatched identities rather than guessing a recoverable amount", () => {
    const f = fixture();
    f.source.operation.result_json = JSON.stringify({ kind: "wallet_funding_v1", results: [{ requestId: REQUEST, result: transferred("icpswap") }] });
    expect(eligibleDirectDepositRecoveries(f.source.operation, f.source.plan)).toEqual([]);
  });

  test("a Human can recover a confirmed Root transfer with no additional Wallet funding", async () => {
    const f = fixture({ rootCaller: false });
    const result = await f.run();
    expect(result.state).toBe("complete");
    expect(f.calls).toEqual(["source read", "prepare", "wallet_token_info_v1", "review", "execute"]);
    expect(f.reviews[0]!.amountAlreadyTransferred).toBe("0.0101 ICP");
    expect(f.reviews[0]!.depositFee).toBe("0.0002 ICP");
    expect(f.reviews[0]!.expectedPoolCredit).toBe("0.0099 ICP");
    expect(JSON.parse(f.records.get(RECOVERY)!.operation.input_json).owner).toEqual(humanOwner);
    expect(f.source.operation.state).toBe("funding_requested");
  });

  test("unknown Root transfer returns only its original exact Wallet request", async () => {
    const f = fixture({ confirmed: false }); const result = await f.run();
    expect(result.state).toBe("funding_unresolved");
    expect(result.fundingInstructions).toEqual([{ target: "app:wallet:background", name: "wallet_fund_root_v1", arguments: direct }]);
    expect(result.originalWalletCommandId).toBe(`agent:${REQUEST}`);
    expect(f.calls).toEqual(["source read"]); expect(f.records.has(RECOVERY)).toBe(false);
  });

  test("unknown funding cannot be replayed from another caller or mode", async () => {
    const f = fixture({ confirmed: false, rootCaller: false }); const result = await f.run();
    expect(result.state).toBe("funding_unresolved"); expect(result.fundingInstructions).toEqual([]);
    expect(result).not.toHaveProperty("originalWalletRequest"); expect(f.calls).toEqual(["source read"]);
  });

  test("Normal recovery never requests the uncertain original transfer itself", async () => {
    const f = fixture({ rootSource: false, rootCaller: false, confirmed: false }); const result = await f.run();
    expect(result.fundingInstructions).toEqual([]); expect(result.originalWalletCommandId).toBe(`icpswap:${REQUEST}`);
    expect(result.originalWalletRequest).toEqual(direct); expect(f.calls).toEqual(["source read"]);
  });

  test("Root acknowledgments persist before recovery and preserve a declined other leg", async () => {
    const f = fixture({ confirmed: false });
    f.source.operation.result_json = JSON.stringify({ kind: "wallet_funding_v1", results: [{ requestId: REQUEST, result: pending() }, { requestId: OTHER, result: rejected }] });
    const originalFunding = f.source.operation.funding_json;
    const result = await f.run({ ...args, fundingResults: [{ ...transferred(), duplicate: true }] });
    expect(result.state).toBe("complete"); expect(f.calls.indexOf("source save")).toBeLessThan(f.calls.indexOf("prepare"));
    const saved = JSON.parse(f.source.operation.result_json).results;
    expect(saved.find((value: any) => value.requestId === OTHER).result).toEqual(rejected);
    expect(saved.find((value: any) => value.requestId === REQUEST).result.duplicate).toBe(true);
    expect(f.source.operation.funding_json).toBe(originalFunding); expect(f.source.operation.state).toBe("funding_requested");
  });

  test("wrong namespace and missing ledger receipt cannot claim a known transfer", async () => {
    for (const result of [transferred("icpswap"), { ...transferred(), blockIndex: null }]) {
      const f = fixture({ confirmed: false });
      await expect(f.run({ ...args, fundingResults: [result] })).rejects.toThrow();
      expect(f.calls).not.toContain("source save"); expect(f.calls).not.toContain("prepare");
    }
  });

  test("Normal callers cannot inject Root transfer acknowledgments", async () => {
    const f = fixture({ confirmed: false, rootCaller: false });
    await expect(f.run({ ...args, fundingResults: [transferred()] })).rejects.toThrow("original Root caller");
    expect(f.calls).not.toContain("source save"); expect(f.calls).not.toContain("prepare");
  });

  test("terminal rejections are retained instead of overwritten by conflicting evidence", async () => {
    const f = fixture({ confirmed: false });
    const declined = { ...pending(), status: "rejected", message: "Declined" };
    f.source.operation.result_json = JSON.stringify({ kind: "wallet_funding_v1", results: [{ requestId: REQUEST, result: declined }] });
    const result = await f.run(); expect(result.state).toBe("funding_rejected"); expect(result.fundingInstructions).toEqual([]);
    await expect(f.run({ ...args, fundingResults: [transferred()] })).rejects.toThrow("contradicts");
    expect(f.calls).not.toContain("source save"); expect(f.calls).not.toContain("prepare");
  });

  test("stale source revisions stop before recovery preparation", async () => {
    const f = fixture({ confirmed: false }); f.failSave();
    await expect(f.run({ ...args, fundingResults: [transferred()] })).rejects.toThrow("revision changed");
    expect(f.calls).not.toContain("prepare");
  });

  test("wrong transfer destination, ledger, or gross amount cannot match the source leg", async () => {
    for (const request of [{ ...direct, amountAtoms: "1000000" }, { ...direct, ledger: USDC }, { ...direct, route: { kind: "direct", to: OWNER } }]) {
      const f = fixture(); f.source.operation.funding_json = JSON.stringify([request, other]);
      await expect(f.run()).rejects.toThrow("no unique exact Wallet transfer"); expect(f.calls).not.toContain("prepare");
    }
  });

  test("a retained parent deposit is not submitted again regardless of its outcome", async () => {
    for (const state of ["requested", "succeeded", "uncertain", "failed", "recovery_reserved", "recovered"]) {
      const f = fixture(); f.source.operation.effects = [{ key: "deposit0", state }];
      await expect(f.run()).rejects.toThrow("already has a dispatch"); expect(f.calls).not.toContain("prepare");
    }
  });

  test("a lost prepare reply resumes its exact saved recovery without the source funding flow", async () => {
    const f = fixture(); f.losePrepare();
    await expect(f.run()).rejects.toThrow("Preparation reply lost");
    const original = f.records.get(RECOVERY)!.operation.input_json;
    f.records.delete(SOURCE);
    const result = await f.run({ operationId: RECOVERY });
    expect(result.state).toBe("complete"); expect(f.calls.filter((value) => value === "prepare")).toHaveLength(1);
    expect(f.records.get(RECOVERY)!.operation.input_json).toBe(original);
  });

  test("a lost execution reply returns the retained uncertain state and never executes twice", async () => {
    const f = fixture(); f.loseExecute();
    expect((await f.run()).state).toBe("uncertain");
    expect((await f.run({ operationId: RECOVERY })).state).toBe("uncertain");
    expect(f.calls.filter((value) => value === "execute")).toHaveLength(1); expect(f.reviews).toHaveLength(1);
  });

  test("declining the exact review preserves the prepared action without dispatch", async () => {
    const f = fixture(); f.deny();
    await expect(f.run()).rejects.toThrow("Owner declined");
    expect(f.records.get(RECOVERY)!.operation.state).toBe("prepared"); expect(f.calls).not.toContain("execute");
  });

  test("saved recovery identity cannot change source, token, mode or installation", async () => {
    const f = fixture(); await f.run();
    await expect(f.run({ ...args, sourceOperationId: "cc".repeat(16) })).rejects.toThrow("another source");
    await expect(f.run({ ...args, tokenIndex: 1 })).rejects.toThrow("another source");
    await expect(f.run(args, { ...f.context, agentMode: false })).rejects.toThrow("original application");
    await expect(f.run(args, { ...f.context, caller: { ...f.context.caller!, installationUid: "999" } })).rejects.toThrow("original application");
    expect(f.calls.filter((value) => value === "execute")).toHaveLength(1);
  });

  test("a known live ledger fee mismatch stops before recovery dispatch", async () => {
    const f = fixture({ walletFee: "30000" });
    await expect(f.run()).rejects.toThrow("differs from Wallet's live ledger fee");
    expect(f.calls).not.toContain("recovery execute");
    expect(f.reviews).toHaveLength(0);
  });

  test("metadata failure does not block recovery of known funds or invent token precision", async () => {
    const f = fixture(); f.failMetadata();
    expect((await f.run()).state).toBe("complete");
    expect(f.reviews[0]!.amountAlreadyTransferred).toBe(`1010000 atoms (${ICP})`);
    expect(f.reviews[0]!.expectedPoolCredit).toBe(`990000 atoms (${ICP})`);
  });

  test("cancellation prevents preparation and protocol dispatch", async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort(new Error("Stopped"));
    await expect(f.run(args, { ...f.context, signal: controller.signal })).rejects.toThrow("Stopped");
    expect(f.calls).toEqual([]);
  });
});
