# Uniswap

An independent Neutron app for exact-input Uniswap V3/V4 swaps and liquidity
management on Ethereum (1) and Arbitrum One (42161). It uses the separate **EVM Wallet** app for accounts, public
RPC reads, transaction review, signing, broadcasting, and receipts. It has no
signing capability, private key, browser wallet provider, embedded provider key,
or independent transaction sender.

## Swaps and liquidity

New swaps compare direct V3 and V4 pools, with Auto, V3 and V4 selection. V4
uses Universal Router 2.1.1 and its exact deployed tuple encoding. Native ETH
is a zero-address V4 currency; it is separate from WETH. The official pinned
SDK handles concentrated-liquidity amounts, ranges and position calldata.
See [the integration research and design](../../doc/uniswap-v4-liquidity.md)
for deployments, SDK pins, Permit2 and browser discovery.

The **Liquidity** tab lists V3 and V4 positions and supports minting in an
initialized pool, adding, removing, collecting fees and closing a position.
Amounts are maximum deposit budgets. The preview fits liquidity and slippage
maxima within them. Approvals and the final action advance in one resumable
flow; approval alone is never completion. Pool, range, hook and raw transaction
details remain expandable. Creating a new pool with an initial price is not
part of minting a position in this release.

V3 compares **direct, single-pool V3 routes** across the 0.01%,
0.05%, 0.3%, and 1% fee tiers. It uses `QuoterV2.quoteExactInputSingle` through
EVM Wallet's direct browser-to-RPC `eth_call` path and builds a deadline-protected
`SwapRouter02.multicall` containing `exactInputSingle`.

| Chain | QuoterV2 | SwapRouter02 | Wrapped native token |
| --- | --- | --- | --- |
| Ethereum | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` |
| Arbitrum | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` |

Deployments and interface definitions were verified against official sources on
2026-09-05:

- [Ethereum deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-ethereum-deployments)
- [Arbitrum deployments](https://developers.uniswap.org/docs/protocols/v3/deployments/v3-arbitrum-deployments)
- [SwapRouter02 interface](https://github.com/Uniswap/swap-router-contracts/blob/550c0f20373a487996fcc957075377b67af9df07/contracts/interfaces/IV3SwapRouter.sol)
- [Deadline multicall](https://github.com/Uniswap/swap-router-contracts/blob/550c0f20373a487996fcc957075377b67af9df07/contracts/base/MulticallExtended.sol)
- [QuoterV2 interface](https://github.com/Uniswap/v3-periphery/blob/697c2474757ea89fec12a4e6db16a574fe259610/contracts/interfaces/IQuoterV2.sol)

The V3 route retains ordinary ERC20 approvals to SwapRouter02. V4 uses exact
ERC20 approvals to Permit2 and expiring Permit2 approvals to the selected router
or position manager, reusing existing sufficient allowances. These prerequisites
are separate transactions and advance automatically. EIP-2612, split/multi-hop
routing and UniswapX are not represented as supported. No API credential is needed.
The direct-pool quote is the best observed output among available fee tiers, not
an assertion that it is the globally best route. A missing pool or provider
failure is recorded as unavailable. If every quote fails, the app cannot prepare
a swap. Spot price impact excludes the pool fee and is unavailable when pool
state and quote cannot be observed at the same block.

## Use

1. Install EVM Wallet and Uniswap through the compatible Kernel update set.
   Open the Uniswap tile and select Ethereum or Arbitrum. Account, balance and
   history reads start automatically using the exact Wallet tools declared in
   installation consent. There is no separate Connect or Refresh permission
   prompt. Tracking can reconcile or resend only already-approved signed bytes.
   New transactions retain their separate exact Wallet confirmation.
2. Fund the EVM address on that network, including ETH for gas. IC cycles used
   by signing/state updates and EVM gas are separate balances. Quote and balance
   reads use direct browser RPC and do not spend IC outcall cycles.
3. Select a preloaded token or search/add a custom token contract. The shared
   catalog includes Ethereum counterparts of the supported ckERC20 assets;
   [token addresses and artwork](../evm_wallet/TOKENS.md) remain network-specific.
4. Enter the input amount. Quotes update automatically after a short typing
   debounce and whenever tokens, network or other quote inputs change. Stale
   responses cannot overwrite the current draft. The normal view shows amounts
   and a fee summary; recipient, slippage, deadline and technical observations
   are in collapsed settings/details. Separate approval and swap fee estimates
   use EVM Wallet's read-only `evm_estimate_transaction_v1` with the
   exact sender, destination, value and calldata. The Quoter gas-unit estimate
   describes pool execution and is never substituted for a full network fee.
   Missing fees are shown as unavailable, with the provider's reason; a swap
   requiring approval may not simulate until that approval confirms. The total
   is unavailable until every required transaction has a complete estimate.
   EVM Wallet separately reviews live fees before each signature.

   Pool tiers are read concurrently. The quote appears as soon as its route
   and allowance are ready, while separate fee estimates load with visible
   progress and elapsed time. Contract calls use the Wallet's lightweight read
   path without repeatedly downloading deployed bytecode. Price-impact reads
   request the selected quote's exact block. Getting a quote does not repeat
   unrelated balance reads.
5. Click **Swap**. Confirm token approval in EVM Wallet if needed; Uniswap waits
   for its successful receipt and opens the swap confirmation automatically.
   It follows the submitted swap through confirmation and refreshes balances.
   Approval and swap are separate EOA
   transactions and are not atomic. No approval is silently unlimited. Ordinary
   ERC20 allowance has no automatic expiry: it remains until spent or revoked;
   the swap deadline does not expire that approval.
6. Balances and history refresh while the app is visible and on focus.
   A reload retains the saved intent and exact request IDs; pending requests are
   reconciled before another dispatch. **Continue** resumes an interrupted
   owner-started flow. New unified flows renew expired, known unsigned quotes
   within their original inputs and recheck existing allowance. Old signed or
   uncertain requests retain their original identity. Earlier V3 intents keep
   their compatible continuation behavior. Raw request and transaction details remain collapsed.

Fee arithmetic uses exact integer wei throughout. Ethereum estimates use the
observed base fee plus priority fee, with a separately displayed suggested
maximum. On a real Arbitrum Nitro RPC, the full `eth_estimateGas` result already
includes the L1 posting component in L2 gas units. The app uses that total once
and never adds another posting charge. An incomplete RPC estimate is explicitly
unavailable; a plain Anvil chain configured as `42161` only proves the arithmetic
and request path, not Nitro posting costs or finality. Quote refresh obtains new
fee observations. EVM Wallet prepares current fees before each transaction
confirmation. Original quote observations remain in the durable intent.

For V3, native ETH input is sent as the transaction value; the router wraps it and
refunds any remainder in the same multicall. Native output goes to the router,
then `unwrapWETH9(minimum, recipient)` pays the intended recipient. Token output
is sent directly to that recipient. ETH↔WETH wrapping is not a pool swap.

New flows include the required zero-allowance reset for Ethereum USDT when
replacing an insufficient nonzero allowance. Other ordinary tokens avoid that
extra transaction; a custom token with different approval behavior may require
an explicit revoke in EVM Wallet. Every planned approval receives Wallet review. Fee-on-transfer/rebasing tokens can fail standard V3
assumptions and are not advertised as supported. Output ERC20 receipt transfers
are counted only for the selected token and intended recipient. Native transfers
have no ERC20 Transfer log; their destination/minimum are bound by the verified
router calldata and successful unwrap call.

## Durable recovery

New unified swaps and liquidity operations use the separate `uniswap_actions`
v1 root, with immutable original inputs/account/caller, retained attempts, exact
step request IDs, receipts and compact paginated history. Known unsigned expired
plans can renew within the original inputs. Ambiguous dispatched steps retain
their IDs and reconcile before further effects. Imported and minted position
references are durable hints; current NFT ownership and state are always read
onchain. Existing roots and legacy request identities remain intact.

The following compatibility behavior applies to previously saved V3 swaps:

The legacy managed root, `uniswap` v1, owns complete quote-derived intents, wallet
identity (address, key fingerprint, namespace version), authenticated Agent caller
installation where applicable, exact approval and swap
request IDs/JSON, operation evidence, phases, revisions, and timestamps.
Local storage is not the source of truth. `uniswap_begin_v1` rejects a changed
intent under an existing ID. `uniswap_update_v1` requires the same stage request,
account and network and uses a revision check so stale tiles cannot overwrite a
newer observation. The app saves `*_requested` before awaiting EVM Wallet.

On resumption the consumer checks the same wallet identity and scoped operation
status. A known submitted, unknown, rejected, reverted, or completed operation is
not turned into a fresh send. A definitive absent operation may submit the same
saved request. Compatible app upgrades retain the published `uniswap` v1 root
unchanged. Optional fee observations and verified replacement evidence use the
existing quote/operation JSON fields; old records without those annotations
remain readable and retain their original request IDs. There is no fake schema
migration. A replacement EVM Wallet signing namespace is not treated as the
same account.

Saved history is read in pages, newest first. If a page exceeds the existing
Kernel response boundary, the app retries that same cursor with fewer records.
**Load older swaps** keeps every retained intent reachable; paging never removes
records or shortens request/receipt evidence. A single oversized record remains
an explicit error instead of being skipped. Newly saved swaps use the durable
begin result to open Wallet review without requiring a full-history reload.

Receipt inclusion is shown separately from finality. An included Ethereum or
Arbitrum receipt can still be reorganized. The interface preserves the wallet's
reported finality instead of claiming immediate final settlement.

For a replacement transaction, the original Wallet request ID and transaction
hash remain intact. The app follows the Wallet's authenticated replacement link,
independently checks the replacement sender, destination, calldata and value,
and keeps its receipt separate. A successful exact replacement approval can
unblock the swap; a cancellation or changed payload never counts as that
approval or swap. Pending replacement evidence stays unresolved and is checked
again with the same saved request IDs. Agent results additionally require
`evm_replacement_transaction_v1` to prove the signed replacement belongs to the
saved original caller and request. The original `evm_transaction_v1` schema and
exact-request binding remain unchanged.

## Resident tools and Agent

Use `uniswap_swap_v2` for new Auto/V3/V4 swaps and
`uniswap_manage_liquidity_v1` for complete mint/increase/decrease/collect/close
flows. Keep the same `operationId` and original inputs on every retry.
`uniswap_quote_v2`, `uniswap_positions_v1`, `uniswap_position_v1`,
`uniswap_pool_v1` and `uniswap_liquidity_quote_v1` perform reads and previews.
`uniswap_action_status_v1` and `uniswap_actions_page_v1` show durable progress.
Reads use installation-approved Wallet tools; each effect still receives the
Wallet's exact human or Agent provider review.

The v1 swap tools remain compatible with previously saved intents:

| Tool | Behavior |
| --- | --- |
| `uniswap_swap_v1` | Complete a provider-reviewed swap, including allowance, approval, safe quote renewal, swap and receipt; retry the same original inputs and `swapId` |
| `uniswap_quote_v1` | Live direct-pool quote with read-only fee observations; native token is `null`; amounts are atomic decimal strings |
| `uniswap_prepare_v1` | Validate the quote and save immutable approval/swap requests under the supplied 32-hex swap ID |
| `uniswap_status_v1` | Read one saved intent and progress |
| `uniswap_list_v1` | Read saved swaps |
| `uniswap_list_page_v1` | Read a complete-record history page; start with null cursor and follow `nextCursor` until null |
| `uniswap_record_result_v1` | Bind a supplied wallet result to the saved request, then independently verify public transaction fields and receipt |
| `uniswap_next_action_v1` | Reconcile supplied root Wallet observations and return the next exact tool call for a saved Agent swap |

For the compatible V3-only tool flow, call `uniswap_swap_v1` once with one 32-hex `swapId`,
chain, input/output token addresses (`null` for ETH), and atomic input amount.
Optional defaults are the main account, the Wallet's own receiving address,
50 slippage basis points, and a 1200-second quote validity window. The tool
quotes, checks allowance, obtains an exact Wallet approval when needed, waits
for confirmation, and obtains the exact swap review before following its receipt.
An approval receipt alone is never reported as a completed swap.

Every effect uses the ordinary public EVM Wallet provider tool. A normal caller
receives the Wallet modal; an active root Agent receives the same exact prepared
transaction through its permission judge and retained owner instructions.
Uniswap does not call a root-only signing tool on this path, impersonate the
Agent, or receive a standing signing grant. Changed prepared transaction details
return `review` and need a new call with the same original inputs and `swapId`.

New tool flows add `executionMode: "provider"` and a versioned `providerFlow`
record inside the existing immutable quote JSON. It binds the original caller
installation, human/Agent mode, exact inputs, root flow ID and renewal attempt.
The existing `uniswap` memory schema stays at v1. If an unsigned quote expires
after approval resolves, the tool reads allowance again and creates a distinct
immutable successor with a deterministic ID; it does not repeat an already
sufficient approval. A retry finds that successor even when its creation reply
was lost. Signed, submitted, signing, and unknown operations remain attached to
their original request IDs. An expired dispatch with no visible Wallet result
cannot justify a fresh intent. Both the legacy Agent records and new provider
records remain visible in history, and the tile cannot resume their effects.

Long calls yield `pending` before the Agent's existing transport deadline.
Cancellation and lost replies preserve the flow ID and saved request IDs. Retry
`uniswap_swap_v1` with the identical original arguments to reconcile and continue;
never create another swap merely because tracking paused. There is no attempt
limit or transaction expiry introduced by this tracking window. Every fresh
Wallet review still checks the owner's current instructions.

The earlier root-owned workflow remains available for installed 0.1.7 and older
intents and approvals. The root Agent obtains a quote and prepared requests, then uses
`uniswap_next_action_v1` to determine which saved Wallet request to check or
execute. The Agent calls EVM Wallet's root tools directly and supplies their
status results to the continuation tool. Hash-bearing results are verified
through the existing public transaction and journal-binding checks before they
count as progress. Uniswap never forwards a nested call as root or grants its
consumer a signer.

Agent tool invocations serialize their nested Wallet calls so independent pool,
token-metadata and fee reads cannot compete for the same Kernel permission
decision. The queue is scoped to that tool invocation and honors cancellation;
the tile still performs independent reads concurrently. Install-declared tool
access removes repeated read prompts while preserving exact provider review.
Quote and continuation tools report progress and use the Agent's existing
long-running-tool annotation.

Continuation preserves ambiguous signed/submitted request IDs and asks for
their status even after the quote deadline. It checks the swap before initiating
another effect. Once the previous swap is known to be unsubmitted and the
approval is resolved, an expired quote can be refreshed with the original
amount, assets, recipient and slippage. The refreshed quote checks live
allowance so a successful approval is reused; the Agent reviews the fresh quote
against the owner's instructions before preparing a distinct intent. Quote
expiry does not by itself require another owner prompt or another approval.

Root-owned EVM Wallet commands are scoped to the Agent installation, so Uniswap
does not impersonate that installation to query its journal. The root supplies a
result as a hint; `uniswap_record_result_v1` uses public `evm_transaction_v1` to
verify chain, hash, sender, router/token destination, value and exact calldata. It
also asks EVM Wallet to match the hash to the exact saved caller installation and
request ID in its own journal; the boolean answer exposes no other private
command. Only a positive match can attach the evidence, preventing reuse of an
older identical transaction under a new swap request. It replaces the claimed
receipt/status with independently read chain evidence.
A result with no visible transaction remains unresolved. A supplied “success”
claim cannot complete a swap by itself.

## Validation

```sh
npm --workspace neutron-uniswap test
npm --workspace neutron-uniswap run test:contracts
npm --workspace neutron-uniswap run test:browser
bunx tsc -p apps/uniswap/tsconfig.app.json --noEmit
```

`test` performs the complete package workflow, TypeScript tests, and the Motoko
managed-memory/journal program. Unit tests independently decode ABI calldata and
cover both chain mappings, exact approvals, slippage, deadlines, unavailable
providers, and recipient/native behavior. Controller tests cover recovery and
wallet-identity/chain-evidence binding.

`test:contracts` uses an isolated temporary npm installation pinned by the fixture
lock. It deploys the official Uniswap factory, pools, position manager, QuoterV2
and SwapRouter02 bytecode on local EVM chains 1 and 42161. It executes native→token,
token→native and token→token swaps, compares actual recipient balances, checks
router refunds/unwraps, and proves expired deadlines/excessive minima revert.
The same harness also starts Cancun-capable Anvil nodes, verifies pinned
Universal Router 2.1.1 source downloads, and executes V3/V4 mint, fee-accruing
swaps, increases, partial removals, collection and closure for native/ERC20
pairs. It uses fixture funds only and does not send transactions to public networks.
Local chain 42161 validates contract semantics and chain binding; it does not
emulate the Arbitrum sequencer's fee calculation or settlement protocol.

The application uses the repository's `LICENSE.APP.USE` and matching offered
source workflow. It is independently developed, not an official Uniswap Labs UI.
