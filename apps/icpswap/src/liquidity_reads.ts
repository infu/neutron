/** Public, anonymous ICPSwap queries. No ledger reads, updates, or identity keys.
 * Candid is pinned to ICPSwap v3.7.0, upstream commit
 * 94eeb92ad6ecc2713d38fd3bef48cd4f328a3513, checked against production 2026-09-08.
 * These observations inform display; the backend revalidates every effect.
 */
import { IDL } from "@dfinity/candid";
import { Principal } from "@icp-sdk/core/principal";
import { AccountIdentifier } from "@icp-sdk/canisters/ledger/icp";
import { amountsForLiquidity, getSqrtRatioAtTick } from "./liquidity_math";
import { createIcpswapQueryTransport, icpswapQuery, ICPSWAP_QUERY_HOST, type IcpswapQueryTransportOptions } from "./ic_query";

export const ICPSWAP_FACTORY = "4mmnk-kiaaa-aaaag-qbllq-cai";
export { ICPSWAP_QUERY_HOST } from "./ic_query";
export type ReadSource = { kind: "direct-canister-query"; host: string; observedAt: string };
export type ReadIssue = { canister: string; method: string; message: string };
export type PoolIdentity = {
  pool: string; key: string;
  token0: { address: string; standard: string };
  token1: { address: string; standard: string };
  fee: number; tickSpacing: number;
};
export type BrowserPosition = {
  id: string; tickLower: number; tickUpper: number; liquidity: string;
  tokensOwed0: string | null; tokensOwed1: string | null;
  amount0: string | null; amount1: string | null; feeError: string | null;
};
export type BrowserWithdrawal = {
  /** Queue amount is the net scheduled transfer; it is not settled receipt. */
  transactionId: string; token: string; amount: string; fee: string;
  owner: string; recipient: string; recipientSubaccount: string | null;
};
export type BrowserTransaction = {
  id: string; owner: string; timestampNs: string; action: string;
  status: string; error: string | null;
  token: string | null; amount: string; unusedReserved: boolean; supportRequired: boolean;
};
export type PoolDiscovery = { pools: PoolIdentity[]; source: ReadSource };
export type OwnedPoolDiscovery = PoolDiscovery & {
  owner: string; indexedPools: string[] | null; retainedPools: string[]; errors: ReadIssue[];
};
export type BrowserPoolView = {
  pool: PoolIdentity; owner: string | null;
  metadata: { sqrtPriceX96: string; tick: number; liquidity: string } | null;
  positions: BrowserPosition[] | null;
  unused: { balance0: string; balance1: string } | null;
  /** Observed reservations and remaining credit, revalidated by the backend. */
  reserved: { balance0: string; balance1: string } | null;
  availableUnused: { balance0: string; balance1: string } | null;
  cachedFees: { token0Fee: string; token1Fee: string } | null;
  available: boolean | null;
  withdrawals: BrowserWithdrawal[] | null; transactions: BrowserTransaction[] | null;
  errors: ReadIssue[]; source: ReadSource;
};

const ErrorIdl = IDL.Variant({ CommonError: IDL.Null, InsufficientFunds: IDL.Null, InternalError: IDL.Text, UnsupportedToken: IDL.Text });
const result = (ok: IDL.Type) => IDL.Variant({ ok, err: ErrorIdl });
const TokenIdl = IDL.Record({ address: IDL.Text, standard: IDL.Text });
const PositionIdl = IDL.Record({
  id: IDL.Nat, tickLower: IDL.Int, tickUpper: IDL.Int, liquidity: IDL.Nat,
  tokensOwed0: IDL.Nat, tokensOwed1: IDL.Nat,
});
const CurrentPositionIdl = IDL.Record({
  tickLower: IDL.Int, tickUpper: IDL.Int, liquidity: IDL.Nat,
  tokensOwed0: IDL.Nat, tokensOwed1: IDL.Nat,
});
const MetadataIdl = IDL.Record({
  key: IDL.Text, fee: IDL.Nat, token0: TokenIdl, token1: TokenIdl,
  sqrtPriceX96: IDL.Nat, tick: IDL.Int, liquidity: IDL.Nat,
});
const AccountIdl = IDL.Record({ owner: IDL.Principal, subaccount: IDL.Opt(IDL.Vec(IDL.Nat8)) });
const WithdrawIdl = IDL.Record({
  txIndex: IDL.Nat, caller: IDL.Principal, token: TokenIdl, amount: IDL.Nat,
  fee: IDL.Nat, to: AccountIdl,
});
// Every upstream action exposes status and err. Record projection discards
// amounts irrelevant to diagnostics; the complete action variants are retained.
const ActionStatusIdl = IDL.Variant(Object.fromEntries([
  "Completed", "Created", "Failed", "CreditCompleted", "TransferCompleted",
  "DepositCreditCompleted", "DepositTransferCompleted", "PreSwapCompleted",
  "SwapCompleted", "WithdrawCreditCompleted", "LimitOrderDeleted",
].map((name) => [name, IDL.Null])));
const ActionInfoIdl = IDL.Record({ status: ActionStatusIdl, err: IDL.Opt(IDL.Text) });
const TransferIdl = IDL.Record({ token: IDL.Principal, amount: IDL.Nat, fee: IDL.Nat });
const TransferInfoIdl = IDL.Record({ status: ActionStatusIdl, err: IDL.Opt(IDL.Text), transfer: TransferIdl });
const TransactionTokenIdl = IDL.Record({ address: IDL.Principal });
const SwapInfoIdl = IDL.Record({ status: ActionStatusIdl, err: IDL.Opt(IDL.Text),
  tokenIn: TransactionTokenIdl, tokenOut: TransactionTokenIdl, amountIn: IDL.Nat, amountOut: IDL.Nat });
const ActionIdl = IDL.Variant({ ...Object.fromEntries([
  "AddLimitOrder", "AddLiquidity", "Claim", "DecreaseLiquidity", "Deposit",
  "ExecuteLimitOrder", "OneStepSwap", "Refund", "RemoveLimitOrder", "Swap",
  "TransferPosition", "Withdraw",
].map((name) => [name, ActionInfoIdl])),
  Deposit: TransferInfoIdl, Withdraw: TransferInfoIdl, Refund: TransferInfoIdl,
  Swap: SwapInfoIdl,
  OneStepSwap: IDL.Record({ status: ActionStatusIdl, err: IDL.Opt(IDL.Text),
    deposit: TransferInfoIdl, swap: SwapInfoIdl, withdraw: TransferInfoIdl }),
});
const TransactionIdl = IDL.Record({
  id: IDL.Nat, owner: IDL.Principal, timestamp: IDL.Int, action: ActionIdl,
});

/** Restricted to public query methods, including owner-parameterized reads.
 * getUserWithdrawQueue is intentionally absent: its caller would be anonymous.
 */
export const liquidityReadMethods = {
  getPools: { args: [], output: result(IDL.Vec(IDL.Record({
    key: IDL.Text, token0: TokenIdl, token1: TokenIdl, fee: IDL.Nat,
    tickSpacing: IDL.Int, canisterId: IDL.Principal,
  }))) },
  getInitArgs: { args: [], output: result(IDL.Record({ positionIndexCid: IDL.Principal })) },
  getUserPools: { args: [IDL.Text], output: result(IDL.Vec(IDL.Text)) },
  metadata: { args: [], output: result(MetadataIdl) },
  getUserPositionsByPrincipal: { args: [IDL.Principal], output: result(IDL.Vec(PositionIdl)) },
  getUserPosition: { args: [IDL.Nat], output: result(CurrentPositionIdl) },
  getUserUnusedBalance: { args: [IDL.Principal], output: result(IDL.Record({ balance0: IDL.Nat, balance1: IDL.Nat })) },
  getCachedTokenFee: { args: [], output: IDL.Record({ token0Fee: IDL.Nat, token1Fee: IDL.Nat }) },
  getAvailabilityState: { args: [], output: IDL.Record({ available: IDL.Bool, whiteList: IDL.Vec(IDL.Principal) }) },
  getWithdrawQueueInfo: { args: [], output: result(IDL.Record({ items: IDL.Vec(WithdrawIdl), isProcessing: IDL.Bool, queueSize: IDL.Nat })) },
  getTransactionsByOwner: { args: [IDL.Principal], output: result(IDL.Vec(IDL.Tuple(IDL.Nat, TransactionIdl))) },
} satisfies Record<string, { args: IDL.Type[]; output: IDL.Type }>;
export type LiquidityReadMethod = keyof typeof liquidityReadMethods;
export type LiquidityQuery = (request: {
  canister: string; method: LiquidityReadMethod; args: unknown[]; signal: AbortSignal;
}) => Promise<unknown>;

/** Reuse verified subnet keys between pool reads. Creating an HttpAgent for
 * every method discards that cache and repeats read_state certificate queries.
 * Fresh nonces prevent gateway response caching; no pool snapshot is cached.
 *
 * Cancellation belongs to the read, not to the shared agent's fetch function.
 * A cancelled SDK query may finish verification in the background, but its
 * reply cannot reach the caller or cancel another reader's network request. */
export function createLiquidityQueryTransport(options?: IcpswapQueryTransportOptions): LiquidityQuery {
  const query = options === undefined ? icpswapQuery : createIcpswapQueryTransport(options);
  return (request) => query({ ...request, signature: liquidityReadMethods[request.method] });
}
const anonymousQuery = createLiquidityQueryTransport();

function checkAbort(signal?: AbortSignal): void { signal?.throwIfAborted(); }
function propagateAbort(error: unknown, signal?: AbortSignal): void {
  checkAbort(signal);
  if (error instanceof Error && error.name === "AbortError") throw error;
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Invalid ${label}: expected record`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Invalid ${label}: expected text`);
  return value;
}
function atom(value: unknown, label: string): string {
  if (typeof value !== "bigint" || value < 0n) throw new Error(`Invalid ${label}: expected Nat`);
  return value.toString();
}
function integer(value: unknown, label: string): number {
  if (typeof value !== "bigint" || value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error(`Invalid ${label}: integer outside exact range`);
  return Number(value);
}
function principal(value: unknown, label: string): string {
  try { return Principal.from(value as Principal).toText(); }
  catch { throw new Error(`Invalid ${label}: expected principal`); }
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${label}: expected vector`);
  return value;
}
function unwrap(value: unknown, method: string): unknown {
  const raw = object(value, `${method} result`);
  if (Object.hasOwn(raw, "ok")) return raw.ok;
  const err = object(raw.err, `${method} error`);
  const [code, detail] = Object.entries(err)[0] ?? ["UnknownError", null];
  throw new Error(`${method}: ${code}${typeof detail === "string" ? `: ${detail}` : ""}`);
}
function token(value: unknown): PoolIdentity["token0"] {
  const raw = object(value, "token");
  return { address: Principal.fromText(text(raw.address, "token address")).toText(), standard: text(raw.standard, "token standard") };
}
function identity(value: unknown): PoolIdentity {
  const raw = object(value, "factory pool");
  const fee = integer(raw.fee, "pool fee");
  const tickSpacing = integer(raw.tickSpacing, "tick spacing");
  if (fee < 0 || tickSpacing <= 0) throw new Error("Invalid factory fee or tick spacing");
  return { pool: principal(raw.canisterId, "pool canister"), key: text(raw.key, "pool key"), token0: token(raw.token0), token1: token(raw.token1), fee, tickSpacing };
}

function variantName(value: unknown, label: string): string {
  const names = Object.keys(object(value, label));
  if (names.length !== 1) throw new Error(`Invalid ${label}: expected one variant`);
  return names[0]!;
}
function optionalError(value: unknown): string | null {
  const error = array(value, "transaction error");
  if (error.length > 1) throw new Error("Invalid transaction error: expected optional text");
  return error.length ? text(error[0], "transaction error") : null;
}

/** Mirrors LiquidityClient.summarizeTransaction from the pinned pool contract.
 * Created withdraws reserve gross unused credit; CreditCompleted already
 * debited that credit. Refunds never reserve unused credit a second time.
 */
function transactionSummary(value: unknown): BrowserTransaction {
  const raw = object(value, "transaction");
  const actions = object(raw.action, "transaction action");
  const action = variantName(actions, "transaction action");
  const detail = object(actions[action], "action details");
  const status = variantName(detail.status, "action status");
  let error = optionalError(detail.err);
  let token: string | null = null, amount = "0", unusedReserved = false, supportRequired = false;
  if (action === "Withdraw" || action === "Refund" || action === "Deposit") {
    const transfer = object(detail.transfer, "protocol transfer");
    token = principal(transfer.token, "transfer token"); amount = atom(transfer.amount, "transfer amount");
    const fee = atom(transfer.fee, "transfer fee");
    unusedReserved = action === "Withdraw" && status === "Created" && BigInt(amount) > BigInt(fee);
    supportRequired = (action === "Withdraw" || action === "Refund") && status === "Failed";
  } else if (action === "OneStepSwap") {
    const swap = object(detail.swap, "swap operation"), deposit = object(detail.deposit, "swap deposit"), withdraw = object(detail.withdraw, "swap withdrawal");
    const depositTransfer = object(deposit.transfer, "swap deposit transfer"), withdrawTransfer = object(withdraw.transfer, "swap withdrawal transfer");
    const output = variantName(swap.status, "swap status") === "Completed";
    token = principal(object(output ? swap.tokenOut : swap.tokenIn, "swap token").address, "swap token address");
    amount = atom(output ? swap.amountOut : depositTransfer.amount, "swap reserved amount");
    unusedReserved = output
      ? status === "SwapCompleted" && variantName(withdraw.status, "swap withdrawal status") === "Created" && BigInt(amount) > BigInt(atom(withdrawTransfer.fee, "withdrawal fee"))
      : variantName(deposit.status, "swap deposit status") === "Completed" && (status === "DepositCreditCompleted" || status === "PreSwapCompleted");
    supportRequired = output && variantName(withdraw.status, "swap withdrawal status") === "Failed";
    error = optionalError(withdraw.err) ?? error;
  } else if (action === "Swap") {
    token = principal(object(detail.tokenIn, "swap input token").address, "swap input token");
    amount = atom(detail.amountIn, "swap input amount");
  }
  if (typeof raw.timestamp !== "bigint") throw new Error("Invalid transaction timestamp");
  return { id: atom(raw.id, "transaction id"), owner: principal(raw.owner, "transaction owner"), timestampNs: raw.timestamp.toString(),
    action, status, error, token, amount, unusedReserved, supportRequired };
}

export function liquidityOwnerAccountIdentifier(owner: string): string {
  return AccountIdentifier.fromPrincipal({ principal: Principal.fromText(owner) }).toHex();
}

/** No cross-owner persistent cache. Identical in-flight queries share one
 * request; aborting one consumer never cancels another consumer's read.
 * Refreshes always obtain fresh values, and invalidate cancels stale work.
 */
export function createLiquidityReadClient(options: { query?: LiquidityQuery; now?: () => number } = {}) {
  const query = options.query ?? anonymousQuery;
  const now = options.now ?? Date.now;
  type Shared = { controller: AbortController; promise: Promise<unknown>; readers: number };
  const active = new Map<string, Shared>();
  const source = (): ReadSource => ({ kind: "direct-canister-query", host: ICPSWAP_QUERY_HOST, observedAt: new Date(now()).toISOString() });
  function call(canister: string, method: LiquidityReadMethod, args: unknown[], signal?: AbortSignal): Promise<unknown> {
    checkAbort(signal);
    const key = JSON.stringify([canister, method, args], (_, value: unknown) => typeof value === "bigint" ? `${value}n` : value);
    let entry = active.get(key);
    if (!entry) {
      const controller = new AbortController();
      entry = { controller, readers: 0, promise: Promise.resolve().then(() => {
        checkAbort(controller.signal);
        return query({ canister, method, args, signal: controller.signal });
      }) };
      const created = entry;
      entry.promise = entry.promise.finally(() => { if (active.get(key) === created) active.delete(key); });
      active.set(key, entry);
    }
    const shared = entry;
    shared.readers++;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (accept: boolean, value: unknown) => {
        if (done) return;
        done = true; signal?.removeEventListener("abort", aborted); shared.readers--;
        if (!shared.readers && active.get(key) === shared) { active.delete(key); shared.controller.abort(); }
        accept ? resolve(value) : reject(value);
      };
      const aborted = () => finish(false, signal?.reason ?? new DOMException("Aborted", "AbortError"));
      signal?.addEventListener("abort", aborted, { once: true });
      shared.promise.then((value) => {
        if (shared.controller.signal.aborted) finish(false, shared.controller.signal.reason);
        else finish(true, value);
      }, (error: unknown) => finish(false, error));
      if (signal?.aborted) aborted();
    });
  }
  async function discoverPools(signal?: AbortSignal): Promise<PoolDiscovery> {
    const pools = array(unwrap(await call(ICPSWAP_FACTORY, "getPools", [], signal), "getPools"), "factory pools").map(identity);
    checkAbort(signal);
    return { pools, source: source() };
  }
  async function discoverOwnedPools(owner: string, retainedPoolIds: string[] = [], signal?: AbortSignal): Promise<OwnedPoolDiscovery> {
    owner = Principal.fromText(owner).toText();
    const retainedPools = [...new Set(retainedPoolIds.map((id) => Principal.fromText(id).toText()))];
    const errors: ReadIssue[] = [];
    const registry = await discoverPools(signal);
    let indexedPools: string[] | null = null;
    let indexCanister = ICPSWAP_FACTORY;
    let indexMethod = "getInitArgs";
    try {
      const init = object(unwrap(await call(ICPSWAP_FACTORY, "getInitArgs", [], signal), "getInitArgs"), "factory init arguments");
      indexCanister = principal(init.positionIndexCid, "position index"); indexMethod = "getUserPools";
      indexedPools = array(unwrap(await call(indexCanister, "getUserPools", [liquidityOwnerAccountIdentifier(owner)], signal), "getUserPools"), "owned pools")
        .map((pool) => Principal.fromText(text(pool, "indexed pool")).toText());
    } catch (error) {
      propagateAbort(error, signal); errors.push({ canister: indexCanister, method: indexMethod, message: errorText(error) });
    }
    const ids = new Set([...(indexedPools ?? []), ...retainedPools]);
    const pools = registry.pools.filter((pool) => ids.has(pool.pool));
    for (const id of ids) if (!pools.some((pool) => pool.pool === id)) {
      errors.push({ canister: id, method: "getPools", message: "Retained or indexed pool is absent from the current factory registry; its assets remain unverified." });
    }
    checkAbort(signal);
    return { pools, owner, indexedPools, retainedPools, errors, source: source() };
  }
  async function readPool(poolId: string, owner?: string, signal?: AbortSignal): Promise<BrowserPoolView> {
    poolId = Principal.fromText(poolId).toText();
    const ownerText = owner === undefined ? null : Principal.fromText(owner).toText();
    const registry = await discoverPools(signal);
    const pool = registry.pools.find((candidate) => candidate.pool === poolId);
    if (!pool) throw new Error(`Pool ${poolId} is absent from the canonical factory registry`);
    const errors: ReadIssue[] = [];
    async function read<T>(method: LiquidityReadMethod, args: unknown[], decode: (raw: unknown) => T, wrapped = true): Promise<T | null> {
      try {
        const raw = await call(poolId, method, args, signal);
        checkAbort(signal); return decode(wrapped ? unwrap(raw, method) : raw);
      } catch (error) {
        propagateAbort(error, signal); errors.push({ canister: poolId, method, message: errorText(error) }); return null;
      }
    }
    const ownerArg = ownerText ? [Principal.fromText(ownerText)] : null;
    const [metadata, cachedFees, available, storedPositions, withdrawals, transactions] = await Promise.all([
      read("metadata", [], (value) => {
        const raw = object(value, "pool metadata");
        const t0 = token(raw.token0), t1 = token(raw.token1);
        if (text(raw.key, "pool key") !== pool.key || integer(raw.fee, "pool fee") !== pool.fee ||
          t0.address !== pool.token0.address || t1.address !== pool.token1.address ||
          t0.standard !== pool.token0.standard || t1.standard !== pool.token1.standard) throw new Error("Pool metadata does not match its factory identity");
        return { sqrtPriceX96: atom(raw.sqrtPriceX96, "sqrt price"), tick: integer(raw.tick, "current tick"), liquidity: atom(raw.liquidity, "pool liquidity") };
      }),
      read("getCachedTokenFee", [], (value) => { const r = object(value, "cached token fees"); return { token0Fee: atom(r.token0Fee, "token0 fee"), token1Fee: atom(r.token1Fee, "token1 fee") }; }, false),
      read("getAvailabilityState", [], (value) => { const r = object(value, "availability"); if (typeof r.available !== "boolean") throw new Error("Invalid pool availability");
        const whitelist = array(r.whiteList, "availability whitelist").map((entry) => principal(entry, "whitelisted owner"));
        return r.available || (ownerText !== null && whitelist.includes(ownerText)); }, false),
      ownerArg ? read("getUserPositionsByPrincipal", ownerArg, (value) => array(value, "owned positions")) : null,
      ownerArg ? read("getWithdrawQueueInfo", [], (value) => array(object(value, "withdrawal queue").items, "withdrawal items").flatMap((item) => {
        const r = object(item, "withdrawal"); const caller = principal(r.caller, "withdrawal owner");
        if (caller !== ownerText) return [];
        const to = object(r.to, "withdrawal recipient"); const sub = array(to.subaccount, "recipient subaccount");
        const bytes = sub[0];
        if (sub.length > 1 || (bytes !== undefined && !(bytes instanceof Uint8Array) && !Array.isArray(bytes))) throw new Error("Invalid withdrawal recipient subaccount");
        return [{ transactionId: atom(r.txIndex, "withdrawal transaction"), token: token(r.token).address,
          amount: atom(r.amount, "withdrawal amount"), fee: atom(r.fee, "withdrawal fee"), owner: caller,
          recipient: principal(to.owner, "recipient owner"), recipientSubaccount: bytes === undefined ? null : Array.from(bytes as Uint8Array).map((byte) => byte.toString(16).padStart(2, "0")).join("") }];
      })) : null,
      ownerArg ? read("getTransactionsByOwner", ownerArg, (value) => array(value, "current transactions").flatMap((entry) => {
        const tuple = array(entry, "transaction tuple"); const r = object(tuple[1], "transaction");
        const transactionOwner = principal(r.owner, "transaction owner"); if (transactionOwner !== ownerText) return [];
        return [transactionSummary(r)];
      })) : null,
    ]);
    // Read after reservation state. Otherwise a payout can debit an earlier
    // balance and advance to CreditCompleted between queries, exposing that
    // older balance as available. These remain non-atomic observations.
    const unused = ownerArg ? await read("getUserUnusedBalance", ownerArg, (value) => {
      const raw = object(value, "unused balances");
      return { balance0: atom(raw.balance0, "unused token0"), balance1: atom(raw.balance1, "unused token1") };
    }) : null;
    let reserved: BrowserPoolView["reserved"] = null;
    let availableUnused: BrowserPoolView["availableUnused"] = null;
    if (transactions !== null && unused !== null) {
      let balance0 = 0n, balance1 = 0n;
      for (const transaction of transactions) if (transaction.unusedReserved) {
        if (transaction.token === pool.token0.address) balance0 += BigInt(transaction.amount);
        if (transaction.token === pool.token1.address) balance1 += BigInt(transaction.amount);
      }
      reserved = { balance0: balance0.toString(), balance1: balance1.toString() };
      const subtract = (amount: string, reserved: bigint) => (BigInt(amount) > reserved ? BigInt(amount) - reserved : 0n).toString();
      availableUnused = { balance0: subtract(unused.balance0, balance0), balance1: subtract(unused.balance1, balance1) };
    }
    const positions: BrowserPosition[] | null = storedPositions === null ? null : [];
    // Fetch current position state individually: the upstream batch income API
    // masks individual failures as zeros. Process the complete owner list;
    // this sequential queue neither caps nor silently drops positions.
    for (const value of storedPositions ?? []) {
      const stored = object(value, "owned position");
      const id = atom(stored.id, "position id");
      const before = errors.length;
      const current = await read("getUserPosition", [BigInt(id)], (value) => object(value, "current position"));
      const raw = current ?? stored;
      const position: BrowserPosition = {
        id, tickLower: integer(raw.tickLower, "lower tick"), tickUpper: integer(raw.tickUpper, "upper tick"),
        liquidity: atom(raw.liquidity, "position liquidity"), tokensOwed0: current ? atom(current.tokensOwed0, "current token0 income") : null,
        tokensOwed1: current ? atom(current.tokensOwed1, "current token1 income") : null,
        amount0: null, amount1: null, feeError: current ? null : errors[before]?.message ?? "Current position income is unavailable",
      };
      if (metadata && current) {
        try {
          const amounts = amountsForLiquidity(BigInt(metadata.sqrtPriceX96), getSqrtRatioAtTick(position.tickLower), getSqrtRatioAtTick(position.tickUpper), BigInt(position.liquidity));
          position.amount0 = amounts.amount0.toString(); position.amount1 = amounts.amount1.toString();
        } catch (error) { errors.push({ canister: poolId, method: "positionAmounts", message: `Position ${id}: ${errorText(error)}` }); }
      }
      positions!.push(position);
    }
    checkAbort(signal);
    return { pool, owner: ownerText, metadata, positions, unused, reserved, availableUnused, cachedFees, available, withdrawals, transactions, errors, source: source() };
  }
  return {
    discoverPools, discoverOwnedPools, readPool,
    invalidate() { for (const entry of active.values()) entry.controller.abort(); active.clear(); },
  };
}
