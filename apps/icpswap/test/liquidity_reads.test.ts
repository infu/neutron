import { describe, expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@icp-sdk/core/principal";
import {
  createLiquidityReadClient, ICPSWAP_FACTORY, liquidityOwnerAccountIdentifier,
  liquidityReadMethods, type LiquidityQuery, type LiquidityReadMethod,
} from "../src/liquidity_reads";

// Token order and pool identity from production factory/metadata query on
// 2026-09-08. Schemas checked against upstream 94eeb92a, v3.7.0.
const OWNER = "3rurp-vyaaa-aaaay-aacua-cai";
const OTHER = "aaaaa-aa";
const POOL = "mohjv-bqaaa-aaaag-qjyia-cai";
const INDEX = "cglrh-lyaaa-aaaag-qcs4q-cai";
const ICP = { address: "ryjl3-tyaaa-aaaaa-aaaba-cai", standard: "ICRC2" };
const USDC = { address: "xevnm-gaaaa-aaaar-qafnq-cai", standard: "ICRC2" };
const identity = { key: "ICP/ckUSDC", token0: ICP, token1: USDC, fee: 3000n, tickSpacing: 60n, canisterId: Principal.fromText(POOL) };
const position = { id: 900719925474099312345n, tickLower: -60n, tickUpper: 60n, liquidity: 90071992547409931234n, tokensOwed0: 7n, tokensOwed1: 8n };
const metadata = { ...identity, sqrtPriceX96: 1n << 96n, tick: 0n, liquidity: 987654321098765432109876543210n };
const current = { ...position, tokensOwed0: 987654321098765432101n, tokensOwed1: 12n };
function withdrawal(owner = OWNER) {
  return { txIndex: 9223372036854775808n, caller: Principal.fromText(owner), token: USDC, amount: 50000n, fee: 10000n,
    to: { owner: Principal.fromText(owner), subaccount: [new Uint8Array(32).fill(1)] } };
}
function transaction(owner = OWNER) {
  return [1n, { id: 9223372036854775809n, owner: Principal.fromText(owner), timestamp: 1788888000123456789n,
    action: { Withdraw: { status: { Failed: null }, err: ["ledger temporarily unavailable"],
      transfer: { token: Principal.fromText(USDC.address), amount: 60000n, fee: 10000n } } } }];
}
type Handler = (args: unknown[], signal: AbortSignal, canister: string) => unknown | Promise<unknown>;
function fixture(overrides: Partial<Record<LiquidityReadMethod, Handler>> = {}) {
  const calls: { canister: string; method: LiquidityReadMethod; args: unknown[]; signal: AbortSignal }[] = [];
  const handlers: Record<LiquidityReadMethod, Handler> = {
    getPools: () => ({ ok: [identity] }),
    getInitArgs: () => ({ ok: { positionIndexCid: Principal.fromText(INDEX) } }),
    getUserPools: () => ({ ok: [POOL] }),
    metadata: () => ({ ok: metadata }),
    getCachedTokenFee: () => ({ token0Fee: 10000n, token1Fee: 10000n }),
    getAvailabilityState: () => ({ available: true, whiteList: [] }),
    getUserPositionsByPrincipal: () => ({ ok: [position] }),
    getUserPosition: () => ({ ok: current }),
    getUserUnusedBalance: () => ({ ok: { balance0: 0n, balance1: 12345678901234567890123n } }),
    getWithdrawQueueInfo: () => ({ ok: { items: [withdrawal(), withdrawal(OTHER)], queueSize: 2n, isProcessing: true } }),
    getTransactionsByOwner: () => ({ ok: [transaction(), transaction(OTHER)] }),
    ...overrides,
  };
  const query: LiquidityQuery = async (request) => {
    calls.push(request);
    return handlers[request.method](request.args, request.signal, request.canister);
  };
  return { client: createLiquidityReadClient({ query, now: () => 1788888000000 }), calls };
}

describe("anonymous ICPSwap liquidity reads", () => {
  test("derives the production index key from the owner's default account", () => {
    expect(liquidityOwnerAccountIdentifier(OWNER)).toBe("79f5cf27183332894fd130553216ffcb05e55d36cbcddebad4b266297559e675");
    expect(() => liquidityOwnerAccountIdentifier("not a principal")).toThrow();
  });

  test("discovers the canonical index and passes account hex rather than principal text", async () => {
    const { client, calls } = fixture();
    const result = await client.discoverOwnedPools(OWNER);
    expect(result.pools[0]).toEqual({ pool: POOL, key: identity.key, token0: ICP, token1: USDC, fee: 3000, tickSpacing: 60 });
    expect(result.indexedPools).toEqual([POOL]);
    expect(result.errors).toEqual([]);
    expect(calls[0]?.canister).toBe(ICPSWAP_FACTORY);
    const index = calls.find((call) => call.method === "getUserPools");
    expect(index?.canister).toBe(INDEX);
    expect(index?.args).toEqual([liquidityOwnerAccountIdentifier(OWNER)]);
  });

  test("retains touched pools on index failure without claiming a complete empty portfolio", async () => {
    const { client } = fixture({ getUserPools: () => ({ err: { InternalError: "index unavailable" } }) });
    const result = await client.discoverOwnedPools(OWNER, [POOL, POOL]);
    expect(result.indexedPools).toBeNull();
    expect(result.retainedPools).toEqual([POOL]);
    expect(result.pools.map((p) => p.pool)).toEqual([POOL]);
    expect(result.errors[0]).toEqual({ canister: INDEX, method: "getUserPools", message: "getUserPools: InternalError: index unavailable" });
  });

  test("reports removed retained pools and does not query unverified arbitrary pool IDs", async () => {
    const { client, calls } = fixture();
    const result = await client.discoverOwnedPools(OWNER, [OTHER]);
    expect(result.retainedPools).toEqual([OTHER]);
    expect(result.errors[0]?.canister).toBe(OTHER);
    await expect(client.readPool(OTHER, OWNER)).rejects.toThrow("absent from the canonical factory registry");
    expect(calls.some((call) => call.canister === OTHER)).toBe(false);
  });

  test("reads exact principal/fees/credits and filters global queue and transactions to owner", async () => {
    const { client, calls } = fixture();
    const result = await client.readPool(POOL, OWNER);
    expect(result.errors).toEqual([]);
    expect(result.metadata?.liquidity).toBe("987654321098765432109876543210");
    expect(result.positions?.[0]?.id).toBe("900719925474099312345");
    expect(result.positions?.[0]?.liquidity).toBe(position.liquidity.toString());
    expect(result.positions?.[0]?.tokensOwed0).toBe("987654321098765432101");
    expect(result.positions?.[0]?.tokensOwed1).toBe("12");
    expect(BigInt(result.positions?.[0]?.amount0 ?? "0")).toBeGreaterThan(0n);
    expect(result.positions?.[0]?.amount0).toBe(result.positions?.[0]?.amount1);
    expect(result.unused).toEqual({ balance0: "0", balance1: "12345678901234567890123" });
    expect(result.withdrawals).toEqual([{ transactionId: "9223372036854775808", token: USDC.address,
      amount: "50000", fee: "10000", owner: OWNER, recipient: OWNER, recipientSubaccount: "01".repeat(32) }]);
    expect(result.transactions).toEqual([{ id: "9223372036854775809", owner: OWNER,
      timestampNs: "1788888000123456789", action: "Withdraw", status: "Failed", error: "ledger temporarily unavailable",
      token: USDC.address, amount: "60000", unusedReserved: false, supportRequired: true }]);
    expect(result.source).toEqual({ kind: "direct-canister-query", host: "https://icp-api.io", observedAt: "2026-09-08T17:20:00.000Z" });
    expect(calls.find((call) => call.method === "getUserPosition")?.args).toEqual([position.id]);
    expect(calls.some((call) => call.canister === ICP.address || call.canister === USDC.address)).toBe(false);
    expect(calls.every((call) => Object.hasOwn(liquidityReadMethods, call.method))).toBe(true);
  });

  test("read failures preserve independently observed funds and mark unknown fees instead of stored fees or zero", async () => {
    const { client } = fixture({
      getUserPosition: () => ({ err: { InternalError: "position temporarily unavailable" } }),
      getWithdrawQueueInfo: () => { throw new Error("network unavailable"); },
    });
    const result = await client.readPool(POOL, OWNER);
    expect(result.positions?.[0]?.tokensOwed0).toBeNull();
    expect(result.positions?.[0]?.tokensOwed1).toBeNull();
    expect(result.positions?.[0]?.feeError).toContain("position temporarily unavailable");
    expect(result.positions?.[0]?.amount0).toBeNull();
    expect(result.withdrawals).toBeNull();
    expect(result.unused?.balance1).toBe("12345678901234567890123");
    expect(result.errors.map((error) => error.method)).toEqual(["getWithdrawQueueInfo", "getUserPosition"]);
  });

  test("failed ownership reads are unknown, while successful empty lists and zero credits are empty", async () => {
    const failed = fixture({ getUserPositionsByPrincipal: () => { throw new Error("offline"); } });
    expect((await failed.client.readPool(POOL, OWNER)).positions).toBeNull();
    const empty = fixture({ getUserPositionsByPrincipal: () => ({ ok: [] }), getUserUnusedBalance: () => ({ ok: { balance0: 0n, balance1: 0n } }) });
    const result = await empty.client.readPool(POOL, OWNER);
    expect(result.positions).toEqual([]);
    expect(result.unused).toEqual({ balance0: "0", balance1: "0" });
  });

  test("rejects metadata identity mismatches without discarding owner recovery observations", async () => {
    const { client } = fixture({ metadata: () => ({ ok: { ...metadata, token0: USDC, token1: ICP } }) });
    const result = await client.readPool(POOL, OWNER);
    expect(result.metadata).toBeNull();
    expect(result.errors[0]?.message).toContain("does not match its factory identity");
    expect(result.unused?.balance1).toBe("12345678901234567890123");
    expect(result.positions?.[0]?.amount0).toBeNull();
  });

  test("does not substitute the anonymous principal for missing Wallet owner", async () => {
    const { client, calls } = fixture();
    const result = await client.readPool(POOL);
    expect(result.owner).toBeNull();
    expect(result.positions).toBeNull();
    expect(result.withdrawals).toBeNull();
    expect(calls.map((call) => call.method)).toEqual(["getPools", "metadata", "getCachedTokenFee", "getAvailabilityState"]);
  });

  test("resolves owner availability through the pool whitelist without authorizing unrelated or absent owners", async () => {
    const { client } = fixture({ getAvailabilityState: () => ({ available: false, whiteList: [Principal.fromText(OWNER)] }) });
    expect((await client.readPool(POOL, OWNER)).available).toBe(true);
    expect((await client.readPool(POOL, OTHER)).available).toBe(false);
    expect((await client.readPool(POOL)).available).toBe(false);
  });

  test("counts Created withdrawal reservations once and leaves already-debited and refund amounts out", async () => {
    const tx = (id: bigint, action: string, status: string, amount: bigint) => [id, {
      id, owner: Principal.fromText(OWNER), timestamp: 1n,
      action: { [action]: { status: { [status]: null }, err: [], transfer: { token: Principal.fromText(USDC.address), amount, fee: 10000n } } },
    }];
    const { client, calls } = fixture({
      getTransactionsByOwner: () => ({ ok: [tx(1n, "Withdraw", "Created", 80000n), tx(2n, "Withdraw", "CreditCompleted", 50000n),
        tx(3n, "Refund", "Created", 30000n), tx(4n, "Withdraw", "Created", 10000n)] }),
      getUserUnusedBalance: () => ({ ok: { balance0: 123n, balance1: 100000n } }),
    });
    const result = await client.readPool(POOL, OWNER);
    expect(result.reserved).toEqual({ balance0: "0", balance1: "80000" });
    expect(result.availableUnused).toEqual({ balance0: "123", balance1: "20000" });
    expect(result.transactions?.map((entry) => entry.unusedReserved)).toEqual([true, false, false, false]);
    expect(calls.findIndex((entry) => entry.method === "getUserUnusedBalance")).toBeGreaterThan(calls.findIndex((entry) => entry.method === "getTransactionsByOwner"));
  });

  test("one-step swap input/output reservations follow actual stage and expose failed nested payout", async () => {
    const tx = (id: bigint, status: string, swapStatus: string, withdrawalStatus: string, withdrawalError: string[] = []) => [id, {
      id, owner: Principal.fromText(OWNER), timestamp: 1n,
      action: { OneStepSwap: { status: { [status]: null }, err: [],
        deposit: { status: { Completed: null }, err: [], transfer: { amount: 40000n, fee: 10000n, token: Principal.fromText(ICP.address) } },
        swap: { status: { [swapStatus]: null }, err: [], tokenIn: { address: Principal.fromText(ICP.address) }, tokenOut: { address: Principal.fromText(USDC.address) }, amountIn: 40000n, amountOut: 90000n },
        withdraw: { status: { [withdrawalStatus]: null }, err: withdrawalError, transfer: { amount: 90000n, fee: 10000n, token: Principal.fromText(USDC.address) } },
      } },
    }];
    const { client } = fixture({
      getTransactionsByOwner: () => ({ ok: [tx(1n, "PreSwapCompleted", "Created", "Created"), tx(2n, "SwapCompleted", "Completed", "Created"),
        tx(3n, "WithdrawCreditCompleted", "Completed", "CreditCompleted"), tx(4n, "Failed", "Completed", "Failed", ["BadFee"])] }),
      getUserUnusedBalance: () => ({ ok: { balance0: 50000n, balance1: 100000n } }),
    });
    const result = await client.readPool(POOL, OWNER);
    expect(result.reserved).toEqual({ balance0: "40000", balance1: "90000" });
    expect(result.availableUnused).toEqual({ balance0: "10000", balance1: "10000" });
    expect(result.transactions?.map((entry) => entry.unusedReserved)).toEqual([true, true, false, false]);
    expect(result.transactions?.[3]?.supportRequired).toBe(true);
    expect(result.transactions?.[3]?.error).toBe("BadFee");
  });

  test("failed reservation reads keep observed credit but cannot claim a spendable zero or full balance", async () => {
    const { client } = fixture({ getTransactionsByOwner: () => { throw new Error("transactions offline"); } });
    const result = await client.readPool(POOL, OWNER);
    expect(result.unused?.balance1).toBe("12345678901234567890123");
    expect(result.transactions).toBeNull();
    expect(result.reserved).toBeNull();
    expect(result.availableUnused).toBeNull();
  });

  test("processes every owned position, without upstream batch fee masking or a position cap", async () => {
    const positions = Array.from({ length: 71 }, (_, i) => ({ ...position, id: BigInt(i) }));
    const { client, calls } = fixture({ getUserPositionsByPrincipal: () => ({ ok: positions }) });
    const result = await client.readPool(POOL, OWNER);
    expect(result.positions).toHaveLength(71);
    expect(result.positions?.at(-1)?.id).toBe("70");
    expect(calls.filter((call) => call.method === "getUserPosition")).toHaveLength(71);
  });

  test("aborts before dispatch and during a read without converting cancellation into empty data", async () => {
    const controller = new AbortController(); controller.abort();
    const first = fixture();
    await expect(first.client.readPool(POOL, OWNER, controller.signal)).rejects.toHaveProperty("name", "AbortError");
    expect(first.calls).toEqual([]);
    let dispatch!: () => void;
    const dispatched = new Promise<void>((resolve) => { dispatch = resolve; });
    let upstreamSignal: AbortSignal | undefined;
    const second = fixture({ metadata: (_args, signal) => { upstreamSignal = signal; dispatch(); return new Promise(() => {}); } });
    const next = new AbortController();
    const request = second.client.readPool(POOL, OWNER, next.signal);
    await dispatched; next.abort();
    await expect(request).rejects.toHaveProperty("name", "AbortError");
    expect(upstreamSignal?.aborted).toBe(true);
  });

  test("shares in-flight reads but aborting one reader leaves another live; settled values are refreshed", async () => {
    let release!: (value: unknown) => void;
    const response = new Promise((resolve) => { release = resolve; });
    const { client, calls } = fixture({ getPools: () => response });
    const cancelled = new AbortController();
    const first = client.discoverPools(cancelled.signal);
    const second = client.discoverPools();
    await Promise.resolve(); cancelled.abort();
    await expect(first).rejects.toHaveProperty("name", "AbortError");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal.aborted).toBe(false);
    release({ ok: [identity] });
    expect((await second).pools).toHaveLength(1);
    await client.discoverPools();
    expect(calls).toHaveLength(2);
  });

  test("invalidating the client rejects stale consumers and dispatches the next read afresh", async () => {
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => { release = resolve; });
    const { client, calls } = fixture({ getPools: () => pending });
    const old = client.discoverPools();
    await Promise.resolve(); client.invalidate();
    release({ ok: [identity] });
    await expect(old).rejects.toHaveProperty("name", "AbortError");
    expect((await client.discoverPools()).pools).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  test("failed queries are not cached and independent owner queries never share account state", async () => {
    let attempt = 0;
    const { client, calls } = fixture({ getPools: () => { if (!attempt++) throw new Error("offline"); return { ok: [identity] }; } });
    await expect(client.discoverPools()).rejects.toThrow("offline");
    await Promise.all([client.readPool(POOL, OWNER), client.readPool(POOL, OTHER)]);
    const ownedCalls = calls.filter((call) => call.method === "getUserPositionsByPrincipal");
    expect(ownedCalls).toHaveLength(2);
    expect(ownedCalls.map((call) => Principal.from(call.args[0] as Principal).toText()).sort()).toEqual([OWNER, OTHER].sort());
  });
});

describe("production Candid projections", () => {
  test("decodes full position records with extra fee-growth fields into exact read projection", () => {
    const full = IDL.Record({ id: IDL.Nat, tickLower: IDL.Int, tickUpper: IDL.Int, liquidity: IDL.Nat,
      tokensOwed0: IDL.Nat, tokensOwed1: IDL.Nat, feeGrowthInside0LastX128: IDL.Nat, feeGrowthInside1LastX128: IDL.Nat });
    const upstream = IDL.Variant({ ok: IDL.Vec(full), err: IDL.Variant({ CommonError: IDL.Null, InternalError: IDL.Text, InsufficientFunds: IDL.Null, UnsupportedToken: IDL.Text }) });
    const bytes = IDL.encode([upstream], [{ ok: [{ ...position, feeGrowthInside0LastX128: 1n << 200n, feeGrowthInside1LastX128: 1n << 201n }] }]);
    const [decoded] = IDL.decode([liquidityReadMethods.getUserPositionsByPrincipal.output], bytes);
    expect(decoded).toEqual({ ok: [position] });
  });

  test("decodes upstream narrow action statuses and ignores unrelated transfer payload without losing failure", () => {
    const status = IDL.Variant({ Completed: IDL.Null, Created: IDL.Null, CreditCompleted: IDL.Null, Failed: IDL.Null });
    const transfer = IDL.Record({ amount: IDL.Nat, fee: IDL.Nat, token: IDL.Principal });
    const upstream = IDL.Variant({ ok: IDL.Vec(IDL.Tuple(IDL.Nat, IDL.Record({
      id: IDL.Nat, owner: IDL.Principal, canisterId: IDL.Principal, timestamp: IDL.Int,
      action: IDL.Variant({ Withdraw: IDL.Record({ status, err: IDL.Opt(IDL.Text), transfer }) }),
    }))), err: IDL.Variant({ InternalError: IDL.Text }) });
    const bytes = IDL.encode([upstream], [{ ok: [[1n, { id: 1n, owner: Principal.fromText(OWNER), canisterId: Principal.fromText(POOL), timestamp: 123n,
      action: { Withdraw: { status: { Failed: null }, err: ["BadFee"], transfer: { amount: 1n << 80n, fee: 10000n, token: Principal.fromText(USDC.address) } } } }]] }]);
    const [decoded] = IDL.decode([liquidityReadMethods.getTransactionsByOwner.output], bytes) as [{ ok: [bigint, { action: unknown }][] }];
    expect(decoded.ok[0]?.[1].action).toEqual({ Withdraw: { status: { Failed: null }, err: ["BadFee"],
      transfer: { amount: 1n << 80n, fee: 10000n, token: Principal.fromText(USDC.address) } } });
  });

  test("accepts every deployed status, including retained RemoveLimitOrder LimitOrderDeleted", () => {
    const statuses = ["Completed", "Created", "Failed", "CreditCompleted", "TransferCompleted", "DepositCreditCompleted", "DepositTransferCompleted",
      "PreSwapCompleted", "SwapCompleted", "WithdrawCreditCompleted", "LimitOrderDeleted"];
    const statusType = IDL.Variant(Object.fromEntries(statuses.map((name) => [name, IDL.Null])));
    const upstream = IDL.Variant({ ok: IDL.Vec(IDL.Tuple(IDL.Nat, IDL.Record({ id: IDL.Nat, owner: IDL.Principal, timestamp: IDL.Int,
      action: IDL.Variant({ RemoveLimitOrder: IDL.Record({ status: statusType, err: IDL.Opt(IDL.Text), positionId: IDL.Nat }) }),
    }))) });
    for (const status of statuses) {
      const bytes = IDL.encode([upstream], [{ ok: [[1n, { id: 1n, owner: Principal.fromText(OWNER), timestamp: 1n,
        action: { RemoveLimitOrder: { status: { [status]: null }, err: [], positionId: 42n } } }]] }]);
      const [decoded] = IDL.decode([liquidityReadMethods.getTransactionsByOwner.output], bytes) as [{ ok: [bigint, { action: unknown }][] }];
      expect(decoded.ok[0]?.[1].action).toEqual({ RemoveLimitOrder: { status: { [status]: null }, err: [] } });
    }
  });

  test("the callable contract contains only the audited public read methods", () => {
    expect(Object.keys(liquidityReadMethods).sort()).toEqual([
      "getAvailabilityState", "getCachedTokenFee", "getInitArgs", "getPools", "getTransactionsByOwner",
      "getUserPools", "getUserPosition", "getUserPositionsByPrincipal", "getUserUnusedBalance", "getWithdrawQueueInfo", "metadata",
    ]);
  });
});
