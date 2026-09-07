import { getAddress } from "viem";
import { curatedEvmTokens } from "neutron-tools/src/evm_assets.js";
import { tokenKey, type ChainId, type Token } from "./contracts.ts";

type ListedToken = Token & { name: string; sourceUrl: string };
/** Presentation only. These fields are never part of the managed journal schema. */
export type TokenOption = Token & { name: string | null; listed: boolean; sourceUrl: string | null };

const circle = "https://developers.circle.com/stablecoins/usdc-contract-addresses";
const tether = "https://tether.to/en/supported-protocols/";
const usdt0 = "https://docs.usdt0.to/technical-documentation/deployments";
const bridgedUsdc = "https://www.circle.com/blog/usdc-on-arbitrum-now-available";
const curveCoins = "https://github.com/curvefi/curve-js/tree/e51fa54e73afa08ed3fe99cd508b163559b130a9/src/constants/coins";
const registry = "https://docs.internetcomputer.org/references/chain-key-canister-ids/";

/** Shared Neutron list, plus Curve's existing defaults and explicitly named
 * bridged USDC. USDC, USDT, USDT0 and USDC.e addresses checked with the linked
 * primary sources on 2026-09-07. Listing is identity metadata, not a risk rating.
 * Only this static list can assign a badge; pool/API and onchain symbols cannot. */
export function listedTokens(chainId: ChainId): ListedToken[] {
  const shared = curatedEvmTokens(chainId).map((token): ListedToken => ({
    ...token, chainId, address: token.address ? getAddress(token.address) : null,
    name: token.symbol === "USDC" ? "Circle · native USDC" : token.symbol === "USDT0" ? "Tether USD · USDT0" : token.name,
    sourceUrl: token.address === null ? "https://ethereum.org/en/eth/" : token.symbol === "USDC" ? circle :
      token.symbol === "USDT" || token.symbol === "XAUT" ? tether : token.symbol === "USDT0" ? usdt0 :
      token.symbol === "wstETH" ? "https://docs.lido.fi/deployed-contracts/" : token.symbol === "WETH" ?
        "https://github.com/Uniswap/default-token-list/tree/main/src/tokens" : registry,
  }));
  const extra = chainId === "1" ? [
    ["0xd533a949740bb3306d119cc777fa900ba034cd52", "CRV", 18, "Curve DAO", curveCoins],
    ["0xf939e0a03fb07f59a73314e73794be0e57ac1b4e", "crvUSD", 18, "Curve USD", curveCoins],
    ["0x6b175474e89094c44da98b954eedeac495271d0f", "DAI", 18, "Dai", curveCoins],
  ] as const : [
    ["0x11cdb42b0eb46d95f990bedd4695a6e3fa034978", "CRV", 18, "Curve DAO", curveCoins],
    ["0x498bf2b1e120fed3ad3d42ea2165e9b73f99c1e5", "crvUSD", 18, "Curve USD", curveCoins],
    ["0xff970a61a04b1ca14834a43f5de4533ebddb5cc8", "USDC.e", 6, "Bridged USDC from Ethereum", bridgedUsdc],
  ] as const;
  return [...shared, ...extra.map(([address, symbol, decimals, name, sourceUrl]) => ({ chainId, address: getAddress(address), symbol, decimals, name, sourceUrl }))];
}

// Popularity only orders entries in the static list. An unlisted contract
// copying a popular symbol can never acquire that entry's badge or priority.
const popular = ["ETH", "USDC", "crvUSD", "USDT", "USDT0", "USDC.e", "DAI", "WETH", "CRV", "WBTC", "wstETH"];
const popularRank = (token: Token) => { const rank = popular.indexOf(token.symbol); return rank < 0 ? popular.length : rank; };
const listed = (["1", "42161"] as const).flatMap((chainId) => listedTokens(chainId).sort((a, b) => popularRank(a) - popularRank(b) || a.symbol.localeCompare(b.symbol)));
const byKey = new Map(listed.map((token, index) => [tokenKey(token), { token, index }]));

export function describeToken(token: Token): TokenOption {
  const known = byKey.get(tokenKey(token))?.token;
  return { chainId: token.chainId, address: token.address, symbol: known?.symbol ?? token.symbol, decimals: token.decimals,
    name: known?.name ?? null, listed: !!known, sourceUrl: known?.sourceUrl ?? null };
}

/** Known addresses first, then alphabetical with address tie-breaking. This is
 * deliberately not a liquidity ranking: pool TVL is not token authenticity. */
export function searchTokens(tokens: readonly Token[], query: string): TokenOption[] {
  const needle = query.trim().toLowerCase(), exactAddress = /^0x[0-9a-f]{40}$/.test(needle);
  return tokens.map(describeToken).filter((token) => exactAddress ? token.address?.toLowerCase() === needle :
    `${token.symbol} ${token.name ?? ""} ${token.address ?? "native ether eth"}`.toLowerCase().includes(needle))
    .sort((a, b) => (byKey.get(tokenKey(a))?.index ?? Number.MAX_SAFE_INTEGER) - (byKey.get(tokenKey(b))?.index ?? Number.MAX_SAFE_INTEGER) ||
      a.symbol.localeCompare(b.symbol) || tokenKey(a).localeCompare(tokenKey(b)));
}
