import { describe, expect, spyOn, test } from "bun:test";
import { Cbor, HttpAgent, QueryResponseStatus, type HttpAgentOptions, type RequestId } from "@icp-sdk/core/agent";
import { IDL } from "@dfinity/candid";
import { createLiquidityQueryTransport, createLiquidityReadClient, liquidityReadMethods, ICPSWAP_QUERY_HOST, type LiquidityReadMethod } from "../src/liquidity_reads";
import { createIcpswapQueryTransport } from "../src/ic_query";
import { swapQuoteMethods } from "../src/swap_quote";

const POOL = "mohjv-bqaaa-aaaag-qjyia-cai";
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { await new Promise((resolve) => setTimeout(resolve, 0)); }
type Call = { canister: string; method: LiquidityReadMethod; args: unknown[] };
function fixture(respond: (call: Call) => unknown | Promise<unknown> = () => ({ token0Fee: 10000n, token1Fee: 20000n })) {
  const calls: Call[] = [];
  const creations: HttpAgentOptions[] = [];
  const agent = HttpAgent.createSync({ fetch: Object.assign(async () => { throw new Error("Unexpected network request in transport fixture"); }, fetch) });
  agent.call = async () => { throw new Error("A read attempted an update"); };
  agent.query = async (canister, query) => {
    const method = query.methodName as LiquidityReadMethod;
    const signature = liquidityReadMethods[method];
    const call = { canister: canister.toString(), method, args: IDL.decode(signature.args, query.arg) };
    calls.push(call);
    const value = await respond(call);
    return { status: QueryResponseStatus.Replied, reply: { arg: IDL.encode([signature.output], [value]) },
      httpDetails: { ok: true, status: 200, statusText: "OK", headers: [] }, requestId: new Uint8Array(32) as RequestId };
  };
  const query = createLiquidityQueryTransport({ createAgent: async (options) => { creations.push(options); return agent; } });
  const request = (signal = new AbortController().signal) => query({ canister: POOL, method: "getCachedTokenFee", args: [], signal });
  return { query, request, agent, calls, creations };
}

describe("shared verified liquidity query transport", () => {
  test("concurrent and later reads retain one agent while returning fresh Candid results", async () => {
    let fee = 10000n;
    const { request, calls, creations } = fixture(() => ({ token0Fee: fee++, token1Fee: 20000n }));
    const [first, second] = await Promise.all([request(), request()]);
    const third = await request();
    expect(first).toEqual({ token0Fee: 10000n, token1Fee: 20000n });
    expect(second).toEqual({ token0Fee: 10001n, token1Fee: 20000n });
    expect(third).toEqual({ token0Fee: 10002n, token1Fee: 20000n });
    expect(creations).toHaveLength(1);
    expect(creations[0]?.host).toBe(ICPSWAP_QUERY_HOST);
    expect(creations[0]?.verifyQuerySignatures).toBe(true);
    expect(creations[0]?.subnetNodeKeyExpirableStore?.expirationTime).toBe(300000);
    expect(calls).toEqual(Array.from({ length: 3 }, () => ({ canister: POOL, method: "getCachedTokenFee", args: [] })));
    expect(Object.hasOwn(creations[0]!, "identity")).toBe(false);
    expect(Object.hasOwn(creations[0]!, "fetch")).toBe(false);
    expect(Object.hasOwn(creations[0]!, "fetchOptions")).toBe(false);
  });

  test("query method and exact position Nat go through the Candid codec", async () => {
    const position = { tickLower: -35460n, tickUpper: -35100n, liquidity: 98765432109876543210987n, tokensOwed0: 23n, tokensOwed1: 7n };
    const { query, calls, creations } = fixture(() => ({ ok: position }));
    const id = 9007199254740993123456789n;
    const result = await query({ canister: POOL, method: "getUserPosition", args: [id], signal: new AbortController().signal });
    expect(result).toEqual({ ok: position });
    expect(calls).toEqual([{ canister: POOL, method: "getUserPosition", args: [id] }]);
    expect(creations).toHaveLength(1);
  });

  test("a pre-aborted read does not initialize the agent or dispatch a query", async () => {
    const { request, calls, creations } = fixture();
    const controller = new AbortController(); controller.abort(new DOMException("Panel closed", "AbortError"));
    await expect(request(controller.signal)).rejects.toThrow("Panel closed");
    expect(calls).toHaveLength(0);
    expect(creations).toHaveLength(0);
  });

  test("cancellation rejects promptly without disrupting another query using the same agent", async () => {
    const late = deferred<unknown>();
    let count = 0;
    const { request, calls, creations } = fixture(() => ++count === 1 ? late.promise : ({ token0Fee: 123n, token1Fee: 456n }));
    const controller = new AbortController();
    const pending = request(controller.signal);
    await flush();
    controller.abort(new DOMException("Selection changed", "AbortError"));
    await expect(pending).rejects.toThrow("Selection changed");
    expect(await request()).toEqual({ token0Fee: 123n, token1Fee: 456n });
    late.resolve({ token0Fee: 999n, token1Fee: 888n });
    await flush();
    expect(await request()).toEqual({ token0Fee: 123n, token1Fee: 456n });
    expect(calls).toHaveLength(3);
    expect(creations).toHaveLength(1);
  });

  test("cancellation while the agent is initializing does not discard its shared initialization", async () => {
    const gate = deferred<HttpAgent>();
    const base = fixture();
    let initializations = 0;
    const query = createLiquidityQueryTransport({ createAgent: () => { initializations++; return gate.promise; } });
    const controller = new AbortController();
    const cancelled = query({ canister: POOL, method: "getCachedTokenFee", args: [], signal: controller.signal });
    const accepted = query({ canister: POOL, method: "getCachedTokenFee", args: [], signal: new AbortController().signal });
    controller.abort(new DOMException("Navigated away", "AbortError"));
    await expect(cancelled).rejects.toThrow("Navigated away");
    gate.resolve(base.agent);
    expect(await accepted).toEqual({ token0Fee: 10000n, token1Fee: 20000n });
    expect(initializations).toBe(1);
    expect(base.calls).toHaveLength(1);
  });

  test("failed initialization is retried; an individual query failure keeps the healthy agent", async () => {
    let reads = 0;
    const base = fixture(() => {
      if (++reads === 1) throw new Error("One read failed");
      return { token0Fee: 10000n, token1Fee: 20000n };
    });
    let initializations = 0;
    const query = createLiquidityQueryTransport({ createAgent: async () => {
      if (++initializations === 1) throw new Error("Initialization failed");
      return base.agent;
    } });
    const read = () => query({ canister: POOL, method: "getCachedTokenFee", args: [], signal: new AbortController().signal });
    await expect(read()).rejects.toThrow("Initialization failed");
    await expect(read()).rejects.toThrow("One read failed");
    expect(await read()).toEqual({ token0Fee: 10000n, token1Fee: 20000n });
    expect(initializations).toBe(2);
    expect(base.calls).toHaveLength(2);
  });

  test("client invalidation cancels its consumers and a fresh query retains the verified transport", async () => {
    const late = deferred<unknown>();
    let reads = 0;
    const { query, creations, calls } = fixture(() => ++reads === 1 ? late.promise : ({ ok: [] }));
    const client = createLiquidityReadClient({ query });
    const pending = client.discoverPools();
    await flush();
    client.invalidate();
    await expect(pending).rejects.toThrow();
    expect((await client.discoverPools()).pools).toEqual([]);
    late.resolve({ ok: [] });
    await flush();
    expect(creations).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  test("replica rejection preserves the method, canister and diagnostic code", async () => {
    const { agent, request } = fixture();
    agent.query = async () => ({ status: QueryResponseStatus.Rejected, reject_code: 5, error_code: "IC0503", reject_message: "Pool upgrade is in progress",
      httpDetails: { ok: true, status: 200, statusText: "OK", headers: [] }, requestId: new Uint8Array(32) as RequestId });
    await expect(request()).rejects.toThrow(`getCachedTokenFee on ${POOL} rejected (5, IC0503): Pool upgrade is in progress`);
  });

  test("an invalid Candid result is rejected rather than returned as an empty read", async () => {
    const { agent, request } = fixture();
    agent.query = async () => ({ status: QueryResponseStatus.Replied, reply: { arg: IDL.encode([IDL.Text], ["wrong result"]) },
      httpDetails: { ok: true, status: 200, statusText: "OK", headers: [] }, requestId: new Uint8Array(32) as RequestId });
    await expect(request()).rejects.toThrow();
  });

  test("the opaque-origin key store retains the SDK's expiration and invalidation behavior", async () => {
    const { request, creations } = fixture();
    await request();
    const store = creations[0]!.subnetNodeKeyExpirableStore!;
    const keys: Awaited<ReturnType<HttpAgent["fetchSubnetKeys"]>> = new Map();
    const clock = spyOn(Date, "now").mockReturnValue(1000);
    try {
      await store.set("pool", keys);
      expect(await store.get("pool")).toBe(keys);
      clock.mockReturnValue(300999);
      expect(await store.get("pool")).toBe(keys);
      clock.mockReturnValue(301000);
      expect(await store.get("pool")).toBeUndefined();
      await store.set("pool", keys);
      await store.delete("pool");
      expect(await store.get("pool")).toBeUndefined();
    } finally { clock.mockRestore(); }
  });

  test("the SDK pipeline emits a distinct CBOR query nonce for liquidity and swap refreshes", async () => {
    const requests: { method: string; nonce: string; args: unknown[] }[] = [];
    const query = createIcpswapQueryTransport({ createAgent: async (options) => {
      expect(options.verifyQuerySignatures).toBe(true);
      expect(options.subnetNodeKeyExpirableStore?.expirationTime).toBe(300000);
      // This fixture exercises real SDK serialization against an unsigned
      // local reply. Production signature verification is also checked by the
      // opaque-origin live probe; production always receives the true option.
      return HttpAgent.createSync({ ...options, verifyQuerySignatures: false, retryTimes: 0,
        fetch: Object.assign(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
          if (!(init?.body instanceof Uint8Array)) throw new Error("Expected CBOR query bytes");
          const envelope = Cbor.decode(init.body) as { content: { request_type: string; method_name: string; nonce: Uint8Array; arg: Uint8Array } };
          const content = envelope.content;
          expect(content.request_type).toBe("query");
          expect(content.nonce).toBeInstanceOf(Uint8Array);
          expect(content.nonce.byteLength).toBe(16);
          const signature = content.method_name === "quote" ? swapQuoteMethods.quote : liquidityReadMethods.getCachedTokenFee;
          requests.push({ method: content.method_name, nonce: Array.from(content.nonce).map((byte) => byte.toString(16).padStart(2, "0")).join(""),
            args: IDL.decode(signature.args, content.arg) });
          const value = content.method_name === "quote" ? { ok: 987654321098765432109n } : { token0Fee: 10000n, token1Fee: 20000n };
          const body = Cbor.encode({ status: "replied", reply: { arg: IDL.encode([signature.output], [value]) } });
          return new Response(body.buffer as ArrayBuffer, { status: 200, headers: { "Content-Type": "application/cbor" } });
        }, fetch) });
    } });
    for (const method of ["getCachedTokenFee", "quote", "getCachedTokenFee", "quote"] as const) {
      const signature = method === "quote" ? swapQuoteMethods.quote : liquidityReadMethods.getCachedTokenFee;
      const args = method === "quote" ? [{ zeroForOne: true, amountIn: "10000000", amountOutMinimum: "0" }] : [];
      const reply = await query({ canister: POOL, method, args, signature, signal: new AbortController().signal });
      expect(reply).toEqual(method === "quote" ? { ok: 987654321098765432109n } : { token0Fee: 10000n, token1Fee: 20000n });
    }
    expect(requests.map((request) => request.method)).toEqual(["getCachedTokenFee", "quote", "getCachedTokenFee", "quote"]);
    expect(new Set(requests.map((request) => request.nonce)).size).toBe(4);
    expect(requests[1]?.args).toEqual([{ zeroForOne: true, amountIn: "10000000", amountOutMinimum: "0" }]);
  });
});
