# Curve

Curve swaps and liquidity management through the installed **EVM Wallet** on
Ethereum and Arbitrum. This is an independent Neutron integration, not an
official Curve Finance application.

The tile offers Swap, Liquidity and Activity, with automatic quotes, searchable
assets and pools, token balances, secondary USD estimates, network fee estimates,
slippage and recipient settings, and saved transaction progress. The resident
tools complete the same operations for Agent callers.

## Supported operations

| Operation | Behavior |
| --- | --- |
| Swap | Exact input through Curve Router; compare supported direct pools, with ETH/WETH wrapping hops when needed |
| Add liquidity | Exact per-coin budgets; preview LP minted and enforce a minimum |
| Remove liquidity | Proportional withdrawal of pool assets, or one selected pool coin; enforce minima |
| Positions | Current LP token balance and proportional underlying amounts in the signing wallet |
| My pools | Durable references saved explicitly or after a completed liquidity action |
| Activity | Paginated original operations, approvals, final receipts and explicit continuation |

Supported families are StableSwap NG plain pools (2–8 coins), StableSwap NG
metapools (two pool coins, including a base LP token), Twocrypto NG and Tricrypto
NG. Legacy adapters cover Ethereum 3pool and ETH/stETH, and Arbitrum 2pool and
ETH/wstETH. Legacy liquidity overloads pay the signing wallet; they do not
provide a custom recipient parameter. Tricrypto NG supports optional native ETH
where WETH is one of its coins. Other NG liquidity uses the listed ERC20 coins.

The interface does not present API liquidity as personal wealth or advertise a
globally optimal route. Discovery can be partial or unavailable. Selected NG
pools are verified through the correct factory and their own coin methods;
legacy pools match explicit deployments. Token decimals, pool balances and LP
supply are read at the same block. Metadata labels and USD prices are secondary
observations. A verified pool can still revert or have asset-specific behavior;
the wallet simulates and reviews each exact transaction.

## Token identity and ordering

The token menu puts **Listed** assets first, matched by the exact network and
contract address against the bundled Neutron list and Curve defaults. Within
that list, common swap assets come first. **Unlisted** assets follow by symbol
and address. This is **not a liquidity ranking**. A copied USDC/USDT symbol,
reported pool TVL, or Curve factory registration cannot grant a listed badge.
Listing is identity metadata, not a safety rating; an unlisted token is not
necessarily fake. All assets remain selectable without an import approval gate.

Each menu entry has its full contract address and an explorer link. The selected
asset keeps its Listed/Unlisted label; expand it to see the network, full address,
explanation and source for listed metadata. Search accepts listed names, symbols
and addresses; a full address only returns that exact contract. Other pasted
contracts are read onchain and remain unlisted.

Arbitrum **USDC** (Circle-issued) and **USDC.e** (bridged from Ethereum) are
separately named, even if pool metadata reports both as USDC. Arbitrum's Tether
asset uses the **USDT0** label. Stablecoin addresses were checked on 2026-09-07
against [Circle's deployments](https://developers.circle.com/stablecoins/usdc-contract-addresses),
[Circle's native/bridged Arbitrum explanation](https://www.circle.com/blog/usdc-on-arbitrum-now-available),
[Tether's supported protocols](https://tether.to/en/supported-protocols/) and
[USDT0 deployments](https://docs.usdt0.to/technical-documentation/deployments).
The bundled metadata and its source links live in `src/tokens.ts` and the shared
EVM asset catalog. No remote token-list response assigns badges at runtime.

## Quote behavior

NG withdrawal previews simulate the actual zero-minimum overload. This includes
admin-fee claims, LP supply changes and rounding before deriving user minima;
the standalone Twocrypto withdrawal view can overestimate the executable output.
Curve enforces minimum output **without an onchain deadline**. Quote freshness
defaults to 20 minutes and slippage to 0.5%; a fresh unsigned plan needs fresh
wallet review. Staking, gauge rewards, lending, underlying metapool zaps and
exhaustive portfolio indexing are outside this release. Trading fees accrue in
LP value, rather than a separate Uniswap-style fee claim.

## Wallet and recovery

There is no private key, signing capability, backend RPC proxy, Permit2 grant,
or shared mutable network selection in Curve. The manifest declares the exact
public EVM Wallet tools. Every resident call uses its invocation-scoped Kernel
client, retaining the authenticated caller and Agent approval context. Wallet
effects use the public `provider_once` review path; Curve never substitutes a
root-agent attestation. Approvals use exact budgets, reuse sufficient allowances,
and reset nonzero mainnet USDT allowance when needed.

One 32-hex `operationId` identifies immutable original inputs, caller and wallet
identity. Before a Wallet effect, the managed `curve@1` root stores its exact
request ID, calldata, value and unresolved-dispatch marker. Approvals must be
confirmed before the final action. Success requires the matching actual final
transaction and a successful receipt. A linked speedup is checked for identical
sender, destination, value and calldata; cancellation or a different replacement
does not count as completion. Status reconciliation can detect a reorganization.

After an interrupted reply, use **Continue in wallet**, or continue with the same
operation ID from the originating Agent. Checking status never starts a new
approval. Ambiguous requests retain their IDs; quote renewal creates a linked
attempt only after the previous plan is known to be unsigned. Reloading reads
the journal and exposes saved progress without starting a new transaction.
Completed approvals are retained and current allowances are reread on renewal.

`curve@1` was introduced in release 100 and is retained unchanged in release 101,
including its exact schema and lock lineage. The release test plans a clean
initialization and a non-destructive upgrade from the released 100 archive.
EVM Wallet's released `evm_wallet@1` and
`evm_evidence@1` roots remain unchanged. Existing installations upgrade through
Neutron's checked install transaction; clean reinstall is not an upgrade path.

## Tools

Read tools: `curve_pools_v1`, `curve_tokens_v1`, `curve_pool_v1`,
`curve_position_v1`, `curve_tracked_pools_v1`, `curve_quote_v1`, `curve_fees_v1`,
`curve_status_v1`, `curve_history_v1`.

State and execution tools: `curve_track_pool_v1`, `curve_execute_v1`,
`curve_continue_v1`, `curve_reconcile_v1`. Follow pagination cursors for history
and offsets for discovery. Amounts use decimal **atomic-unit strings** and chain
IDs are `"1"` and `"42161"`. Native ETH is a null token address. Pool references
include `chainId`, `address` and `family`. Tool descriptions and closed schemas
describe the supported inputs, observations and continuation rules.

## Official contract references

| Deployment | Ethereum | Arbitrum |
| --- | --- | --- |
| Router | `0x45312ea0eFf7E09C83CBE249fa1d7598c4C8cd4e` | `0x2191718CD32d02B8E60BAdFFeA33E4B5DD9A0A0D` |
| StableSwap NG factory | `0x6A8cbed756804B16E05E741eDaBd5cB544AE21bf` | `0x9AF14D26075f142eb3F292D5065EB3faa646167b` |
| Twocrypto NG factory | `0x98EE851a00abeE0d95D08cF4CA2BdCE32aeaAF7F` | same |
| Tricrypto NG factory | `0x0c0e5f2fF0ff18a3be9b835635039256dC4B4963` | `0xbC0797015fcFc47d9C1856639CaE50D0e69FbEE8` |

Discovery uses `https://api.curve.finance/api/getPools/{network}/{family}` with
`ethereum` or `arbitrum` and `factory-stable-ng`, `factory-twocrypto`,
`factory-tricrypto`, or `main`. Browser requests omit credentials. See Curve's
[integration overview](https://docs.curve.finance/developer/integration/overview)
and the pinned official sources used to check the adapters:

- [curve-js deployment constants](https://github.com/curvefi/curve-js/tree/e51fa54e73afa08ed3fe99cd508b163559b130a9)
- [StableSwap NG](https://github.com/curvefi/stableswap-ng/tree/911b5b45e4edafda96a74ec5f464a673c380456c)
- [Twocrypto NG](https://github.com/curvefi/twocrypto-ng/tree/5cbe558902402e8fcb331463089db65fc56c11f9)
- [Tricrypto NG](https://github.com/curvefi/tricrypto-ng/tree/ecaa8161c240f21dd7c3712eefc5637e1dac742b)
- [Curve Router NG](https://github.com/curvefi/curve-router-ng/tree/2d49362b11a3275a29f3f77df15df6c4b7b1a75c)

## Qualification and packaging

```sh
npm --workspace neutron-curve test
npm --workspace neutron-curve run test:browser
npm ci --prefix apps/curve/test/fixtures
npm --workspace neutron-curve run test:contracts
npx tsc -b apps/curve apps/evm_wallet --pretty false
npm --workspace neutron-evm-wallet test
npm run license:check
npm run security:check
```

Unit tests cover atomic precision, independent ABI decoding, registration,
approvals, durable replay, lost replies, cancellation, quote renewal, caller
identity, replacements, unavailable RPC, concurrent continuation and reorgs.
Token tests cover duplicate symbols, spoofed list metadata, high-TVL impostors,
address casing, exact-address search and native/bridged chain separation. Browser
checks exercise those distinctions and retain the unlisted label after selection.
The Motoko test runs clean initialization and restores a populated root with
pending state, immutable input, revisions, linked attempts and paginated history.

The contract fixture executes generated swaps, deposits, proportional and
single-coin withdrawals against official deployed code on pinned local forks:
Ethereum block `25922607`, Arbitrum block `502541973`. It checks LP burns/mints,
recipient token balances, native handling and reverting minima. Only a
loopback Anvil receives transactions. Fixture account balances are funded locally;
RPC providers supply read-only fork data. `CURVE_FIXTURE_DEPS` can point to an
existing isolated Anvil 1.7.1 installation. The browser fixture runs the real
React tile, resident service, Wallet SDK, tool schemas and generated backend
schemas, with mock Kernel transport and observations. Its state survives reload;
screenshots and results go to `/tmp/neutron-curve-browser` by default. These
fixtures do not claim a funded production transaction or a deployed canister UI.

Build the complete workspace package with `npm --workspace neutron-curve run
package`. Release 101 uses the shared `LICENSE.APP.USE` and offered-source
packaging workflow. Publish and verify the catalog transaction as described in
[package updates](../../doc/package-updates.md); publishing does not install
Curve into existing Neutrons or alter the Dispenser starter.
