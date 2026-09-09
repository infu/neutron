import { expect, test } from "bun:test";
import type { JsonObject, MsgBusToolContext } from "neutron-tools/app";
import { createActionHandlers } from "../src/action_tools.ts";
import type { ActionBackend, ActionPrepared, LiquidityWire } from "../src/action_backend.ts";
import type { BrowserPoolView } from "../src/liquidity_reads.ts";
import { authorizeAction } from "../src/provider.ts";
import { createFundingRequest } from "../src/funding.ts";

const OWNER = "3rurp-vyaaa-aaaay-aacua-cai", POOL = "mohjv-bqaaa-aaaag-qjyia-cai";
const ICP = "ryjl3-tyaaa-aaaaa-aaaba-cai", USDC = "xevnm-gaaaa-aaaar-qafnq-cai";
const ID = "d7".repeat(16), POSITION = "5090", LIQUIDITY = "1000000";
type Exit = "decrease" | "close" | "claim" | "withdraw";
type Mode = "tile" | "normal-agent" | "root-agent";

function input(kind: Exit): JsonObject {
  return { kind, pool: POOL, positionId: kind === "withdraw" ? null : POSITION,
    amount0: "0", amount1: "0", tickLower: 0, tickUpper: 0,
    liquidity: kind === "decrease" ? "250000" : "0",
    token: kind === "withdraw" ? ICP : "", amount: kind === "withdraw" ? "100000" : "0" };
}

function wire(kind: Exit): LiquidityWire {
  const value = input(kind);
  return { kind, pool: POOL, position_id: value.positionId as string | null,
    tick_lower: "0", tick_upper: "0", amount0: "0", amount1: "0", liquidity: String(value.liquidity),
    withdraw_token: String(value.token), withdraw_amount: String(value.amount) };
}

function poolView(): BrowserPoolView {
  return {
    pool: { pool: POOL, key: "icp-usdc", token0: { address: ICP, standard: "ICRC2" },
      token1: { address: USDC, standard: "ICRC2" }, fee: 3000, tickSpacing: 60 },
    owner: OWNER,
    metadata: { sqrtPriceX96: "79228162514264337593543950336", tick: 0, liquidity: "999999999" },
    positions: [{ id: POSITION, tickLower: -60, tickUpper: 60, liquidity: LIQUIDITY,
      amount0: "2995", amount1: "2995", tokensOwed0: "50", tokensOwed1: "90", feeError: null }],
    unused: { balance0: "1000000", balance1: "1000000" },
    reserved: { balance0: "0", balance1: "0" }, availableUnused: { balance0: "1000000", balance1: "1000000" },
    cachedFees: { token0Fee: "10000", token1Fee: "10000" }, available: true,
    withdrawals: [], transactions: [], errors: [],
    source: { kind: "direct-canister-query", host: "https://icp-api.io", observedAt: "2026-09-09T01:30:00Z" },
  };
}

/** A separate durable-plan stub: the real browser preview calculates its own
 * amounts/range, while this backend independently fixes the protocol request. */
function durablePlan(request: LiquidityWire): JsonObject {
  const effective = { ...request };
  if (request.kind !== "withdraw") { effective.tick_lower = "-60"; effective.tick_upper = "60"; }
  if (request.kind === "close") effective.liquidity = LIQUIDITY;
  return {
    request: effective, pool: POOL, owner: OWNER,
    token0: { address: ICP, standard: "ICRC2" }, token1: { address: USDC, standard: "ICRC2" },
    fee: "3000", tick_spacing: "60", tick: "1", sqrt_price_x96: "79232123823359799118286999568",
    fee0: "10000", fee1: "10000", funding0: "0", funding1: "0", price_protection: false,
    expected_amount0: "3100", expected_amount1: "2980", expected_liquidity: effective.liquidity,
    baseline_positions: [], unused0: "1000000", unused1: "1000000",
    observed_at: "1788917401000000000", detail: "Independently observed backend plan.",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(mode: Mode = "tile") {
  const events: string[] = [], reviews: JsonObject[] = [], walletCalls: JsonObject[] = [];
  const records = new Map<string, ActionPrepared>();
  const abort = new AbortController(), shown = deferred<void>();
  let decision: (number: number) => Promise<boolean> = async () => true;
  let adjustPlan: (plan: JsonObject) => void = () => {};
  let prepareTerminal: string | null = null;
  const view = poolView();
  const caller = mode === "tile"
    ? { appId: "icpswap", installationUid: "123", role: "tile", endpoint: "app:icpswap:tile:main:instance:exit-test" }
    : { appId: "agent", installationUid: "456", role: "background", endpoint: "app:agent:background" };
  const rootMode = mode === "root-agent";
  const review = async (value: JsonObject) => {
    reviews.push(structuredClone(value)); events.push("review"); shown.resolve();
    return decision(reviews.length);
  };
  const kernel = {
    querySelf: async (method: string) => {
      events.push(`query:${method}`);
      if (method !== "icpswap_market") throw new Error(`Unexpected query ${method}`);
      return { status: {}, rows: [{ address: ICP, symbol: "ICP", decimals: 8 }, { address: USDC, symbol: "ckUSDC", decimals: 6 }] };
    },
    updateSelf: async (method: string) => { events.push(`update:${method}`); throw new Error("Exit must not update token metadata"); },
    callTool: async (call: JsonObject) => {
      if (call.name === "icpswap_owner_review_v1") {
        expect(mode).toBe("tile"); expect(call.target).toBe(caller.endpoint);
        events.push("owner-dialog");
        return { approved: await review(JSON.parse(String((call.arguments as JsonObject).reviewJson))) };
      }
      walletCalls.push(structuredClone(call)); events.push(`wallet:${call.name}`);
      if (call.name === "wallet_fund_v1") return { status: "approved", commandId: `icpswap:${(call.arguments as JsonObject).requestId}`, blockIndex: "42", duplicate: true, message: null };
      throw new Error("An exit must not read Wallet balances for display");
    },
  } as unknown as MsgBusToolContext["kernel"];
  const context: MsgBusToolContext = {
    caller, kernel, agentMode: rootMode, signal: abort.signal, reportProgress() {},
    requestApproval: async (value) => {
      expect(mode).toBe("root-agent"); events.push("root-review");
      if (!await review(value)) throw new Error("Root review declined");
    },
    presentUserInterface: async <T>(request: { tileId: string; tool: string; arguments?: JsonObject }) => {
      expect(mode).toBe("normal-agent"); expect(request.tool).toBe("icpswap_review_v1"); events.push("agent-dialog");
      return { approved: await review(JSON.parse(String(request.arguments?.reviewJson))) } as T;
    },
  };
  const backend: ActionBackend = {
    account: async () => { events.push("account"); return OWNER; },
    actionGet: async (id) => { events.push("get"); return structuredClone(records.get(id)?.operation ?? null); },
    liquidityStatus: async (id) => { events.push("status"); return structuredClone(records.get(id) ?? null); },
    liquidityPrepare: async (request) => {
      events.push("prepare");
      const retained = records.get(request.id); if (retained) return structuredClone(retained);
      const plan = durablePlan(request.request); adjustPlan(plan);
      const saved: ActionPrepared = { plan, operation: { id: request.id, input_json: request.input_json, plan_json: "", funding_json: "",
        state: prepareTerminal ?? "prepared", detail: "Prepared", result_json: "", revision: "0", created_at: "1788917400000000000", updated_at: "1788917400000000000", effects: [] } };
      records.set(request.id, saved); return structuredClone(saved);
    },
    actionUpdate: async (request) => {
      events.push(`journal:${request.state}`);
      const saved = records.get(request.id)!;
      expect(request.expected_revision).toBe(saved.operation.revision);
      saved.operation = { ...saved.operation, ...request, revision: String(BigInt(saved.operation.revision) + 1n) };
      return structuredClone(saved.operation);
    },
    liquidityExecute: async (request) => {
      events.push("execute"); const saved = records.get(request.id)!;
      expect(request.expected_revision).toBe(saved.operation.revision);
      saved.operation = { ...saved.operation, state: "settlement_pending", detail: "Protocol succeeded; payment unverified.", revision: String(BigInt(saved.operation.revision) + 1n) };
      return structuredClone(saved);
    },
    actionPage: async () => { throw new Error("Not part of exit dispatch"); },
    liquidityReconcile: async () => { throw new Error("Not part of exit dispatch"); },
    liquidityPreview: async () => { throw new Error("Preview must query ICPSwap from the browser"); },
    liquidityPool: async () => { throw new Error("Pool must query ICPSwap from the browser"); },
    swapPrepare: async () => { throw new Error("Unexpected swap"); }, swapExecute: async () => { throw new Error("Unexpected swap"); }, swapStatus: async () => null,
    recoveryPrepare: async () => { throw new Error("Unexpected recovery"); }, recoveryExecute: async () => { throw new Error("Unexpected recovery"); }, recoveryStatus: async () => null,
  };
  const handlers = createActionHandlers({ backendFor: () => backend, authorize: authorizeAction, reads: {
    readPool: async (pool, owner, signal) => {
      expect(pool).toBe(POOL); expect(owner).toBe(OWNER); expect(signal).toBe(abort.signal);
      events.push("browser-pool"); return structuredClone(view);
    },
  } });
  const seed = (kind: Exit, state: string) => {
    const saved: ActionPrepared = {
      plan: durablePlan(wire(kind)),
      operation: { id: ID, input_json: JSON.stringify({ version: 1, kind: "liquidity", owner: { appId: caller.appId, installationUid: caller.installationUid, rootMode }, input: input(kind) }),
        plan_json: "", funding_json: "", result_json: "", state, detail: "Existing record", revision: "4", created_at: "1788917400000000000", updated_at: "1788917400000000000", effects: [] },
    };
    records.set(ID, saved); return saved;
  };
  return { events, reviews, walletCalls, records, abort, shown, handlers, context, seed,
    decide: (fn: typeof decision) => { decision = fn; }, changePlan: (fn: typeof adjustPlan) => { adjustPlan = fn; },
    terminalDuringPrepare: (state: string) => { prepareTerminal = state; },
    changeView: (fn: (value: BrowserPoolView) => void) => { fn(view); },
    start: (kind: Exit) => handlers.liquidity({ operationId: ID, ...input(kind) }, context),
  };
}

for (const mode of ["tile", "normal-agent", "root-agent"] as const) {
  for (const kind of ["decrease", "close", "claim", "withdraw"] as const) {
    test(`${mode} ${kind} reviews the browser preview before any update, then executes without empty funding writes`, async () => {
      const f = fixture(mode), approved = deferred<boolean>(); f.decide(() => approved.promise);
      const task = f.start(kind); await f.shown.promise;
      expect(f.records.size).toBe(0); expect(f.events).not.toContain("prepare"); expect(f.events).not.toContain("execute");
      expect(f.walletCalls).toEqual([]); expect(f.events.some((event) => event.startsWith("journal:") || event.startsWith("update:"))).toBe(false);
      expect(f.reviews[0]!.pair).toBe("ICP / ckUSDC");
      approved.resolve(true);
      const result = await task;
      expect(result.state).toBe("settlement_pending"); expect(f.reviews).toHaveLength(1);
      expect(f.events.indexOf("review")).toBeLessThan(f.events.indexOf("prepare"));
      expect(f.events.filter((event) => event === "execute")).toHaveLength(1);
      expect(f.events.some((event) => event.startsWith("journal:"))).toBe(false); expect(f.walletCalls).toEqual([]);
      expect(JSON.parse(f.records.get(ID)!.operation.input_json).input).toEqual(input(kind));
    });
  }
}

for (const mode of ["tile", "normal-agent", "root-agent"] as const) {
  test(`${mode} declining or cancelling the early review leaves no saved mutation`, async () => {
    for (const cancel of [false, true]) {
      const f = fixture(mode);
      f.decide(async () => { if (cancel) f.abort.abort(new Error("Exit review cancelled")); return cancel; });
      await expect(f.start("decrease")).rejects.toThrow(cancel ? "Exit review cancelled" : "declined");
      expect(f.records.size).toBe(0); expect(f.events).not.toContain("prepare"); expect(f.events).not.toContain("execute"); expect(f.walletCalls).toEqual([]);
    }
  });
}

test("a changed total close amount gets a second review of the retained plan; decline cannot execute it", async () => {
  const f = fixture();
  f.changePlan((plan) => { (plan.request as JsonObject).liquidity = "1100000"; plan.expected_liquidity = "1100000"; });
  f.decide(async (number) => number === 1);
  await expect(f.start("close")).rejects.toThrow("declined");
  expect(f.reviews.map((review) => review.liquidityToRemove)).toEqual(["1000000", "1100000"]);
  expect(f.events.indexOf("prepare")).toBeGreaterThan(f.events.indexOf("review"));
  expect(f.records.get(ID)!.operation.state).toBe("prepared"); expect(f.events).not.toContain("execute"); expect(f.walletCalls).toEqual([]);
});

test("changed withdrawal fee gets reviewed before execution", async () => {
  const f = fixture(); f.changePlan((plan) => { plan.fee0 = "20000"; });
  const result = await f.start("withdraw");
  expect(result.state).toBe("settlement_pending");
  expect(f.reviews.map((review) => review.expectedOutputNet)).toEqual(["0.0009 ICP", "0.0008 ICP"]);
  expect(f.events.lastIndexOf("review")).toBeLessThan(f.events.indexOf("execute"));
});

test("output, price and accrued-fee changes alone reuse consent for the exact removal", async () => {
  const f = fixture(); f.changePlan((plan) => {
    plan.expected_amount0 = "2100"; plan.expected_amount1 = "4080"; plan.tick = "20";
    plan.observed_at = "1788917460000000000"; plan.baseline_positions = [{ id: POSITION, fees0: "200", fees1: "600" }];
  });
  const result = await f.start("decrease");
  expect(result.state).toBe("settlement_pending"); expect(f.reviews).toHaveLength(1);
  expect((result.plan as JsonObject).expected_amount0).toBe("2100");
});

for (const state of ["complete", "settlement_pending", "uncertain", "stopped"] as const) {
  test(`existing ${state} exit returns its retained outcome without preview, approval or mutation`, async () => {
    const f = fixture(); const saved = f.seed("close", state);
    // A closed position must not be needed to return a known historical result.
    f.changeView((view) => { view.positions = []; });
    const before = structuredClone(saved); const result = await f.start("close");
    expect(result.state).toBe(state); expect(f.events).toEqual(["get", "status"]);
    expect(f.records.get(ID)).toEqual(before); expect(f.reviews).toEqual([]); expect(f.walletCalls).toEqual([]);
  });
}

test("an existing requested effect is not replayed even if its outer state still says prepared", async () => {
  const f = fixture(); const saved = f.seed("close", "prepared");
  saved.operation.effects = [{ key: "liquidity", state: "requested" }];
  const result = await f.start("close");
  expect(result.state).toBe("prepared"); expect(f.events).toEqual(["get", "status"]); expect(f.reviews).toEqual([]);
});

test("an existing prepared exit reviews its retained amount without a fresh browser preview", async () => {
  const f = fixture(); f.seed("close", "prepared");
  f.changeView((view) => { view.positions![0]!.liquidity = "2000000"; });
  const result = await f.handlers.continue({ operationId: ID }, f.context);
  expect(result.state).toBe("settlement_pending"); expect(f.reviews[0]!.liquidityToRemove).toBe(LIQUIDITY);
  expect(f.events).not.toContain("browser-pool"); expect(f.events).not.toContain("prepare");
  expect(f.events.some((event) => event.startsWith("journal:"))).toBe(false);
});

test("a terminal record returned by preparation wins over the early preview without another dispatch", async () => {
  const f = fixture(); f.terminalDuringPrepare("settlement_pending");
  const result = await f.start("close");
  expect(result.state).toBe("settlement_pending"); expect(f.reviews).toHaveLength(1); expect(f.events).not.toContain("execute"); expect(f.walletCalls).toEqual([]);
});

for (const mode of ["normal-agent", "root-agent"] as const) {
  test(`${mode} retained nonempty funding is reconciled under its original identity before exit dispatch`, async () => {
    const f = fixture(mode), saved = f.seed("decrease", "funding_requested");
    const request = createFundingRequest({ requestId: "ab".repeat(16), ledger: ICP, spender: POOL, amountAtoms: "30000", nowMs: Date.now() });
    saved.operation.funding_json = JSON.stringify([request]);
    const first = await f.handlers.continue({ operationId: ID }, f.context);
    expect(f.events).not.toContain("browser-pool"); expect(f.events).not.toContain("prepare");
    if (mode === "root-agent") {
      expect(first.state).toBe("funding_required"); expect(f.events).not.toContain("execute"); expect(f.walletCalls).toEqual([]);
      expect(first.fundingInstructions).toEqual([{ target: "app:wallet:background", name: "wallet_fund_root_v1", arguments: request }]);
      const final = await f.handlers.continue({ operationId: ID, fundingResults: [{ status: "approved", commandId: `agent:${request.requestId}`, blockIndex: "42", duplicate: true, message: null }] }, f.context);
      expect(final.state).toBe("settlement_pending"); expect(f.walletCalls).toEqual([]);
    } else {
      expect(first.state).toBe("settlement_pending"); expect(f.walletCalls.map((call) => call.name)).toEqual(["wallet_fund_v1"]);
      expect(f.walletCalls[0]!.arguments).toEqual(request);
    }
    expect(f.records.get(ID)!.operation.funding_json).toBe(JSON.stringify([request]));
    expect(f.events.filter((event) => event === "execute")).toHaveLength(1);
    expect(f.events.indexOf("journal:funded")).toBeLessThan(f.events.indexOf("execute"));
  });
}
