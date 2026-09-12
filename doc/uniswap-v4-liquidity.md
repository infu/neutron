# Uniswap V4 And Liquidity Integration

[Documentation index](./index.md) · [EVM Wallet](./evm-wallet.md)

Use this contract when changing routing, position discovery or durable Uniswap
execution. Read network deployments, ABI definitions and dependency pins from
source rather than copying addresses or package-version snapshots into docs.

## Source map

| Concern | Source of truth |
| --- | --- |
| V3 routing and configured networks | [swap.ts](../apps/uniswap/src/swap.ts) and [swap_routes.ts](../apps/uniswap/src/swap_routes.ts) |
| V4 deployments, PoolKey and swap encoding | [v4_common.ts](../apps/uniswap/src/v4_common.ts) and [v4_swap.ts](../apps/uniswap/src/v4_swap.ts) |
| Position reads and index adapter | [positions.ts](../apps/uniswap/src/positions.ts) |
| Budget-constrained liquidity and calldata | [liquidity_math.ts](../apps/uniswap/src/liquidity_math.ts) and [liquidity.ts](../apps/uniswap/src/liquidity.ts) |
| ERC20 and Permit2 prerequisites | [approval_plan.ts](../apps/uniswap/src/approval_plan.ts) |
| Durable multi-step recovery | [action_workflow.ts](../apps/uniswap/src/action_workflow.ts), [action_store.ts](../apps/uniswap/src/action_store.ts) and [Actions.mo](../apps/uniswap/backend/Actions.mo) |
| Legacy swap reconciliation | [controller.ts](../apps/uniswap/src/controller.ts) and [Journal.mo](../apps/uniswap/backend/Journal.mo) |
| Installed capabilities and memory lineage | [manifest](../apps/uniswap/neutron.json) and [lock](../apps/uniswap/neutron.lock.json) |
| Dependency pins and distributed-byte evidence | [package.json](../apps/uniswap/package.json), repository lockfile and [build.ts](../apps/uniswap/build.ts) |

## Ownership boundary

Uniswap owns route selection, pool/position interpretation, liquidity math and
the durable sequence of approvals and position transactions. EVM Wallet owns
custody, exact transaction review, signing, browser RPC and receipt tracking.
Consumers use installation tool grants and provider review; protocol routing
and liquidity calculations do not require Kernel policy or signing access.

Supported liquidity actions operate on initialized V3 or V4 pools: mint,
inspect, increase, decrease, collect and close. Pool initialization is not
inferred from deposit amounts. Changing a range requires removing liquidity
and minting a position; existing V3 positions are not migrated into V4.

Auto-routing compares observed direct V3 and V4 pool quotes. It does not promise
global, split or multi-hop routing. Default V4 candidates use static fees without
hooks. Advanced inputs preserve the complete PoolKey and hook data. Imported
positions retain their actual pool and range; successful reads do not prove a
hook-dependent modification will simulate or execute successfully.

## Encoding and approval invariants

V4 pool identity includes sorted currencies, fee, tick spacing and hook address.
Native currency uses the zero address and differs from the wrapped native token.
Use the configured deployment's actual ABI when changing encoders. The current
single-swap tuple includes `minHopPriceX36`; an otherwise plausible older tuple
would encode the wrong call. Output to an explicit recipient uses `TAKE`;
`TAKE_ALL` pays the original caller. Native input refunds return to the signing
wallet.

Liquidity math fits the position to both explicit token budgets, including the
slippage maxima that the transaction may spend. Do not derive an approval from
an estimated amount if calldata authorizes a larger maximum. Keep canonical
atomic amounts and contract integer ranges throughout the calculation.

V4 mint settlement uses `SETTLE_PAIR`; increases close both currency deltas
because accrued fees can reverse the amount owed. Decrease/collect returns the
resulting currencies to the recipient. V3 decrease must also collect to return
the owed funds. Position displays keep newly accrued fees distinct from stored
owed balances, which may already include withdrawn principal.

Permit2 requires both the token's ERC20 allowance to Permit2 and Permit2's
allowance to the router or position manager. The planner reuses sufficient
allowances, otherwise constructs exact onchain approvals and sets Permit2
expiry to the operation deadline. ERC20 allowance does not acquire that expiry.
Approval and final-effect transactions are separate and non-atomic. Each new
effect follows Wallet review; an approval receipt cannot complete the requested
swap or liquidity change.

## Position discovery is a source of candidates

V3 discovery uses the manager's onchain enumeration. V4 discovery combines a
browser index adapter with saved and manually imported position IDs. Read the
adapter's configured indexers and request format from `positions.ts`; public
endpoint availability and CORS behavior are runtime observations, not guarantees
recorded in this document.

Index metadata never authorizes ownership or supplies authoritative pool values.
Each candidate passes `ownerOf` and contract reads through Wallet. Dependent
reads are pinned to the same block and reject a different returned block.
Preserve incomplete discovery, pagination and provider errors. An unavailable
index is not an empty wallet; saved/imported positions remain independently
readable. Only definite ownership loss or the known burned-token response may
remove a stale reference; a generic RPC outage must not do so.

The adapter ignores NFT media and metadata URLs. Changing index providers must
retain collection, owner and cursor validation and the subsequent onchain
verification. SDK or index metadata is never a substitute for actual transaction
review.

## Durable execution and memory compatibility

The released `uniswap` root stores legacy swaps; `uniswap_actions` stores the
multi-step action journal and tracked positions. Restore both through the
manifest's declared schemas. The source and lock lineage define the supported
versions. Do not replace the older root when extending the newer workflow, and
do not create a fake migration for code-only changes.

Each flow retains its original inputs, signing account, authenticated caller and
execution mode. Each effect has a durable Wallet request ID saved before
dispatch. Resume verifies its exact request and actual receipt before advancing.
Wallet account address, key fingerprint and namespace must still match the
saved identity. Human UI recovery must not take over an Agent-owned flow.

An expired, definitely unsigned plan can be refreshed within the original
inputs. An ambiguous dispatched request retains its original identity through
expiry and reconciliation. A replacement must prove its Wallet journal ancestry
and satisfy the original effect; a cancellation cannot complete a swap or
position change. Failure to re-read an old approval must not hide an already
submitted final action.

For human calls, Wallet owns the confirmation UI. During an authenticated Agent
invocation, the Kernel-bound provider approval callback obtains a fresh decision
for the exact Wallet review. Nested consumers retain their own installation
identity; they do not gain root audience or Wallet custody.

## Build and qualification

Use the SDK for liquidity math and action planning, with the application's ABI
wrappers for manager calls. Browser imports can pull unused Solidity artifacts
into the distributed bundle. The build records hashed output contributions for
package notice generation. Dependency exclusions require matching build evidence;
changed imports, pins or output bytes require fresh evidence. Use audited license
text through the shared packaging workflow, never an inferred dependency license.

Select checks from the app's [package scripts](../apps/uniswap/package.json),
[contract fixture guidance](../apps/uniswap/test/fixtures/README.md) and
[browser harness](../apps/uniswap/test/browser/README.md). Cover memory restoration
with legacy swaps and saved actions, recovery across uncertain replies, exact SDK
calldata, actual local contract execution and browser provider flows. Mocked
quotes alone do not qualify deployed ABI compatibility. Use fixture funds for
transaction tests and preserve production state.

Publication and offered-source verification follow the
[production package workflow](./package-updates.md). Keep exact versions,
validation runs and receipt evidence with the release artifacts.
