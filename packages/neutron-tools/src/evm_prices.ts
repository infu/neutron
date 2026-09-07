import type { EvmPriceAsset, EvmPricesResult, EvmUsdPrice } from "./evm_wallet.ts";
export type { EvmPriceAsset, EvmPricesRequest, EvmPricesResult, EvmUsdPrice } from "./evm_wallet.ts";

/** Display refresh cadence, independent of transaction or quote validity. */
export const EVM_USD_PRICE_REFRESH_MS = 60_000;
/** Older market observations remain visible with an explicit stale label. */
export const EVM_USD_PRICE_STALE_MS = 300_000;
const PRICE_URL = "https://coins.llama.fi/prices/current/";
const WRAPPED_ETH: Readonly<Record<string, string>> = {
  "1": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  "42161": "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
};
const PRICE_CHAINS: Readonly<Record<string, string>> = { "1": "ethereum", "42161": "arbitrum" };

export function evmPriceAssetKey(asset: EvmPriceAsset): string {
  return `${asset.chainId}:${asset.address?.toLowerCase() ?? "native"}`;
}

/**
 * Assets are identified by chain and contract, never by a display symbol.
 * Only canonical WETH is valued through its one-to-one ETH backing. Other
 * assets, including wstETH, WBTC and stablecoins, use their own market prices.
 * DefiLlama's official client and endpoint:
 * https://github.com/DefiLlama/api-sdk/blob/master/src/client.ts
 * https://github.com/DefiLlama/api-sdk/blob/master/src/modules/prices.ts
 */
export function evmPriceSource(asset: EvmPriceAsset): Pick<EvmUsdPrice, "sourceId" | "basis"> {
  const chain = PRICE_CHAINS[asset.chainId];
  if (!chain) return { sourceId: null, basis: "market" };
  if (asset.address === null) return { sourceId: "coingecko:ethereum", basis: "market" };
  const address = asset.address.toLowerCase();
  if (address === WRAPPED_ETH[asset.chainId]) return { sourceId: "coingecko:ethereum", basis: "wrapped_underlying" };
  return { sourceId: `${chain}:${address}`, basis: "market" };
}

type CachedPrice = {
  priceUsd: number | null;
  observedAtMs: number | null;
  fetchedAtMs: number | null;
  checkedAtMs: number;
  error: string | null;
};
export type EvmUsdPriceCacheOptions = {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** Timeout for optional display data only; no financial operation uses it. */
  timeoutMs?: number;
};
export type EvmUsdPriceCache = {
  getPrices(assets: readonly EvmPriceAsset[], options?: { signal?: AbortSignal }): Promise<EvmPricesResult>;
};

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function cancellation(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("USD price request cancelled", "AbortError");
}
/** Cancels one waiting caller, leaving shared work available to other callers. */
function waitFor<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(cancellation(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(cancellation(signal)); };
    signal.addEventListener("abort", abort, { once: true });
    void work.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

/**
 * Volatile resident-service cache. Creation performs no I/O and starts no
 * timer. Each request batches due IDs and shares any already-running reads,
 * including ETH prices requested by different networks or WETH addresses.
 */
export function createEvmUsdPriceCache(options: EvmUsdPriceCacheOptions = {}): EvmUsdPriceCache {
  const fetcher = options.fetch ?? ((...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args));
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const cache = new Map<string, CachedPrice>();
  const pending = new Map<string, Promise<void>>();

  function fail(id: string, message: string, checkedAtMs: number, fetched = false): void {
    const previous = cache.get(id);
    cache.set(id, {
      priceUsd: previous?.priceUsd ?? null,
      observedAtMs: previous?.observedAtMs ?? null,
      fetchedAtMs: previous?.fetchedAtMs ?? (fetched ? checkedAtMs : null),
      checkedAtMs, error: message,
    });
  }

  async function refresh(ids: string[]): Promise<void> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error("USD prices took too long to load");
        controller.abort(error); reject(error);
      }, timeoutMs);
    });
    try {
      const read = (async () => {
        // No cookies, wallet addresses, credentials, or canister proxy are used.
        const response = await fetcher(`${PRICE_URL}${ids.join(",")}`, {
          signal: controller.signal, credentials: "omit", referrerPolicy: "no-referrer",
        });
        if (!response.ok) throw new Error(`USD price provider returned HTTP ${response.status}`);
        const body: unknown = await response.json();
        const coins = object(object(body)?.coins);
        if (!coins) throw new Error("USD price provider returned an invalid response");
        return coins;
      })();
      const coins = await Promise.race([read, timeout]);
      const fetchedAtMs = now();
      for (const id of ids) {
        const quote = Object.prototype.hasOwnProperty.call(coins, id) ? object(coins[id]) : null;
        if (!quote) { fail(id, "No USD market price is available for this asset", fetchedAtMs, true); continue; }
        const price = quote.price, timestamp = quote.timestamp;
        const observedAtMs = typeof timestamp === "number" ? timestamp * 1_000 : NaN;
        if (typeof price !== "number" || !Number.isFinite(price) || price <= 0 ||
          typeof timestamp !== "number" || !Number.isSafeInteger(timestamp) || timestamp <= 0 ||
          !Number.isSafeInteger(observedAtMs) || observedAtMs > fetchedAtMs + 60_000) {
          fail(id, "The provider returned an invalid USD price or observation time", fetchedAtMs, true);
          continue;
        }
        cache.set(id, { priceUsd: price, observedAtMs, fetchedAtMs, checkedAtMs: fetchedAtMs, error: null });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "USD prices could not be refreshed";
      const checkedAtMs = now();
      for (const id of ids) fail(id, message, checkedAtMs);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  return {
    async getPrices(assets, requestOptions = {}) {
      if (requestOptions.signal?.aborted) throw cancellation(requestOptions.signal);
      // Copy identities before waiting so callers cannot change a checked scope.
      const requested = assets.map((asset) => ({ chainId: asset.chainId, address: asset.address?.toLowerCase() ?? null }));
      const sources = requested.map(evmPriceSource);
      const ids = [...new Set(sources.flatMap((source) => source.sourceId === null ? [] : [source.sourceId]))];
      const currentTime = now();
      const due = ids.filter((id) => {
        const entry = cache.get(id);
        return !pending.has(id) && (!entry || currentTime < entry.checkedAtMs || currentTime - entry.checkedAtMs >= EVM_USD_PRICE_REFRESH_MS);
      });
      if (due.length > 0) {
        const task = refresh(due);
        for (const id of due) pending.set(id, task);
        const cleanup = () => { for (const id of due) if (pending.get(id) === task) pending.delete(id); };
        void task.then(cleanup, cleanup);
      }
      await waitFor(Promise.all([...new Set(ids.flatMap((id) => pending.has(id) ? [pending.get(id)!] : []))]), requestOptions.signal);
      if (requestOptions.signal?.aborted) throw cancellation(requestOptions.signal);
      const readAtMs = now();
      return { source: "defillama", prices: requested.map((asset, index) => {
        const source = sources[index]!;
        const entry = source.sourceId === null ? undefined : cache.get(source.sourceId);
        const priceUsd = entry?.priceUsd ?? null;
        const stale = !!entry && (entry.error !== null || entry.observedAtMs === null || entry.fetchedAtMs === null ||
          readAtMs - entry.observedAtMs >= EVM_USD_PRICE_STALE_MS || readAtMs - entry.fetchedAtMs >= EVM_USD_PRICE_REFRESH_MS);
        return {
          ...asset, ...source, priceUsd,
          observedAtMs: entry?.observedAtMs ?? null, fetchedAtMs: entry?.fetchedAtMs ?? null,
          status: priceUsd === null ? "unavailable" : stale ? "stale" : "available",
          error: source.sourceId === null ? "USD prices are unavailable for this network" : entry?.error ?? null,
        };
      }) };
    },
  };
}

/** Approximate display arithmetic only. Atomic transaction amounts stay exact. */
export function usdValue(atoms: string, decimals: number, price: EvmUsdPrice | undefined): number | null {
  if (!price || price.status === "unavailable" || price.priceUsd === null || !Number.isFinite(price.priceUsd) || price.priceUsd <= 0 ||
    !/^\d+$/.test(atoms) || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) return null;
  const value = (Number(atoms) / 10 ** decimals) * price.priceUsd;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

const usdFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return "—";
  return value > 0 && value < 0.01 ? "<$0.01" : usdFormat.format(value);
}

export function usdPriceTitle(price: EvmUsdPrice | undefined): string {
  if (!price) return "USD price unavailable";
  if (price.priceUsd === null || price.status === "unavailable") return `USD price unavailable${price.error ? ` · ${price.error}` : ""}`;
  const time = price.observedAtMs === null ? "" : ` · Market observation ${new Date(price.observedAtMs).toLocaleString()}`;
  const stale = price.status === "stale" || price.observedAtMs !== null && Date.now() - price.observedAtMs >= EVM_USD_PRICE_STALE_MS;
  return `Estimated USD value · DefiLlama${price.basis === "wrapped_underlying" ? " · Wrapped ETH valued from underlying ETH" : ""}${stale ? " · Stale price" : ""}${time}${price.error ? ` · ${price.error}` : ""}`;
}
