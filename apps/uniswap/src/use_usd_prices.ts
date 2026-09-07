import { useEffect, useState } from "react";
import type { EvmPriceAsset, EvmUsdPrice } from "neutron-tools/evm_wallet";
import { evmPriceAssetKey } from "neutron-tools/src/evm_prices.js";
import { evmPriceWatcher } from "neutron-tools/src/evm_price_watch.js";

export function useEvmPrices(assets: readonly EvmPriceAsset[]) {
  const key = JSON.stringify(assets.map(({ chainId, address }) => ({ chainId, address })));
  const [prices, setPrices] = useState<EvmUsdPrice[]>(() => evmPriceWatcher().read(assets));
  useEffect(() => evmPriceWatcher().subscribe(JSON.parse(key) as EvmPriceAsset[], setPrices), [key]);
  const byAsset = new Map(prices.map((price) => [evmPriceAssetKey(price), price]));
  return { prices, priceFor: (asset: EvmPriceAsset) => byAsset.get(evmPriceAssetKey(asset)) };
}
