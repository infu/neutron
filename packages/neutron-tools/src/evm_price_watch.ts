import { createEvmWalletClient, type EvmPriceAsset, type EvmPricesRequest, type EvmPricesResult, type EvmUsdPrice } from "./evm_wallet.ts";
import { callTool } from "./app_entry.ts";
import { evmPriceAssetKey, EVM_USD_PRICE_REFRESH_MS, EVM_USD_PRICE_STALE_MS } from "./evm_prices.ts";

type PriceClient = { prices(input: EvmPricesRequest): Promise<EvmPricesResult> };
type WatchEnvironment = {
  now(): number;
  active(): boolean;
  events: EventTarget[];
  schedule(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  cancel(timer: ReturnType<typeof setTimeout>): void;
};
type Subscription = { assets: readonly EvmPriceAsset[]; update(prices: EvmUsdPrice[]): void };

/** One view cache per browser document; the resident Wallet owns the shared
 * provider cache across documents and agents. No work starts until subscribed
 * and focused. Kernel can CSS-hide mounted workspaces, so page visibility
 * alone does not establish that this app is in use. */
export function createEvmPriceWatcher(client: PriceClient, environment: WatchEnvironment) {
  const subscriptions = new Set<Subscription>();
  const cache = new Map<string, EvmUsdPrice>();
  const nextRead = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;

  function read(assets: readonly EvmPriceAsset[]): EvmUsdPrice[] {
    return assets.flatMap((asset) => {
      const price = cache.get(evmPriceAssetKey(asset));
      if (!price) return [];
      const stale = price.status === "available" && (
        price.observedAtMs === null || environment.now() - price.observedAtMs >= EVM_USD_PRICE_STALE_MS ||
        price.fetchedAtMs === null || environment.now() - price.fetchedAtMs >= EVM_USD_PRICE_REFRESH_MS
      );
      return [stale ? { ...price, status: "stale" as const } : price];
    });
  }
  function activeAssets() {
    const assets = new Map<string, EvmPriceAsset>();
    for (const subscription of subscriptions) for (const asset of subscription.assets) assets.set(evmPriceAssetKey(asset), asset);
    return [...assets.values()];
  }
  function schedule() {
    if (timer !== null) environment.cancel(timer);
    timer = null;
    if (!subscriptions.size || !environment.active() || inFlight) return;
    const assets = activeAssets();
    if (!assets.length) return;
    const next = Math.min(...assets.map((asset) => nextRead.get(evmPriceAssetKey(asset)) ?? 0));
    timer = environment.schedule(() => { timer = null; void refresh(); }, Math.max(0, next - environment.now()));
  }
  async function refresh() {
    if (inFlight || !subscriptions.size || !environment.active()) return;
    const assets = activeAssets().filter((asset) => (nextRead.get(evmPriceAssetKey(asset)) ?? 0) <= environment.now());
    if (!assets.length) { schedule(); return; }
    inFlight = true;
    try {
      const result = await client.prices({ assets });
      for (const price of result.prices) cache.set(evmPriceAssetKey(price), price);
    } catch (error) {
      // An old Wallet, unavailable provider or transport failure cannot block
      // the app's balances, quotes or financial actions.
      const message = error instanceof Error ? error.message : String(error);
      for (const asset of assets) {
        const key = evmPriceAssetKey(asset), previous = cache.get(key);
        cache.set(key, previous ? { ...previous, status: previous.priceUsd === null ? "unavailable" : "stale", error: message } : {
          ...asset, priceUsd: null, observedAtMs: null, fetchedAtMs: null,
          status: "unavailable", basis: "market", sourceId: null, error: message,
        });
      }
    } finally {
      for (const asset of assets) nextRead.set(evmPriceAssetKey(asset), environment.now() + EVM_USD_PRICE_REFRESH_MS);
      inFlight = false;
      for (const subscription of subscriptions) subscription.update(read(subscription.assets));
      schedule();
    }
  }
  const activity = () => {
    // A refocused view must label its old observation before a new price read
    // finishes. This does not require polling an inactive document.
    for (const subscription of subscriptions) subscription.update(read(subscription.assets));
    schedule();
  };
  return {
    read,
    subscribe(assets: readonly EvmPriceAsset[], update: Subscription["update"]) {
      const subscription = { assets, update };
      subscriptions.add(subscription);
      if (subscriptions.size === 1) for (const target of environment.events) {
        target.addEventListener("focus", activity);
        target.addEventListener("blur", activity);
        target.addEventListener("visibilitychange", activity);
      }
      update(read(assets));
      schedule();
      return () => {
        subscriptions.delete(subscription);
        if (!subscriptions.size) for (const target of environment.events) {
          target.removeEventListener("focus", activity);
          target.removeEventListener("blur", activity);
          target.removeEventListener("visibilitychange", activity);
        }
        schedule();
      };
    },
  };
}

let browserWatcher: ReturnType<typeof createEvmPriceWatcher> | undefined;
export function evmPriceWatcher() {
  return browserWatcher ??= createEvmPriceWatcher(createEvmWalletClient({ callTool }), {
    now: Date.now,
    active: () => document.visibilityState === "visible" && document.hasFocus(),
    events: [window, document],
    schedule: (callback, delay) => setTimeout(callback, delay),
    cancel: (timer) => clearTimeout(timer),
  });
}
