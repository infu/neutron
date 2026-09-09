/** Anonymous, advisory swap quotes from ICPSwap itself. Execution still re-reads
 * and validates the pool in the durable backend before requesting funding.
 * Candid follows upstream v3.7.0, commit 94eeb92ad6ecc2713d38fd3bef48cd4f328a3513.
 */
import { IDL } from "@dfinity/candid";
import { Principal } from "@icp-sdk/core/principal";
import { ICPSWAP_FACTORY, liquidityReadMethods } from "./liquidity_reads";
import { icpswapQuery } from "./ic_query";
import type { SwapQuote, SwapRequest } from "./backend";

const TokenIdl = IDL.Record({ address: IDL.Text, standard: IDL.Text });
const ErrorIdl = IDL.Variant({ CommonError: IDL.Null, InsufficientFunds: IDL.Null, InternalError: IDL.Text, UnsupportedToken: IDL.Text });
const result = (ok: IDL.Type) => IDL.Variant({ ok, err: ErrorIdl });

/** Only public queries. quote returns gross output; it does not enforce the
 * supplied minimum, settle funds, or attest that this owner can execute. */
export const swapQuoteMethods = {
  getPool: {
    args: [IDL.Record({ token0: TokenIdl, token1: TokenIdl, fee: IDL.Nat })],
    output: result(IDL.Record({ key: IDL.Text, token0: TokenIdl, token1: TokenIdl,
      fee: IDL.Nat, tickSpacing: IDL.Int, canisterId: IDL.Principal })),
  },
  metadata: liquidityReadMethods.metadata,
  getCachedTokenFee: liquidityReadMethods.getCachedTokenFee,
  quote: {
    args: [IDL.Record({ zeroForOne: IDL.Bool, amountIn: IDL.Text, amountOutMinimum: IDL.Text })],
    output: result(IDL.Nat),
  },
} satisfies Record<string, { args: IDL.Type[]; output: IDL.Type }>;

export type SwapQuoteMethod = keyof typeof swapQuoteMethods;
export type SwapQuoteQuery = (request: {
  canister: string; method: SwapQuoteMethod; args: unknown[]; signal: AbortSignal;
}) => Promise<unknown>;
export type BrowserSwapQuote = SwapQuote & {
  /** Seconds when the pool metadata and cached ledger fees were observed.
   * These are reused for at most 15 seconds; amount quotes are always fresh. */
  contextAt: number;
};
export type SwapQuoteOptions = {
  decimalsIn: number; decimalsOut: number; feeIn?: bigint | undefined; feeOut?: bigint | undefined; signal?: AbortSignal | undefined;
};

const anonymousQuery: SwapQuoteQuery = (request) => icpswapQuery({ ...request, signature: swapQuoteMethods[request.method] });

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Invalid ${label}: expected record`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`Invalid ${label}: expected text`);
  return value;
}
function nat(value: unknown, label: string): bigint {
  if (typeof value !== "bigint" || value < 0n) throw new Error(`Invalid ${label}: expected Nat`);
  return value;
}
function principalText(value: unknown, label: string): string {
  try {
    return typeof value === "string" ? Principal.fromText(value.toLowerCase()).toText() : Principal.from(value as Principal).toText();
  } catch { throw new Error(`Invalid ${label}: expected principal`); }
}
function unwrap(value: unknown, method: string): unknown {
  const reply = object(value, method);
  if (Object.keys(reply).length !== 1) throw new Error(`Invalid ${method}: expected one result variant`);
  if (Object.hasOwn(reply, "ok")) return reply.ok;
  const error = object(reply.err, `${method} error`);
  if (Object.keys(error).length !== 1) throw new Error(`Invalid ${method}: expected one error variant`);
  const [kind, detail] = Object.entries(error)[0]!;
  if ((kind === "CommonError" || kind === "InsufficientFunds") && detail === null) throw new Error(`${method}: ${kind}`);
  if ((kind === "InternalError" || kind === "UnsupportedToken") && typeof detail === "string") throw new Error(`${method}: ${kind}: ${detail}`);
  throw new Error(`Invalid ${method}: unknown error variant`);
}
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    // The read may already have started before its consumer was cancelled.
    void promise.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then((value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); });
  });
}

type Token = { address: string; standard: string };
type Pool = { pool: string; key: string; token0: Token; token1: Token; fee: number };
type Context = { sqrtPriceX96: bigint; token0Fee: bigint; token1Fee: bigint; at: number };
const CACHE_MS = 15_000;
const FEE_TIERS = [3000, 500, 10000] as const;
function token(value: unknown, label: string): Token {
  const raw = object(value, label);
  return { address: principalText(raw.address, `${label}.address`), standard: text(raw.standard, `${label}.standard`) };
}
function sameToken(left: Token, right: Token): boolean { return left.address === right.address && left.standard === right.standard; }

/** Contexts are shared by pair and direction. Aborting one consumer never
 * cancels another's prefetch; no amount quote is retained in a cache. */
export function createSwapQuoteReader({ query = anonymousQuery, now = Date.now }: {
  query?: SwapQuoteQuery; now?: () => number;
} = {}) {
  const poolCache = new Map<string, { value: Pool[]; expires: number }>();
  const poolFlights = new Map<string, Promise<Pool[]>>();
  const contextCache = new Map<string, { value: Context; expires: number }>();
  const contextFlights = new Map<string, Promise<Context>>();
  const backgroundSignal = new AbortController().signal;

  function cached<T>(key: string, cache: Map<string, { value: T; expires: number }>, flights: Map<string, Promise<T>>, read: () => Promise<T>): Promise<T> {
    const found = cache.get(key);
    if (found && now() < found.expires) return Promise.resolve(found.value);
    const running = flights.get(key);
    if (running) return running;
    const promise = Promise.resolve().then(read).then((value) => {
      cache.set(key, { value, expires: now() + CACHE_MS });
      return value;
    }).finally(() => { flights.delete(key); });
    flights.set(key, promise);
    return promise;
  }
  function pools(input: string, output: string): Promise<Pool[]> {
    const pair = [input, output].sort();
    return cached(pair.join("/"), poolCache, poolFlights, async () => {
      const values = await Promise.all(FEE_TIERS.map(async (tier): Promise<Pool | null> => {
        const value = await query({ canister: ICPSWAP_FACTORY, method: "getPool", signal: backgroundSignal,
          args: [{ token0: { address: pair[0], standard: "ICRC2" }, token1: { address: pair[1], standard: "ICRC2" }, fee: BigInt(tier) }] });
        const reply = object(value, "getPool");
        // v3.7.0 getPool returns exactly CommonError when that tier is absent.
        if (Object.keys(reply).length === 1 && Object.hasOwn(reply, "err")) {
          const error = object(reply.err, "getPool error");
          if (Object.keys(error).length === 1 && error.CommonError === null) return null;
        }
        const raw = object(unwrap(reply, "getPool"), "getPool pool");
        const token0 = token(raw.token0, "getPool.token0"), token1 = token(raw.token1, "getPool.token1");
        if ([token0.address, token1.address].sort().join("/") !== pair.join("/") || nat(raw.fee, "getPool.fee") !== BigInt(tier)) {
          throw new Error("The factory returned a different token pair or fee tier.");
        }
        if (typeof raw.tickSpacing !== "bigint" || raw.tickSpacing <= 0n) throw new Error("Invalid getPool.tickSpacing");
        return { pool: principalText(raw.canisterId, "getPool.canisterId"), key: text(raw.key, "getPool.key"), token0, token1, fee: tier };
      }));
      const found = values.filter((value): value is Pool => value !== null);
      if (new Set(found.map((pool) => pool.pool)).size !== found.length) throw new Error("The factory returned conflicting pool identities.");
      return found;
    });
  }
  function context(pool: Pool): Promise<Context> {
    const key = [pool.pool, pool.key, pool.token0.address, pool.token0.standard, pool.token1.address, pool.token1.standard, pool.fee].join("/");
    return cached(key, contextCache, contextFlights, async () => {
      const [metadataReply, feeReply] = await Promise.all([
        query({ canister: pool.pool, method: "metadata", args: [], signal: backgroundSignal }),
        query({ canister: pool.pool, method: "getCachedTokenFee", args: [], signal: backgroundSignal }),
      ]);
      const raw = object(unwrap(metadataReply, "metadata"), "metadata");
      if (raw.key !== pool.key || nat(raw.fee, "metadata.fee") !== BigInt(pool.fee)
        || !sameToken(token(raw.token0, "metadata.token0"), pool.token0) || !sameToken(token(raw.token1, "metadata.token1"), pool.token1)) {
        throw new Error("Pool metadata disagrees with the canonical factory identity.");
      }
      const sqrtPriceX96 = nat(raw.sqrtPriceX96, "metadata.sqrtPriceX96");
      if (sqrtPriceX96 === 0n) throw new Error("The pool has no current price for a price-impact estimate.");
      nat(raw.liquidity, "metadata.liquidity");
      if (typeof raw.tick !== "bigint") throw new Error("Invalid metadata.tick");
      const fees = object(feeReply, "getCachedTokenFee");
      return { sqrtPriceX96, token0Fee: nat(fees.token0Fee, "getCachedTokenFee.token0Fee"),
        token1Fee: nat(fees.token1Fee, "getCachedTokenFee.token1Fee"), at: Math.floor(now() / 1000) };
    });
  }
  function pair(input: string, output: string): [string, string] {
    const inputAddress = principalText(input, "input token"), outputAddress = principalText(output, "output token");
    if (inputAddress === outputAddress) throw new Error("Choose two different tokens.");
    return [inputAddress, outputAddress];
  }
  async function preparePair(input: string, output: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const [inputAddress, outputAddress] = pair(input, output);
    const work = pools(inputAddress, outputAddress).then((found) => Promise.all(found.map(context)));
    await abortable(work, signal);
  }
  async function quote(request: SwapRequest, options: SwapQuoteOptions): Promise<BrowserSwapQuote> {
    request = { ...request };
    options = { ...options };
    const { signal } = options;
    signal?.throwIfAborted();
    const [inputAddress, outputAddress] = pair(request.inputAddress, request.outputAddress);
    if (typeof request.amountIn !== "bigint" || request.amountIn <= 0n) throw new Error("Enter an amount greater than zero.");
    if (!Number.isSafeInteger(request.slippage) || request.slippage < 0) throw new Error("Invalid slippage tolerance.");
    // Match Swap.normalizeSlippage, including the existing default and ceiling.
    const slippage = request.slippage === 0 ? 500 : Math.min(request.slippage, 50_000);
    for (const decimals of [options.decimalsIn, options.decimalsOut]) {
      if (!Number.isSafeInteger(decimals) || decimals < 0) throw new Error("Token decimals are unavailable.");
    }
    for (const fee of [options.feeIn, options.feeOut]) if (fee !== undefined) nat(fee, "Wallet ledger fee");
    const found = await abortable(pools(inputAddress, outputAddress), signal);
    signal?.throwIfAborted();
    if (!found.length) throw new Error("No ICPSwap pool trades that pair.");
    // Every present tier must answer. A partial network failure is
    // not silently presented as a complete comparison of the available pools.
    const candidates = await abortable(Promise.all(found.map(async (pool) => {
      const [details, value] = await Promise.all([
        context(pool),
        query({ canister: pool.pool, method: "quote", signal: signal ?? backgroundSignal,
          args: [{ zeroForOne: pool.token0.address === inputAddress, amountIn: request.amountIn.toString(), amountOutMinimum: "0" }] }),
      ]);
      return { pool, details, quotedOut: nat(unwrap(value, "quote"), "quote output") };
    })), signal);
    signal?.throwIfAborted();
    let best: typeof candidates[number] | undefined;
    for (const candidate of candidates) if (candidate.quotedOut > (best?.quotedOut ?? 0n)) best = candidate;
    if (!best) throw new Error("No pool could price that amount. Try a different size.");
    const { pool, details, quotedOut } = best;
    const zeroForOne = pool.token0.address === inputAddress;
    if ((zeroForOne ? pool.token0 : pool.token1).standard !== "ICRC2") {
      throw new Error("This swap funding route requires an ICRC2 input token; the factory pool reports an unsupported input standard.");
    }
    const tokenInFee = zeroForOne ? details.token0Fee : details.token1Fee;
    const tokenOutFee = zeroForOne ? details.token1Fee : details.token0Fee;
    for (const [side, cachedFee, live] of [["input", tokenInFee, options.feeIn], ["output", tokenOutFee, options.feeOut]] as const) {
      if (live !== undefined && live !== cachedFee) throw new Error(`The pool's cached ${side} fee (${cachedFee}) disagrees with the ledger (${live}). Swapping now would fail; try again later.`);
    }
    if (request.amountIn <= tokenInFee) throw new Error(`Amount ${request.amountIn} does not cover the ledger fee of ${tokenInFee}.`);
    const amountOutMinimum = quotedOut * 100_000n / (100_000n + BigInt(slippage));
    if (amountOutMinimum === 0n) throw new Error("The amount is too small to protect against slippage.");
    // Decimal scales cancel when comparing atomic output to the atomic pool
    // ratio. Keep even very large token amounts exact until the final display
    // fraction, avoiding floating-point overflow or invented zero impact.
    const square = details.sqrtPriceX96 * details.sqrtPriceX96, q192 = 1n << 192n;
    const numerator = request.amountIn * (zeroForOne ? square : q192);
    const actual = quotedOut * (zeroForOne ? q192 : square);
    const loss = numerator > actual ? numerator - actual : 0n;
    const priceImpact = Number(loss * 1_000_000_000_000_000n / numerator) / 1_000_000_000_000_000;
    if (loss * 100n >= numerator * 15n) throw new Error(`Price impact of ${(priceImpact * 100).toFixed(2)}% is too high for this pool at that size.`);
    return {
      pool: pool.pool, poolKey: pool.key, feeTier: pool.fee, inputAddress, outputAddress,
      decimalsIn: options.decimalsIn, decimalsOut: options.decimalsOut, zeroForOne, amountIn: request.amountIn,
      quotedOut, amountOutMinimum, expectedOut: quotedOut > tokenOutFee ? quotedOut - tokenOutFee : 0n,
      tokenInFee, tokenOutFee, fundingAmount: request.amountIn, totalDebit: request.amountIn + tokenInFee * 2n,
      priceImpact, warn: loss * 100n >= numerator * 5n, slippage, fundingLedger: inputAddress, fundingSpender: pool.pool,
      at: Math.floor(now() / 1000), contextAt: details.at,
    };
  }
  return { preparePair, quote };
}

export const swapQuoteReader = createSwapQuoteReader();
