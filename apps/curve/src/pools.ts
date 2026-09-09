import { getAddress, type Address } from "viem";
import { describeToken, listedTokens } from "./tokens.ts";
import { call, CHAINS, LEGACY_POOLS, NATIVE, ZERO, isLegacy, poolKey, poolRef, tokenKey, type ChainId, type Family, type Pool, type PoolRef, type Reader, type Token, type VerifiedPool } from "./contracts.ts";

export type PoolCatalog = { pools: Pool[]; complete: boolean; errors: string[]; fetchedAtMs: number };
const apiFamilies = ["factory-stable-ng", "factory-twocrypto", "factory-tricrypto", "main"] as const;
const catalogCache = new Map<ChainId, PoolCatalog>();
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;

export function parsePoolCatalog(raw: unknown, chainId: ChainId, apiFamily: typeof apiFamilies[number]): Pool[] {
  const result = raw as { success?: boolean; generatedTimeMs?: number; data?: { poolData?: Record<string, unknown>[] } };
  if (result?.success !== true || !Array.isArray(result.data?.poolData)) throw new Error("Curve returned an invalid pool catalog.");
  const output: Pool[] = [];
  for (const row of result.data.poolData) {
    const address = getAddress(String(row.address));
    const legacy = LEGACY_POOLS[chainId][address.toLowerCase()];
    if (apiFamily === "main" && !legacy) continue;
    const family: Family = legacy?.family ?? (apiFamily === "factory-stable-ng" ? row.isMetaPool === true ? "stable-meta-ng" : "stable-ng" : apiFamily === "factory-twocrypto" ? "twocrypto-ng" : "tricrypto-ng");
    if (!Array.isArray(row.coins) || row.coins.length < 2 || row.coins.length > 8) throw new Error("Curve returned an invalid pool coin list.");
    const coins = row.coins.map((rawCoin: unknown): Token => {
      const coin = rawCoin as Record<string, unknown>, address = getAddress(String(coin.address));
      const decimals = Number(coin.decimals);
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("Invalid token decimals in Curve catalog.");
      const token: Token = { chainId, address: address === NATIVE ? null : address, symbol: typeof coin.symbol === "string" ? coin.symbol : short(address), decimals };
      return { ...token, symbol: describeToken(token).symbol };
    });
    output.push({ chainId, address, family, id: String(row.id), name: legacy?.name ?? String(row.name ?? row.symbol ?? short(address)), coins,
      lpToken: legacy?.lpToken ?? getAddress(String(row.lpTokenAddress ?? row.address)),
      tvlUsd: typeof row.usdTotal === "number" && Number.isFinite(row.usdTotal) && row.usdTotal >= 0 ? row.usdTotal : null,
      apiObservedAtMs: typeof result.generatedTimeMs === "number" && Number.isFinite(result.generatedTimeMs) ? result.generatedTimeMs : null });
  }
  return output;
}

export async function fetchPools(chainId: ChainId, options: { signal?: AbortSignal; refresh?: boolean; fetch?: typeof fetch; now?: () => number } = {}): Promise<PoolCatalog> {
  const now = options.now ?? Date.now, cached = catalogCache.get(chainId);
  if (!options.refresh && cached && now() - cached.fetchedAtMs < 60000) return cached;
  const results = await Promise.allSettled(apiFamilies.map(async (family) => {
    const response = await (options.fetch ?? fetch)(`https://api.curve.finance/api/getPools/${CHAINS[chainId].api}/${family}`, {
      mode: "cors", credentials: "omit", ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) throw new Error(`${family}: HTTP ${response.status}`);
    return parsePoolCatalog(await response.json(), chainId, family);
  }));
  options.signal?.throwIfAborted();
  const errors = results.flatMap((result, index) => result.status === "rejected" ? [`${apiFamilies[index]}: ${errorMessage(result.reason)}`] : []);
  const pools = results.flatMap((result, index) => result.status === "fulfilled" ? result.value : (cached?.pools.filter((pool) =>
    apiFamilies[index] === "main" ? isLegacy(pool) : apiFamilies[index] === "factory-stable-ng" ? pool.family.startsWith("stable-") : pool.family === (apiFamilies[index] === "factory-twocrypto" ? "twocrypto-ng" : "tricrypto-ng")) ?? []));
  const unique = [...new Map(pools.map((pool) => [poolKey(pool), pool])).values()];
  unique.sort((a, b) => (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1) || a.address.localeCompare(b.address));
  const result = { pools: unique, complete: errors.length === 0, errors, fetchedAtMs: now() };
  if (result.complete) catalogCache.set(chainId, result);
  return result;
}

export function catalogTokens(chainId: ChainId, pools: readonly Pool[] = []): Token[] {
  const tokens = new Map<string, Token>();
  for (const pool of pools) for (const token of pool.coins) tokens.set(tokenKey(token), token);
  for (const token of listedTokens(chainId)) tokens.set(tokenKey(token), token);
  return [...tokens.values()];
}

export async function readToken(read: Reader, chainId: ChainId, address: Address | null, blockNumber?: string): Promise<Token> {
  if (address === null || address === NATIVE) return { chainId, address: null, symbol: "ETH", decimals: 18 };
  const decimals = Number((await call(read, chainId, address, "function decimals() view returns (uint8)", [], blockNumber)).value);
  let symbol: string;
  try { symbol = String((await call(read, chainId, address, "function symbol() view returns (string)", [], blockNumber)).value); }
  catch { symbol = catalogTokens(chainId).find((token) => token.address === address)?.symbol ?? short(address); }
  // Contract identity and observed decimals drive execution. Reuse the token
  // menu's address-backed display label: bridged USDC still reports "USDC"
  // onchain, which must not turn it into native USDC in pool/quote tools.
  const token = { chainId, address, symbol, decimals };
  return { ...token, symbol: describeToken(token).symbol };
}

/** API data supplies discovery and labels. Factory registration and pool coin
 * methods independently select the executable ABI and exact token identities. */
export async function verifyPool(read: Reader, reference: PoolRef, hint?: Pool, blockNumber?: string): Promise<VerifiedPool> {
  const ref = poolRef(reference), legacy = LEGACY_POOLS[ref.chainId][ref.address.toLowerCase()];
  let addresses: Address[], block: string;
  if (isLegacy(ref)) {
    if (!legacy || legacy.family !== ref.family) throw new Error("This legacy pool deployment has no implemented Curve adapter.");
    const first = await call(read, ref.chainId, ref.address, "function coins(uint256 index) view returns (address)", [0n], blockNumber);
    block = first.blockNumber;
    addresses = [getAddress(String(first.value)), ...await Promise.all(Array.from({ length: ref.family === "legacy-3" ? 2 : 1 }, async (_, index) =>
      getAddress(String((await call(read, ref.chainId, ref.address, "function coins(uint256 index) view returns (address)", [BigInt(index + 1)], block)).value))))];
  } else {
    const stable = ref.family.startsWith("stable-"), family = stable ? "stable-ng" : ref.family as "twocrypto-ng" | "tricrypto-ng";
    const factory = CHAINS[ref.chainId].factories[family];
    const dimension = stable ? "[]" : family === "twocrypto-ng" ? "[2]" : "[3]";
    const registered = await call(read, ref.chainId, factory, `function get_coins(address pool) view returns (address${dimension})`, [ref.address], blockNumber);
    block = registered.blockNumber;
    addresses = (registered.value as string[]).map((address) => getAddress(address));
    if (addresses.length < 2 || addresses.length > 8 || addresses.some((address) => address === ZERO || address === NATIVE) || new Set(addresses).size !== addresses.length) throw new Error("The pool is not registered with the selected Curve factory.");
    if (stable) {
      const meta = (await call(read, ref.chainId, factory, "function is_meta(address pool) view returns (bool)", [ref.address], block)).value;
      if ((ref.family === "stable-meta-ng") !== meta) throw new Error("Pool type differs from its factory registration. Reload the pool.");
    }
    const actual = await Promise.all(addresses.map(async (_, index) => getAddress(String((await call(read, ref.chainId, ref.address, "function coins(uint256 index) view returns (address)", [BigInt(index)], block)).value))));
    if (actual.some((address, index) => address !== addresses[index])) throw new Error("Pool coins differ from the factory registration.");
  }
  const lpToken = legacy?.lpToken ?? ref.address;
  const [coins, supply, balances, lpDecimals] = await Promise.all([
    Promise.all(addresses.map((address) => readToken(read, ref.chainId, address, block))),
    call(read, ref.chainId, lpToken, "function totalSupply() view returns (uint256)", [], block),
    Promise.all(addresses.map(async (_, index) => String((await call(read, ref.chainId, ref.address, "function balances(uint256 index) view returns (uint256)", [BigInt(index)], block)).value))),
    call(read, ref.chainId, lpToken, "function decimals() view returns (uint8)", [], block),
  ]);
  if (hint && (hint.lpToken !== lpToken || hint.coins.length !== coins.length || hint.coins.some((token, index) => token.address !== coins[index]!.address))) throw new Error("Pool discovery metadata changed; reload before preparing a transaction.");
  return { ...ref, id: hint?.id ?? ref.address, name: legacy?.name ?? hint?.name ?? coins.map((token) => token.symbol).join(" / "),
    coins, lpToken, tvlUsd: hint?.tvlUsd ?? null, apiObservedAtMs: hint?.apiObservedAtMs ?? null,
    supply: String(supply.value), balances, lpDecimals: Number(lpDecimals.value), blockNumber: block };
}

export async function findPool(read: Reader, reference: PoolRef, options: { signal?: AbortSignal; catalog?: PoolCatalog } = {}) {
  const catalog = options.catalog ?? await fetchPools(reference.chainId, options.signal ? { signal: options.signal } : {});
  return verifyPool(read, reference, catalog.pools.find((pool) => poolKey(pool) === poolKey(reference)));
}
