# Uniswap V4 and liquidity management

[Documentation index](./index.md) · [EVM Wallet](./evm-wallet.md)

## Integration decision

Uniswap owns routing, pool and position reads, SDK calculations, and the durable
sequence of approvals and position transactions. EVM Wallet owns account custody,
exact transaction review, signing, browser RPC and receipt tracking. This uses
the existing installation tool grants and Agent provider review. No Kernel
change, external wallet extension, API credential or IC HTTP outcall is needed.

The interface offers Swap and Liquidity tabs. Liquidity management covers V3 and
V4 positions on Ethereum and Arbitrum: mint in an initialized pool, inspect, add,
remove, collect available amounts, and close. Creating an uninitialized pool is a separate
operation requiring an explicit initial price; it is not inferred from deposit
amounts. Changing a position's range requires removing liquidity and minting a
new position. Existing V3 positions are not migrated into V4.

## Research and contract boundary

Verified against official sources on 2026-09-06:

- [V4 deployments](https://developers.uniswap.org/docs/protocols/v4/deployments)
  supply network-specific PositionManager, StateView, Quoter and Universal Router
  addresses. V4 native ETH uses currency address zero; WETH is a different pool
  currency. Pool identity includes both sorted currencies, fee, tick spacing and
  hook address.
- [Universal Router 2.1.1's V4 interface](https://github.com/Uniswap/v4-periphery/blob/3231810e39b8c4d569b9d66907fa4ef8cd2cec22/src/interfaces/IV4Router.sol)
  includes `minHopPriceX36` in the single-swap tuple. The older documentation
  example cannot be copied unchanged against this deployment. Explicit recipient
  output uses `TAKE`; `TAKE_ALL` pays the original caller. Native input refunds
  go back to the signing wallet.
- [The pinned official SDK](https://github.com/Uniswap/sdks/tree/35c4e35aca9e22169ce17d7106e7fc5f27ccd03d)
  provides concentrated-liquidity math and position calldata. Pins are
  `sdk-core@7.19.2`, `v3-sdk@3.31.3`, and `v4-sdk@2.3.3`. The application fits
  liquidity to explicit token budgets, including slippage maxima, rather than
  silently authorizing more than the requested deposit.
- [V4 PositionManager](https://github.com/Uniswap/sdks/blob/35c4e35aca9e22169ce17d7106e7fc5f27ccd03d/sdks/v4-sdk/src/PositionManager.ts)
  settles a mint with `SETTLE_PAIR`; increases use `CLOSE_CURRENCY` on both sides
  because accrued fees can reverse the amount owed. Removal and collection also
  take the resulting currencies back to the recipient. V3 removal must include
  collection; decreasing liquidity alone leaves funds owed inside its manager.
- [Permit2 allowance transfer](https://developers.uniswap.org/docs/protocols/permit2/concepts/allowance-transfer)
  has two authorization layers: the token's allowance to Permit2 and Permit2's
  allowance to the router or position manager. This integration uses exact
  onchain approvals, reusing sufficient allowances and setting Permit2 expiry
  to the operation deadline. These prerequisites advance automatically within
  the requested flow. They are separate transactions and are not atomic with
  its final effect. Ordinary ERC20 allowances do not expire with that deadline.

Swap auto-selection compares observed direct V3 and V4 pool quotes. This is not
global routing: split routes, multi-hop routing and UniswapX are outside this
integration. Default V4 candidates use common static fees without hooks.
Advanced inputs retain the complete PoolKey and hook data; imported positions
retain their actual pool and range. A hook may require integration-specific data
or change accounting. A successful position read does not guarantee its next
modification will simulate successfully.

## Position discovery

[V4 NFTs do not implement ERC721 enumeration](https://developers.uniswap.org/docs/sdks/v4/guides/managing-liquidity/position-fetching).
V3 uses its manager's onchain enumeration. V4 uses browser requests to the public
Ethereum and Arbitrum Blockscout instances for candidate token IDs:

```text
https://eth.blockscout.com/api/v2/tokens/{manager}/instances?holder_address_hash={owner}
https://arbitrum.blockscout.com/api/v2/tokens/{manager}/instances?holder_address_hash={owner}
```

Both endpoints were checked using public fixture addresses: HTTP 200, no API
key, CORS `*`, and owner-filtered results. Their metadata is not authority: each
candidate is checked with `ownerOf`, and position/pool values come from Wallet
contract reads at a consistent block. Pagination and incomplete discovery remain
visible; an unavailable index is not an empty wallet. Confirmed mint IDs and
manual imports allow management independently of indexing delay.

[Blockscout documents a planned API access change](https://docs.blockscout.com/devs/apis/requests-and-limits),
so its adapter is replaceable. The app does not fetch NFT media or put SVG
metadata into Agent results. Uniswap's hosted liquidity API would require a
[server-held API key](https://developers.uniswap.org/docs/liquidity/liquidity-provisioning-api/integration-guide),
which would introduce an unnecessary service dependency for this architecture.

## Durable execution and release compatibility

The released `uniswap` memory root remains version 1 with its exact schema and
saved legacy swaps. A separate `uniswap_actions` version 1 root stores new
multi-step flows. Installation initializes that new root while preserving the
old one. EVM Wallet's existing roots remain at their released versions.

Each flow retains its original input, account identity, authenticated caller and
execution mode. Each transaction has a durable request ID saved before Wallet
dispatch. Resume checks its exact request and actual receipt before advancing.
An expired, known unsigned plan can be refreshed within the original inputs;
an ambiguous dispatched request keeps its original identity. An approval receipt
never completes a swap or liquidity operation. Human UI recovery does not take
over Agent-owned flows.

The same provider review is used by UI and Agent tools. The owner sees the
Wallet dialog; an active root Agent receives the exact review under the existing
permission flow. Transaction interpretation belongs in EVM Wallet presentation,
with full bytes retained in advanced details, not in Kernel policy.

SDK math and V4 action planning remain in the browser bundle. Thin position
manager wrappers use the app's own ABI definitions: importing the SDK's V3
manager helper also emitted an unused Solidity contract artifact. The build
records hashed output contributions to prove the audited artifact packages
contribute no distributed bytes. Their compiler dependencies are then excluded
from the notice inventory; unknown package versions or changed outputs require
fresh evidence. Missing standalone MIT files in actual SDK dependencies use
exact audited upstream text or installed README material, never a guessed license.

Uniswap release validation includes clean initialization, restoration of both
Uniswap roots with legacy swap data and saved actions, action recovery, SDK
calldata checks, local contract execution and browser flows. Wallet's own release
tests cover its three managed roots. Public network probes are read-only;
local execution uses fixture funds. Publication follows the
[production package workflow](./package-updates.md) and its required identical
second no-op receipt.
