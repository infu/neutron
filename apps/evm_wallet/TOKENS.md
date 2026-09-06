# Default EVM tokens

EVM Wallet and Uniswap share the display catalog in
`packages/neutron-tools/src/evm_assets.ts`. Ethereum includes native ETH, WETH,
and the Ethereum assets corresponding to all eleven ERC-20 entries in the
[ICP chain-key token registry](https://docs.internetcomputer.org/references/chain-key-canister-ids/):
USDC, USDT, EURC, WBTC, wstETH, LINK, UNI, SHIB, PEPE, XAUT, and OCT.

These are Ethereum contract assets, not IC ledger tokens. WBTC corresponds to
ckWBTC; it is not native Bitcoin or ckBTC. Native BTC, DOGE, and SOL are not EVM
assets and are not represented by unrelated wrapped tokens in this catalog.

Arbitrum includes ETH, WETH, native USDC, USDT0, and canonical bridged wstETH.
Contracts are checked against [Circle's USDC deployments](https://developers.circle.com/stablecoins/usdc-contract-addresses),
[the USDT0 issuer's deployments](https://docs.usdt0.to/technical-documentation/deployments),
[Lido's deployments](https://docs.lido.fi/deployed-contracts/), and
[Uniswap's WETH bridge mapping](https://github.com/Uniswap/default-token-list/blob/main/src/tokens/mainnet.json).
Ethereum addresses are never reused as Arbitrum addresses.

On 2026-09-06 all sixteen ERC-20 contract addresses in this catalog were also
checked with direct, read-only `decimals()` and `symbol()` calls against pinned
Ethereum block `0x18b80eb` and Arbitrum block `0x1df221ed`. USDC, USDT, EURC,
XAUT, and USDT0 use six decimals; WBTC uses eight; the others use eighteen.
Display tickers XAUT and USDT0 use conventional ASCII spelling; their onchain
symbols are `XAUt` and `USD₮0`.

The catalog is a frontend overlay on the saved wallet snapshot. It makes new
defaults available to existing installations without mutating either v1 memory
root. Saved custom tokens and saved metadata take precedence, and custom token
import remains available. There is no released remove-asset API; the merge helper
also accepts explicit hidden keys for clients that store a display preference.

Listing a token does not guarantee liquidity in any particular direct Uniswap
V3 pool. Quotes still come from current browser RPC reads for the selected pair.

## Token icons

`packages/neutron-tools/src/evm_token_icons.ts` embeds available ETH, USDC, USDT,
WBTC, LINK, and UNI artwork from
[Cryptocurrency Icons](https://github.com/spothq/cryptocurrency-icons/tree/1a63530be6e374711a8554f31b17e4cb92c25fa5),
under its original CC0-1.0 dedication, retained as
`evm_token_icons.LICENSE.md`. SVG bytes are embedded unchanged as data URIs.
Displaying icons makes no requests to third-party image servers.

Icons are matched by network and exact curated contract address. Imported tokens
do not inherit another asset's icon by using its symbol. Tokens without bundled
artwork use text initials; native Bitcoin's icon is not used for unrelated assets.
