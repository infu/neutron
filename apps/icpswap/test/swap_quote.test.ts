import { describe, expect, test } from "bun:test";
import { IDL } from "@dfinity/candid";
import { Principal } from "@icp-sdk/core/principal";
import { ICPSWAP_FACTORY } from "../src/liquidity_reads";
import { createSwapQuoteReader, swapQuoteMethods, type SwapQuoteMethod, type SwapQuoteQuery } from "../src/swap_quote";
import type { SwapRequest } from "../src/backend";

const ICP = { address: "ryjl3-tyaaa-aaaaa-aaaba-cai", standard: "ICRC2" };
const USDC = { address: "xevnm-gaaaa-aaaar-qafnq-cai", standard: "ICRC2" };
const POOL = "mohjv-bqaaa-aaaag-qjyia-cai";
const POOL500 = "cglrh-lyaaa-aaaag-qcs4q-cai";
const POOL10000 = "4mmnk-kiaaa-aaaag-qbllq-cai";
const Q96 = 1n << 96n;
const request: SwapRequest = { requestId: "00000000000000000000000000000001", inputAddress: ICP.address, outputAddress: USDC.address, amountIn: 100_000_000n, slippage: 500 };
const options = { decimalsIn: 8, decimalsOut: 6 };
function identity(fee = 3000) {
  return { key: `${ICP.address}_${USDC.address}_${fee}`, token0: { ...ICP }, token1: { ...USDC }, fee: BigInt(fee),
    tickSpacing: fee === 500 ? 10n : fee === 10000 ? 200n : 60n,
    canisterId: Principal.fromText(fee === 500 ? POOL500 : fee === 10000 ? POOL10000 : POOL) };
}
function metadata(fee = 3000) { return { ...identity(fee), sqrtPriceX96: Q96, tick: 0n, liquidity: 10n ** 30n }; }
type QueryRequest = Parameters<SwapQuoteQuery>[0];
type Handler = (request: QueryRequest) => unknown | Promise<unknown>;
function fixture(overrides: Partial<Record<SwapQuoteMethod, Handler>> = {}) {
  let currentTime = 1788888000000;
  const calls: QueryRequest[] = [];
  const handlers: Record<SwapQuoteMethod, Handler> = {
    getPool: ({ args }) => (args[0] as { fee: bigint }).fee === 3000n ? { ok: identity() } : { err: { CommonError: null } },
    metadata: () => ({ ok: metadata() }),
    getCachedTokenFee: () => ({ token0Fee: 1000n, token1Fee: 2000n }),
    quote: ({ args }) => ({ ok: BigInt((args[0] as { amountIn: string }).amountIn) * 997n / 1000n }),
    ...overrides,
  };
  const query: SwapQuoteQuery = async (call) => { calls.push(call); return handlers[call.method](call); };
  const reader = createSwapQuoteReader({ query, now: () => currentTime });
  return { reader, calls, handlers, advance: (ms: number) => { currentTime += ms; } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { await new Promise((resolve) => setTimeout(resolve, 0)); }

describe("direct browser swap quote query path", () => {
  test("a cold quote queries the factory once per tier and pool context in parallel with its amount quote", async () => {
    const gate = deferred<void>();
    const { reader, calls } = fixture({ getCachedTokenFee: async () => { await gate.promise; return { token0Fee: 1000n, token1Fee: 2000n }; } });
    const pending = reader.quote(request, options);
    await flush();
    expect(calls.filter((call) => call.method === "getPool")).toHaveLength(3);
    expect(calls.map((call): string => call.method).sort()).toEqual(["getPool", "getPool", "getPool", "getCachedTokenFee", "metadata", "quote"].sort());
    expect(calls.find((call) => call.method === "quote")?.args).toEqual([{ zeroForOne: true, amountIn: "100000000", amountOutMinimum: "0" }]);
    gate.resolve();
    const result = await pending;
    expect(result.quotedOut).toBe(99_700_000n);
    expect(result.amountOutMinimum).toBe(99_203_980n);
    expect(result.expectedOut).toBe(99_698_000n);
    expect(result.totalDebit).toBe(100_002_000n);
    expect(result.contextAt).toBe(1788888000);
    expect(result.at).toBe(result.contextAt);
    expect(calls.every((call) => [ICPSWAP_FACTORY, POOL].includes(call.canister))).toBe(true);
    expect(calls.some((call) => (call.method as string).includes("deposit") || (call.method as string).includes("approve"))).toBe(false);
  });

  test("prefetched pair changes send one fresh pool.quote only, including identical refresh amounts", async () => {
    const { reader, calls, advance } = fixture();
    await reader.preparePair(ICP.address, USDC.address);
    expect(calls).toHaveLength(5);
    advance(2000);
    const first = await reader.quote(request, options);
    const second = await reader.quote({ ...request, amountIn: 200_000_000n }, options);
    const repeat = await reader.quote({ ...request, amountIn: 200_000_000n }, options);
    expect(calls.slice(5).map((call) => call.method)).toEqual(["quote", "quote", "quote"]);
    expect(first.amountIn).toBe(100_000_000n);
    expect(second.amountIn).toBe(200_000_000n);
    expect(second.quotedOut).toBe(199_400_000n);
    expect(repeat.quotedOut).toBe(second.quotedOut);
    expect(first.at - first.contextAt).toBe(2);
  });

  test("opposite direction reuses discovery and context, reversing cached fees and quote direction", async () => {
    const { reader, calls } = fixture();
    await reader.preparePair(ICP.address, USDC.address);
    const quote = await reader.quote({ ...request, inputAddress: USDC.address, outputAddress: ICP.address }, { ...options, feeIn: 2000n, feeOut: 1000n });
    expect(calls).toHaveLength(6);
    expect(calls.at(-1)?.args).toEqual([{ zeroForOne: false, amountIn: request.amountIn.toString(), amountOutMinimum: "0" }]);
    expect(quote.zeroForOne).toBe(false);
    expect(quote.tokenInFee).toBe(2000n);
    expect(quote.tokenOutFee).toBe(1000n);
    expect(quote.totalDebit).toBe(100_004_000n);
    expect(quote.fundingLedger).toBe(USDC.address);
  });

  test("context and absent fee tiers refresh after 15 seconds, without caching quote amounts", async () => {
    const { reader, calls, advance, handlers } = fixture();
    await reader.preparePair(ICP.address, USDC.address);
    advance(14999);
    await reader.quote(request, options);
    expect(calls).toHaveLength(6);
    advance(1);
    handlers.getCachedTokenFee = () => ({ token0Fee: 1234n, token1Fee: 5678n });
    const fresh = await reader.quote(request, options);
    expect(calls.slice(6).map((call): string => call.method).sort()).toEqual(["getPool", "getPool", "getPool", "metadata", "getCachedTokenFee", "quote"].sort());
    expect(fresh.contextAt).toBe(1788888015);
    expect(fresh.tokenInFee).toBe(1234n);
  });

  test("all three present tiers are compared on every amount, with the best gross quote chosen", async () => {
    const feeFor = (canister: string) => canister === POOL500 ? 500 : canister === POOL10000 ? 10000 : 3000;
    const { reader, calls } = fixture({
      getPool: ({ args }) => ({ ok: identity(Number((args[0] as { fee: bigint }).fee)) }),
      metadata: ({ canister }) => ({ ok: metadata(feeFor(canister)) }),
      quote: ({ canister, args }) => {
        const amount = BigInt((args[0] as { amountIn: string }).amountIn);
        const best = amount === request.amountIn ? POOL500 : POOL10000;
        return { ok: amount * (canister === best ? 999n : 990n) / 1000n };
      },
    });
    await reader.preparePair(ICP.address, USDC.address);
    const first = await reader.quote(request, options);
    const next = await reader.quote({ ...request, amountIn: request.amountIn * 2n }, options);
    expect(first.pool).toBe(POOL500);
    expect(first.feeTier).toBe(500);
    expect(next.pool).toBe(POOL10000);
    expect(calls.filter((call) => call.method === "getPool")).toHaveLength(3);
    expect(calls.filter((call) => call.method === "quote")).toHaveLength(6);
  });

  test("partial factory or pool network failures are not represented as complete best-route coverage", async () => {
    const { reader, handlers } = fixture({ getPool: ({ args }) => {
      if ((args[0] as { fee: bigint }).fee === 500n) throw new Error("factory unavailable");
      return { ok: identity(Number((args[0] as { fee: bigint }).fee)) };
    } });
    await expect(reader.quote(request, options)).rejects.toThrow("factory unavailable");
    handlers.getPool = ({ args }) => ({ ok: identity(Number((args[0] as { fee: bigint }).fee)) });
    handlers.metadata = ({ canister }) => ({ ok: metadata(canister === POOL500 ? 500 : canister === POOL10000 ? 10000 : 3000) });
    handlers.quote = ({ canister }) => {
      if (canister === POOL500) throw new Error("pool query unavailable");
      return { ok: 99_700_000n };
    };
    await expect(reader.quote(request, options)).rejects.toThrow("pool query unavailable");
  });

  test("factory absence differs from unsupported or malformed error responses", async () => {
    const { reader, handlers, advance } = fixture({ getPool: () => ({ err: { CommonError: null } }) });
    await expect(reader.quote(request, options)).rejects.toThrow("No ICPSwap pool trades");
    handlers.getPool = () => ({ err: { InternalError: "upgrade in progress" } });
    advance(15000);
    await expect(reader.quote(request, options)).rejects.toThrow("upgrade in progress");
    handlers.getPool = () => ({ ok: identity(), err: { CommonError: null } });
    await expect(reader.quote(request, options)).rejects.toThrow("expected one result variant");
  });

  test("the factory's token pair, tier, and each pool's metadata identity must agree", async () => {
    for (const alter of [
      (raw: ReturnType<typeof identity>) => ({ ...raw, token1: { ...raw.token1, address: ICPSWAP_FACTORY } }),
      (raw: ReturnType<typeof identity>) => ({ ...raw, fee: 500n }),
    ]) {
      const { reader } = fixture({ getPool: () => ({ ok: alter(identity()) }) });
      await expect(reader.quote(request, options)).rejects.toThrow("different token pair or fee tier");
    }
    for (const altered of [
      { ...metadata(), key: "wrong-pool" },
      { ...metadata(), token0: { ...ICP, standard: "ICRC1" } },
      { ...metadata(), fee: 500n },
    ]) {
      const { reader } = fixture({ metadata: () => ({ ok: altered }) });
      await expect(reader.quote(request, options)).rejects.toThrow("disagrees with the canonical factory");
    }
  });

  test("failed context is not cached and a subsequent successful read recovers", async () => {
    const { reader, calls, handlers } = fixture({ metadata: () => ({ err: { InternalError: "not ready" } }) });
    await expect(reader.quote(request, options)).rejects.toThrow("not ready");
    handlers.metadata = () => ({ ok: metadata() });
    const result = await reader.quote(request, options);
    expect(result.priceImpact).toBeCloseTo(0.003);
    expect(calls.filter((call) => call.method === "getPool")).toHaveLength(3);
    expect(calls.filter((call) => call.method === "metadata")).toHaveLength(2);
  });
});

describe("exact swap planning arithmetic and validation", () => {
  test("keeps extremely large amounts exact through fees, minimum and impact", async () => {
    const amount = 10n ** 400n + 123456789012345678901234567890n;
    const { reader } = fixture();
    const result = await reader.quote({ ...request, amountIn: amount }, options);
    const gross = amount * 997n / 1000n;
    expect(result.amountIn).toBe(amount);
    expect(result.fundingAmount).toBe(amount);
    expect(result.totalDebit).toBe(amount + 2000n);
    expect(result.quotedOut).toBe(gross);
    expect(result.amountOutMinimum).toBe(gross * 100000n / 100500n);
    expect(result.expectedOut).toBe(gross - 2000n);
    expect(result.priceImpact).toBeCloseTo(0.003);
  });

  test("same default/clamped slippage and gross-output minimum as Swap.mo", async () => {
    const { reader } = fixture();
    expect((await reader.quote({ ...request, slippage: 0 }, options)).slippage).toBe(500);
    const max = await reader.quote({ ...request, slippage: 99999 }, options);
    expect(max.slippage).toBe(50000);
    expect(max.amountOutMinimum).toBe(max.quotedOut * 100000n / 150000n);
    await expect(reader.quote({ ...request, slippage: -1 }, options)).rejects.toThrow("Invalid slippage");
    await expect(reader.quote({ ...request, slippage: 0.5 }, options)).rejects.toThrow("Invalid slippage");
  });

  test("retains existing 5% warning and 15% blocking thresholds without rounding away a boundary", async () => {
    const { reader, handlers } = fixture();
    handlers.quote = () => ({ ok: 95_000_000n });
    expect((await reader.quote(request, options)).warn).toBe(true);
    handlers.quote = () => ({ ok: 95_000_001n });
    expect((await reader.quote(request, options)).warn).toBe(false);
    handlers.quote = () => ({ ok: 85_000_001n });
    expect((await reader.quote(request, options)).priceImpact).toBeLessThan(0.15);
    handlers.quote = () => ({ ok: 85_000_000n });
    await expect(reader.quote(request, options)).rejects.toThrow("15.00%");
    handlers.quote = () => ({ ok: 101_000_000n });
    expect((await reader.quote(request, options)).priceImpact).toBe(0);
  });

  test("price ratio and direction use atomic units correctly, including legitimate zero decimals", async () => {
    const { reader, handlers } = fixture({ metadata: () => ({ ok: { ...metadata(), sqrtPriceX96: Q96 * 2n } }) });
    handlers.quote = () => ({ ok: 398_800_000n });
    const forward = await reader.quote(request, { decimalsIn: 0, decimalsOut: 18 });
    expect(forward.priceImpact).toBeCloseTo(0.003);
    handlers.quote = () => ({ ok: 24_925_000n });
    const reverse = await reader.quote({ ...request, inputAddress: USDC.address, outputAddress: ICP.address }, { decimalsIn: 18, decimalsOut: 0 });
    expect(reverse.priceImpact).toBeCloseTo(0.003);
  });

  test("missing or zero metadata cannot be mislabeled as zero price impact", async () => {
    for (const value of [undefined, 0n, -1n, "79228162514264337593543950336"]) {
      const { reader } = fixture({ metadata: () => ({ ok: { ...metadata(), sqrtPriceX96: value } }) });
      await expect(reader.quote(request, options)).rejects.toThrow(value === 0n ? "no current price" : "expected Nat");
    }
    const { reader, calls } = fixture();
    await expect(reader.quote(request, { decimalsIn: Number.NaN, decimalsOut: 6 })).rejects.toThrow("decimals are unavailable");
    expect(calls).toHaveLength(0);
  });

  test("checks live Wallet fee agreement on both sides and retains input/approval fee reserves", async () => {
    const { reader } = fixture();
    await expect(reader.quote(request, { ...options, feeIn: 999n })).rejects.toThrow("cached input fee (1000) disagrees with the ledger (999)");
    await expect(reader.quote(request, { ...options, feeOut: 999n })).rejects.toThrow("cached output fee (2000) disagrees with the ledger (999)");
    const result = await reader.quote(request, { ...options, feeIn: 1000n, feeOut: 2000n });
    expect(result.totalDebit).toBe(request.amountIn + 2000n);
    await expect(reader.quote({ ...request, amountIn: 1000n }, options)).rejects.toThrow("does not cover the ledger fee");
  });

  test("rejects empty or zero minimum quotes but distinguishes net-zero output after its transfer fee", async () => {
    const { reader, handlers } = fixture();
    await expect(reader.quote({ ...request, amountIn: 0n }, options)).rejects.toThrow("greater than zero");
    handlers.quote = () => ({ ok: 0n });
    await expect(reader.quote(request, options)).rejects.toThrow("No pool could price");
    handlers.quote = () => ({ ok: 1n });
    await expect(reader.quote(request, options)).rejects.toThrow("too small to protect");
    handlers.quote = () => ({ ok: 1900n });
    const result = await reader.quote({ ...request, amountIn: 2000n }, options);
    expect(result.expectedOut).toBe(0n);
    expect(result.quotedOut).toBe(1900n);
  });

  test("unsupported input funding standard is rejected and never silently changes best-pool selection", async () => {
    const unsupported = { ...identity(), token0: { ...ICP, standard: "ICRC1" } };
    const { reader } = fixture({
      getPool: ({ args }) => (args[0] as { fee: bigint }).fee === 3000n ? { ok: unsupported } : { err: { CommonError: null } },
      metadata: () => ({ ok: { ...metadata(), token0: unsupported.token0 } }),
    });
    await expect(reader.quote(request, options)).rejects.toThrow("requires an ICRC2 input token");
    const reverse = await reader.quote({ ...request, inputAddress: USDC.address, outputAddress: ICP.address }, options);
    expect(reverse.zeroForOne).toBe(false);
  });

  test("malformed principals, fee atoms and quote result variants are rejected", async () => {
    const { reader, handlers } = fixture();
    await expect(reader.quote({ ...request, inputAddress: "invalid" }, options)).rejects.toThrow("expected principal");
    await expect(reader.quote({ ...request, outputAddress: ICP.address }, options)).rejects.toThrow("two different tokens");
    await expect(reader.quote(request, { ...options, feeIn: -1n })).rejects.toThrow("expected Nat");
    for (const reply of [{ ok: "100000000" }, { ok: -1n }, { ok: 100000000 }, { ok: 10n, err: { CommonError: null } }]) {
      handlers.quote = () => reply;
      await expect(reader.quote(request, options)).rejects.toThrow("Invalid quote");
    }
  });
});

describe("quote cancellation and Candid compatibility", () => {
  test("concurrent prefetch shares requests while cancelling one consumer leaves the other working", async () => {
    const gate = deferred<void>();
    const { reader, calls } = fixture({ getPool: async ({ args }) => {
      await gate.promise;
      return (args[0] as { fee: bigint }).fee === 3000n ? { ok: identity() } : { err: { CommonError: null } };
    } });
    const first = new AbortController(), second = new AbortController();
    const cancelled = reader.preparePair(ICP.address, USDC.address, first.signal);
    const accepted = reader.preparePair(USDC.address, ICP.address, second.signal);
    await flush();
    expect(calls).toHaveLength(3);
    first.abort(new DOMException("pair changed", "AbortError"));
    await expect(cancelled).rejects.toThrow("pair changed");
    expect(calls.every((call) => !call.signal.aborted)).toBe(true);
    gate.resolve();
    await accepted;
    expect(calls).toHaveLength(5);
    await reader.quote(request, options);
    expect(calls).toHaveLength(6);
  });

  test("an in-flight quote rejects promptly on abort and a late result cannot populate the next amount", async () => {
    const late = deferred<unknown>();
    const { reader, handlers, calls } = fixture();
    await reader.preparePair(ICP.address, USDC.address);
    handlers.quote = () => late.promise;
    const controller = new AbortController();
    const pending = reader.quote(request, { ...options, signal: controller.signal });
    await flush();
    controller.abort(new DOMException("new amount", "AbortError"));
    await expect(pending).rejects.toThrow("new amount");
    late.resolve({ ok: 99_700_000n });
    handlers.quote = () => ({ ok: 199_000_000n });
    const fresh = await reader.quote({ ...request, amountIn: 200_000_000n }, options);
    expect(fresh.amountIn).toBe(200_000_000n);
    expect(fresh.quotedOut).toBe(199_000_000n);
    expect(calls.slice(5).map((call) => call.method)).toEqual(["quote", "quote"]);
  });

  test("pre-aborted calls dispatch nothing; mutable caller objects cannot replace in-flight quote inputs", async () => {
    const { reader, calls, handlers } = fixture();
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(reader.preparePair(ICP.address, USDC.address, controller.signal)).rejects.toThrow("cancelled");
    await expect(reader.quote(request, { ...options, signal: controller.signal })).rejects.toThrow("cancelled");
    expect(calls).toHaveLength(0);
    const gate = deferred<void>();
    handlers.getPool = async ({ args }) => {
      await gate.promise;
      return (args[0] as { fee: bigint }).fee === 3000n ? { ok: identity() } : { err: { CommonError: null } };
    };
    const mutable = { ...request };
    const pending = reader.quote(mutable, options);
    mutable.amountIn = 200_000_000n;
    gate.resolve();
    const result = await pending;
    expect(result.amountIn).toBe(request.amountIn);
    expect(calls.find((call) => call.method === "quote")?.args).toEqual([{ zeroForOne: true, amountIn: request.amountIn.toString(), amountOutMinimum: "0" }]);
  });

  test("methods round-trip independent v3.7.0 full Candid records, including metadata projection", () => {
    const token = IDL.Record({ address: IDL.Text, standard: IDL.Text });
    const error = IDL.Variant({ CommonError: IDL.Null, InternalError: IDL.Text, UnsupportedToken: IDL.Text, InsufficientFunds: IDL.Null });
    const pool = IDL.Record({ key: IDL.Text, token0: token, token1: token, fee: IDL.Nat, tickSpacing: IDL.Int, canisterId: IDL.Principal });
    const upstreamMetadata = IDL.Record({ key: IDL.Text, token0: token, token1: token, fee: IDL.Nat, tick: IDL.Int,
      liquidity: IDL.Nat, sqrtPriceX96: IDL.Nat, maxLiquidityPerTick: IDL.Nat, nextPositionId: IDL.Nat });
    const upstreamQuote = IDL.Record({ zeroForOne: IDL.Bool, amountIn: IDL.Text, amountOutMinimum: IDL.Text });
    const samples: { method: SwapQuoteMethod; args: unknown[]; upstreamArgs: IDL.Type[]; upstreamOutput: IDL.Type; output: unknown }[] = [
      { method: "getPool", args: [{ token0: ICP, token1: USDC, fee: 3000n }], upstreamArgs: [IDL.Record({ token0: token, token1: token, fee: IDL.Nat })], upstreamOutput: IDL.Variant({ ok: pool, err: error }), output: { ok: identity() } },
      { method: "metadata", args: [], upstreamArgs: [], upstreamOutput: IDL.Variant({ ok: upstreamMetadata, err: error }), output: { ok: { ...metadata(), maxLiquidityPerTick: 10n ** 30n, nextPositionId: 5089n } } },
      { method: "getCachedTokenFee", args: [], upstreamArgs: [], upstreamOutput: IDL.Record({ token0Fee: IDL.Nat, token1Fee: IDL.Nat }), output: { token0Fee: 1000n, token1Fee: 2000n } },
      { method: "quote", args: [{ zeroForOne: true, amountIn: (10n ** 30n).toString(), amountOutMinimum: "0" }], upstreamArgs: [upstreamQuote], upstreamOutput: IDL.Variant({ ok: IDL.Nat, err: error }), output: { ok: 90071992547409931234567890123n } },
    ];
    for (const sample of samples) {
      const signature = swapQuoteMethods[sample.method];
      const args = IDL.decode(sample.upstreamArgs, IDL.encode(signature.args, sample.args));
      expect(args as unknown).toEqual(sample.args);
      const [response] = IDL.decode([signature.output], IDL.encode([sample.upstreamOutput], [sample.output]));
      if (sample.method === "metadata") {
        expect((response as { ok: { sqrtPriceX96: bigint } }).ok.sqrtPriceX96).toBe(Q96);
        expect(Object.hasOwn((response as { ok: object }).ok, "nextPositionId")).toBe(false);
      } else expect(response as unknown).toEqual(sample.output);
    }
    const rejected = { err: { InternalError: "preswap #InvalidPriceLimit" } };
    expect(IDL.decode([swapQuoteMethods.quote.output], IDL.encode([IDL.Variant({ ok: IDL.Nat, err: error })], [rejected]))).toEqual([rejected]);
    expect(Object.keys(swapQuoteMethods).sort()).toEqual(["getPool", "metadata", "getCachedTokenFee", "quote"].sort());
  });
});
