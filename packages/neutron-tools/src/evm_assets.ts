/**
 * Curated display metadata shared by EVM Wallet and its client apps.
 * These are assets on the selected EVM network, not IC ledger tokens.
 * Ethereum ERC-20 counterparts checked against the ICP ckERC20 registry:
 * https://docs.internetcomputer.org/references/chain-key-canister-ids/
 * Arbitrum contracts checked against their issuers' deployment lists:
 * https://developers.circle.com/stablecoins/usdc-contract-addresses
 * https://docs.usdt0.to/technical-documentation/deployments
 * https://docs.lido.fi/deployed-contracts/
 * WETH: https://github.com/Uniswap/default-token-list/blob/main/src/tokens/mainnet.json
 * Reviewed 2026-09-06. Contract addresses, not symbols, identify assets.
 */
export type EvmAsset = {
  chainId: string;
  address: string;
  symbol: string;
  decimals: number;
};

export type CuratedEvmToken = Omit<EvmAsset, "address"> & {
  address: string | null;
  name: string;
};

type TokenDefinition = readonly [address: string | null, symbol: string, decimals: number, name: string];

const ETHEREUM: readonly TokenDefinition[] = [
  [null, "ETH", 18, "Ether"],
  ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "USDC", 6, "USDC"],
  ["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", "WETH", 18, "Wrapped Ether"],
  ["0xdac17f958d2ee523a2206206994597c13d831ec7", "USDT", 6, "Tether USD"],
  ["0x1abaea1f7c830bd89acc67ec4af516284b1bc33c", "EURC", 6, "Euro Coin"],
  ["0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", "WBTC", 8, "Wrapped Bitcoin"],
  ["0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0", "wstETH", 18, "Wrapped staked Ether"],
  ["0x514910771af9ca656af840dff83e8264ecf986ca", "LINK", 18, "Chainlink"],
  ["0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", "UNI", 18, "Uniswap"],
  ["0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce", "SHIB", 18, "Shiba Inu"],
  ["0x6982508145454ce325ddbe47a25d4ec3d2311933", "PEPE", 18, "Pepe"],
  // Conventional ASCII ticker; the contract's mixed-case symbol is XAUt.
  ["0x68749665ff8d2d112fa859aa293f07a622782f38", "XAUT", 6, "Tether Gold"],
  ["0xf5cfbc74057c610c8ef151a439252680ac68c6dc", "OCT", 18, "Octopus Network"],
];

const ARBITRUM: readonly TokenDefinition[] = [
  [null, "ETH", 18, "Ether"],
  ["0xaf88d065e77c8cc2239327c5edb3a432268e5831", "USDC", 6, "USDC"],
  ["0x82af49447d8a07e3bd95bd0d56f35241523fbab1", "WETH", 18, "Wrapped Ether"],
  // Conventional ASCII ticker for the contract's USD₮0 symbol. This is the
  // issuer's Arbitrum asset, distinct from the Ethereum USDT contract.
  ["0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", "USDT0", 6, "Tether USD"],
  ["0x5979d7b546e38e414f7e9822514be443a4800529", "wstETH", 18, "Wrapped staked Ether"],
];

/** Fresh arrays let a picker extend its list without changing another app's defaults. */
export function curatedEvmTokens(chainId: string): CuratedEvmToken[] {
  const definitions = chainId === "1" ? ETHEREUM : chainId === "42161" ? ARBITRUM : [];
  return definitions.map(([address, symbol, decimals, name]) => ({ chainId, address, symbol, decimals, name }));
}

export function evmAssetKey(asset: Pick<EvmAsset, "chainId" | "address">): string {
  return `${asset.chainId}:${asset.address.toLowerCase()}`;
}

/**
 * Overlay display defaults without mutating installed managed memory. Saved
 * custom assets and metadata win. Callers with hidden-asset preferences can
 * supply their excluded keys; adding a catalog must not erase that preference.
 */
export function mergeEvmAssets(saved: readonly EvmAsset[], excludedKeys: ReadonlySet<string> = new Set()): EvmAsset[] {
  const assets = new Map<string, EvmAsset>();
  for (const asset of saved) {
    const key = evmAssetKey(asset);
    if (!excludedKeys.has(key)) assets.set(key, { ...asset });
  }
  for (const chainId of ["1", "42161"]) {
    for (const { address, symbol, decimals } of curatedEvmTokens(chainId)) {
      if (address === null) continue;
      const asset = { chainId, address, symbol, decimals }, key = evmAssetKey(asset);
      if (!assets.has(key) && !excludedKeys.has(key)) assets.set(key, asset);
    }
  }
  return [...assets.values()];
}
