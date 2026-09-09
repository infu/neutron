# ICPSwap Client

An independent ICPSwap integration for Neutron: token swaps, concentrated
liquidity, positions, market charts and agent tools. The app uses the same compact
header and controls as the other DeFi apps, with layouts for narrow tiles and
larger workspaces. It is not an official ICPSwap application.

## Using the app

- **Markets:** search tokens, maintain a watchlist, inspect pools and recent
  trades, and open price, volume and TVL charts. Candlesticks support crosshair
  inspection by pointer, touch or keyboard; USD/ICP price views retain the
  observation source.
- **Swap:** select tokens and an amount, inspect the quote, then review the
  trade. Wallet supplies live token metadata, balances and funding. The 0–100%
  slider and shortcuts use exact atomic-unit arithmetic; Max leaves the required
  ledger fees. New tokens can be added to Wallet through its existing review.
  Failed reads keep manual amounts intact and offer retry without sending funds.
- **Liquidity:** discover a verified pool, choose an aligned price range and
  token maxima, and create a position. Existing positions support increasing,
  partially decreasing, closing and claiming fees. Pool-unused tokens remain
  visible and can be withdrawn separately when the protocol permits it. Position
  cards show token holdings, estimated USD value, current uncollected fees and
  the current price within the chosen range.
- **Activity:** inspect saved requests, funding, protocol results and recovery
  details. Plain-language outcomes distinguish pool execution from Wallet payout;
  technical references stay under Details. Continue the original operation after
  an interrupted reply.

Liquidity amounts use the factory's canonical token order and tick spacing.
An out-of-range position may require only one token. Closing removes all of the
position's current liquidity; a partial decrease also collects its accrued fees.
LP previews are estimates: ICPSwap's liquidity methods do not accept price
minima, deadlines or caller-supplied idempotency keys. Desired amounts bound
spending but do not provide protocol-enforced slippage protection. Ordinary swaps
have an output minimum; their slippage unit is thousandths of one percent
(`500` means `0.5%`).

Position P&L estimates use complete paginated ICPSwap analytics history: actual
additions and gross outputs valued at their historical prices, plus current
holdings and uncollected fees. The estimate is before ledger and network fees,
and protocol outputs do not prove Wallet settlement. Missing original additions,
ownership transfers, incomplete liquidity history, or unavailable fees/prices
leave P&L unavailable. A matching analytics history can still lag recent claims;
this is an estimate, not an audited account return. Holdings remain usable while
history loads. Token-detail reads share an app-local queue so opening a pool does
not launch competing Wallet permission dialogs.

## Agent tools and approval

The resident background exposes tools even when no tile is open. Retrieve the
current tool schema before calling it; amounts and identifiers that exceed
JavaScript's safe integer range are decimal strings.

| Tools | Purpose |
| --- | --- |
| `icpswap_search_tokens`, `icpswap_top_tokens`, `icpswap_token_info` | Discover tokens and inspect market data |
| `icpswap_market_overview`, `icpswap_token_pools`, `icpswap_recent_trades` | Inspect the watchlist, pools and trading activity |
| `icpswap_price_chart`, `icpswap_local_history` | Read candles and locally retained price observations |
| `icpswap_watchlist_add`, `icpswap_watchlist_remove` | Maintain the watchlist |
| `icpswap_quote_swap` | Obtain a quote without funding or trading |
| `icpswap_liquidity_pools_v1`, `icpswap_liquidity_pool_v1` | Discover canonical pools and inspect positions, unused tokens and pending payouts |
| `icpswap_positions_v1` | Read this Neutron's positions, including pools retained in local operation history |
| `icpswap_liquidity_range_v1`, `icpswap_liquidity_quote_v1` | Calculate tick-aligned amounts and inspect a complete action preview without funding |
| `icpswap_swap_v1` | Prepare and execute a saved swap |
| `icpswap_liquidity_v1` | Prepare and execute `mint`, `increase`, `decrease`, `close`, `claim` or `withdraw` |
| `icpswap_continue_v1`, `icpswap_status_v1`, `icpswap_reconcile_v1`, `icpswap_history_v1` | Continue or inspect an existing operation and refresh recovery evidence |
| `icpswap_recover_deposit_v1` | Credit an already transferred direct deposit without sending Wallet funds again |

The manifest declares the Wallet tools ICPSwap calls: `wallet_token_info_v1`,
`wallet_add_ledger_v1`, `wallet_fund_v1`, `wallet_account_transactions_v1` and
`wallet_transaction_v1`. Ledger setup uses Wallet's existing additive approval
flow. Root funding instructions remain direct Agent-to-Wallet calls, preserving
their authenticated caller; ICPSwap does not call a root-only tool on its behalf.

Agents can add and remove watchlist tokens through the existing Kernel
permissions. Root agents need no click; normal agents use the existing approval
flow. These tools update the saved ICPSwap market list without moving funds.

New action calls require a stable 32-character hexadecimal `operationId`.
Normal agents receive an app review before dispatch, and Wallet reviews each
new funding request. Root agents can perform the same flow without a click.
When root execution returns `fundingInstructions`, the root calls those exact
`wallet_fund_root_v1` requests directly and passes their raw replies to
`icpswap_continue_v1({ operationId, fundingResults })`. The existing Wallet
contract requires that direct root call; ICPSwap does not acquire a new Kernel
privilege to impersonate it.

Saved funding requests retain their original caller, normal/root mode, request
IDs and deadlines. Continue from the same caller and mode. An interrupted request
reuses those identities; it does not generate another allowance or transfer.
Only an expired request that was never dispatched can be refreshed automatically.
An expired confirmed allowance requires inspecting the saved funding before
another pool call, while a completed direct transfer remains recoverable after
its request deadline.

The legacy `icpswap_agent_swap` and `icpswap_execute_swap` names use the same saved
flow. Calls without an operation/request ID prepare an intent and return an ID
for continuation. Legacy swap history remains available.

## Funds and recovery

Wallet owns token-ledger reads, approvals and transfers. ICPSwap's backend calls
the protocol as the Neutron canister, so positions and pool-unused tokens belong
to the same account Wallet uses. The app declares no token-ledger mutation or
read reservation and needs no Kernel changes.

Liquidity preparation first accounts for usable pool-unused tokens and funds
only the remaining deficit. ICRC-2 funding uses a Wallet allowance followed by
pool `depositFrom`. ICRC-1 funding uses a Wallet transfer to the caller's pool
deposit subaccount followed by pool `deposit`. The saved plan retains each leg,
its fees and exact destination. Unsupported token standards are identified
before funding.

For a confirmed direct Wallet transfer whose original pool deposit was never
dispatched, `icpswap_recover_deposit_v1` accepts a new recovery `operationId`,
the original `sourceOperationId` and `tokenIndex` (`0` or `1`). It credits the
already transferred gross amount less the current pool transfer fee, without
requesting another Wallet transfer. The original deposit identity is reserved
against duplicate crediting. After recovery, use the pool-unused tokens for
liquidity or withdraw them separately. A human can review recovery of confirmed
root-funded tokens because this step does not change the original Wallet
command's caller. An unresolved Wallet transfer must first be reconciled using
its original caller and request identity.

Protocol execution and wallet payout are separate outcomes. Mint/increase
refunds, decreases, claims and withdrawals can settle asynchronously through
ICPSwap's own queues. Closing the tile or dismissing a notification does not
cancel a protocol payout or delete the app's saved operation. A flow paused
between app-controlled steps can be continued from Activity or the tools.

A confirmed claim returning zero in both tokens is complete with no payout
required. Status derives that result from the saved reply; reconciliation also
repairs older journals that recorded it as settlement pending. Other successful
actions retain unverified payout status until operation-linked receipt evidence
exists. The pool removes completed transactions from its active list, and its
liquidity replies do not identify the outgoing ledger blocks. Empty queues and
matching Wallet balances cannot establish which operation paid them.

The populated `plan` in action responses is decoded from the durable Candid
`plan_blob`; an empty legacy `operation.plan_json` does not mean the plan was
lost. Liquidity receipts expose known position IDs and gross protocol outputs.
Actual mint/increase token use, refunds and ledger payout links remain unavailable
where the retained protocol reply does not supply them. Estimates and input
budgets are not substituted for those actual amounts.

Swap receipts preserve the legacy numeric `received_out` field for compatibility
but explicitly set `received_out_verified=false` and `netOutputAtoms=null` until
an operation-linked payout is known. The legacy zero is not an observed Wallet
credit. This representation also applies when reading older saved swaps.

`icpswap_reconcile_v1` now includes Wallet evidence for retained successful
protocol effects: recent pool-to-owner transfers, their exact amounts/memos and
index coverage. Set `walletEvidence=false` for a pool-only reconciliation. Pass
`payoutBlocks: [{ ledger, blockIndex }]` to inspect specific canonical ledger
blocks, including returned archives. Index fallback is explicitly unverified;
even a verified ledger transfer remains contextual evidence when the original
operation did not retain its protocol transaction ID. Neither matching amounts
nor empty pages change the operation to settled. Wallet failures leave the
protocol result available, and no reconciliation path repeats financial effects.

The journal records a protocol dispatch before awaiting its reply. An unknown
reply is retained as uncertain and is never automatically sent again. Empty
queues, missing protocol transaction records or an unrelated balance change do
not prove that an operation never ran. Inspect the same operation and its pool
before deciding what to do next.

Some upstream failures need ICPSwap support: a failed ledger payout can occur
after the pool debits unused funds, and the repair methods are admin-only. The
app preserves the pool and transaction diagnostics instead of claiming that
ordinary withdrawal can repair every failure. Amounts at or below a ledger fee
can remain as pool dust. See the reviewed
[withdrawal queue and recovery implementation](https://github.com/ICPSwap-Labs/icpswap-v3-service/blob/94eeb92ad6ecc2713d38fd3bef48cd4f328a3513/src/SwapPool.mo).

## Data and protocol sources

Analytics requests go directly from the browser to `https://api.icpswap.com/info`.
Position and pool queries use anonymous browser calls through
`https://icp-api.io`; results are filtered for the actual Neutron account, and
partial read failures remain visible. Token icons are fetched separately for
presentation. Backend calls are used for protocol writes, durable operations and
scheduled local market observations. Browser reads avoid canister HTTP-outcall
costs.

Backend pool snapshots identify stored fee amounts as not current and explain
the missing refresh. Position reads and liquidity previews obtain the protocol's
current fee estimate; failed reads remain unavailable instead of becoming zero.

The integration was checked against
[ICPSwap v3.7.0, commit `94eeb92`](https://github.com/ICPSwap-Labs/icpswap-v3-service/tree/94eeb92ad6ecc2713d38fd3bef48cd4f328a3513)
and production Candid interfaces on 2026-09-09. All 16 checked method type graphs
match the official source; certified module hashes were also recorded separately.
This does not establish a byte-identical source-to-Wasm build. Factory discovery determines
pool identity, token order and spacing. The position index uses the owner's
legacy ICP account identifier; locally touched pools remain discoverable after
their last position closes. Current protocol version strings do not establish
that deployed Wasm exactly matches a source commit.

## Persistent state and release

All persistent state stays app-local:

| Managed root | Version | Contents |
| --- | --- | --- |
| `icpswap` | 1, preserved | Watchlist, local history, quotes, decimals and refresh bookkeeping |
| `icpswap_swap` | 1, preserved | Released swap records, funding details, order, settings and completion count |
| `icpswap_actions` | 1, preserved | Immutable action plans, Wallet request identities, protocol dispatches and recovery evidence |

All three production v1 schemas and their lock entries are retained exactly.
The imported draft's additional fee cache is transient; it does not replace the
released swap schema. Wallet fee observations refresh that cache, including a
valid zero fee. Release 201, 202 and 203 installations keep all three roots. Upgrades from
release 200 keep both original roots and initialize only the actions root.
No fake migration, reinstall or reset is required.
Historical public schema assets are pinned in `test/fixtures/history/200` for
compatibility tests; they are not a reconstructed release archive.

```sh
npm --workspace neutron-icpswap run package
npm --workspace neutron-icpswap test
npm --workspace neutron-icpswap run test:chart
npm --workspace neutron-icpswap run test:browser
```

The test command packages the app, runs its TypeScript tests and then runs the
Motoko programs. Coverage includes production-root restoration, exact packaged
schema closure, action recovery, funding identity, token and liquidity math,
browser reads and tool contracts. Protocol write tests use local fixtures;
read-only production probes do not establish successful production trading.

The app uses the repository's shared `LICENSE.APP.USE`, application notice and
Complete App Source packaging workflow. Production packages use update source
`233tv-xiaaa-aaaay-aacta-cai`; publication and installation follow
[the repository release workflow](../../doc/package-updates.md).
