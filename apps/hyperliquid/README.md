# Hyperliquid

Trade default Hyperliquid perpetual markets with the Neutron UI or Agent.
EVM Wallet **0.1.21 or newer** is required for the complete integration, including
HyperEVM bridge recovery. This is an independent integration, not an official
Hyperliquid application.

Market data, WebSockets, ordinary order signing/submission and Circle status
reads run directly in the browser. The master account stays in EVM Wallet.
The app has no canister HTTP outcalls or threshold-signing step per trade.
The trading UI uses mainnet. Explicit testnet parameters remain available to
tools and automated tests; there is no network selector in the trading tile.
Spot trading, HIP-3 markets, vaults and account-abstraction changes are outside
this app. Existing unified collateral is read without changing its mode.

## Trading

Market orders are price-bounded IOC orders and may partially fill. Limit orders
use GTC or post-only ALO. The app also supports editing/canceling orders,
reduce-only full or partial closes, leverage/cross-isolated settings, isolated
margin adjustments and independent reduce-only stop-loss/take-profit triggers.
Protection orders are not an OCO pair. Sizes are exact decimal strings in the
base asset; USDC transfer amounts are decimal USDC. Metadata supplies asset IDs,
size precision and leverage parameters. Fee estimates and Max apply an observed
account referral discount to taker fees and positive maker fees; maker rebates
remain unchanged. Missing fee observations remain explicit in review.

The chart includes candlesticks, volume, timeframe selection and interactive
inspection. Price/book observations carry timestamps. Chart analysis names its
indicator windows, excludes unfinished candles, and reports missing data.
Orderbook analysis walks displayed liquidity and reports unfilled size. These
observations are descriptive estimates, not execution or prediction guarantees.

The compact header keeps browser trading access visible above the chart.
Sizing sliders and percentage/Max controls use current account-specific venue
capacity, configured leverage, fees and order prices; they round down to the
market's size precision. They do not change leverage or reserve liquidity.
Reduce-only sizing uses the remaining position. Transfer Max uses the gross
available native-USDC amount; the fee quote shows the net amount received.

Every effect uses the same resident implementation for UI and Agent. New trades
receive exact owner or Agent provider review. An Agent uses the existing
invocation-scoped Kernel approval callback; the app does not introduce Kernel
trading quotas or cooldowns.
Root-mode Agent calls carry their existing authority through nested Wallet
signing and funding calls, so setup and execution can finish without a tile
click. Normal-mode Agent effects require owner approval through the existing
provider review flow.

## Browser trading key

Setup asks EVM Wallet to approve a separate random Hyperliquid API wallet.
The private key is encrypted with a nonextractable WebCrypto AES key in the
installation's persistent background origin. It is never returned to a tile,
tool result, model or Motoko backend. Its authority comes from Hyperliquid:
it can trade collateral and cause losses, and the venue permits some internal
same-account actions; it cannot withdraw funds to another address.

The app uses the stable named slot `Neutron HL`. Approving a browser replaces
the previous key in that slot. Profile loss requires a fresh approval; there is
no server backup of this key. Expired/revoked keys are replaced with new random
keys. The app reads current registration and expiry and supports revocation.
The same-origin code that can use the encrypted key is trusted with trading.

The resident coordinates signing nonces across its same-origin browser windows.
Trading journals retain immutable intent, caller/wallet/environment binding,
client order IDs, signatures and exact dispatch envelopes before transmission.
Ordinary retries reconcile the original operation. Explicit retry can resend
only the same signed envelope after fresh review. A nonce rejection does not
prove the original request failed. Browser-profile loss can lose this local
intent history; venue positions, orders and recent fills remain queryable.

Activity offers **Continue saved trade** for owner-started trading actions whose
review or initial signed submission was interrupted. It reuses the original
operation ID and intent. Agent-owned operations remain with their original
caller and resume through the same tool and inputs.

Accepted venue orders remain active after Neutron closes. Agent strategies and
browser subscriptions run only while the authorized Neutron browser is open.

## USDC transfers

Ethereum and Arbitrum native USDC deposit through Circle CCTP V2 directly into
HyperCore's default-perps collateral route. The source Wallet reviews any exact
USDC approval and the burn-with-hook transaction. Circle forwards through
HyperEVM; the user does not need a separate Arbitrum hop for Ethereum deposits.
Source-chain ETH gas and current USDC forwarding fees are shown separately.
Before the first burn request reaches Wallet, the app refreshes the fee quote
and presents the resulting exact fee cap in Wallet review. A retained request
that has already reached Wallet keeps its original bytes through recovery.

Withdrawals use the Wallet's master `sendToEvmWithData` signature and Circle
forwarding to the same account on Ethereum or Arbitrum. The app reads current
onchain fees. For an account reporting ambiguous `default` abstraction, the
caller explicitly selects perps or unified USDC; the app does not guess or
change account mode. Testnet trading is separate; these funding routes are
mainnet-only.

Deposit quotes report `accountMode: null`: selecting the default-perps deposit
route does not observe or identify the account's balance mode. Withdrawal quotes
retain the mode actually returned by Hyperliquid.

Funding persists in managed `hyperliquid@1` memory, including original input,
caller, account fingerprint, exact Wallet requests and transfer evidence.
Continue the same operation ID after interruption. Approval alone, a source burn
or an API acknowledgement does not complete a transfer. Withdrawal completion
requires matching destination native-USDC mint evidence. Deposits separately
report CCTP forwarding into the Core deposit queue and observed HyperCore credit;
public ledger observations do not expose an exact EVM transaction-hash link.
HyperEVM's standard RPC can omit withdrawal system transactions and their
receipts. A withdrawal can therefore complete with an unknown source hash when
the canonical destination CCTP receipt proves its original owner, signed nonce,
amount, contracts and native-USDC mint. If historical RPC logs are unavailable,
the browser uses Blockscout's incoming native-USDC index only to locate candidate
hashes, then verifies each candidate against the destination RPC receipt. An
index entry or balance change alone cannot complete a withdrawal. The actual
CCTP fee and its difference from the quote remain visible; the withdrawal API
does not sign a fee cap. Read failures remain verification errors and never
authorize a replacement withdrawal.
If an unsettled withdrawal's source system receipt is unavailable and no
destination mint exists yet, automatic attestation discovery and manual mint
recovery still require locating its original source CCTP message. Keep that
operation pending and retain its signed nonce; a new withdrawal is not recovery.
Never repeat a burn merely because forwarding or the browser reply is delayed.
An interrupted Wallet preparation resumes its exact original request through
explicit continuation; status checks alone do not dispatch it.

Dismissing a transfer notice only hides its presentation. The original transfer
stays in Activity, and a late response does not reopen a dismissed notice. Once
the source burn is confirmed, Circle's attestation and forwarding run outside
the browser. If the tile or browser closes before a remaining Wallet approval
or withdrawal submission, reopen Activity and continue the same operation.
Network or forwarding-service delays can still postpone delivery; reopening
never substitutes a second burn for a pending transfer.

CCTP has no automatic source refund after a successful burn. Activity exposes
recovery for the original message: refresh an eligible Circle attestation or
complete the destination mint using Wallet. Inbound recovery invokes the
HyperEVM forwarder and requires HYPE gas; outbound recovery invokes the original
destination's message transmitter and requires ETH gas. The original recipient,
amount, hook and fee cap come from saved transfer evidence, not new tool inputs.
An already consumed message is reconciled instead of minted again.
If an unsigned destination recovery is still preparing when its attestation
expires, recovery can retain that attempt and use a refreshed attestation for
the original CCTP nonce. Signed or submitted outcomes must first be reconciled.

If forwarding settings change during a deposit and the confirmed transfer lands
in HyperCore USDC cash, recovery can move that original credited amount into the
same account's perps balance. This does not trade spot markets or change account
mode. A successful EVM forwarding queue with no observed Core credit requires
continued protocol investigation; submitting the mint again cannot replay a
CoreWriter action.

## Agent tools

All tools default to mainnet unless `environment: "testnet"` is supplied.
Effect tools take a lowercase 32-hex `operationId`; reuse it with the same
inputs when continuing. Complex read results use `dataJson`; effects use
`resultJson`. The descriptors contain closed input schemas and precise behavior.

| Tools | Purpose |
| --- | --- |
| `hl_markets_v1`, `hl_market_v1` | Discover and inspect current default perps |
| `hl_chart_v1`, `hl_orderbook_v1` | Analyze candles and executable displayed depth |
| `hl_account_v1`, `hl_fills_v1`, `hl_funding_rates_v1` | Positions, account mode, actual fees, executions and funding |
| `hl_preview_order_v1`, `hl_place_order_v1` | Preview and execute market/limit orders |
| `hl_order_capacity_v1` | Estimate available order size for the selected side and current account settings |
| `hl_close_position_v1` | Reduce-only partial/full closes |
| `hl_cancel_order_v1`, `hl_cancel_orders_v1`, `hl_modify_order_v1` | Manage working orders |
| `hl_protect_position_v1` | Independent reduce-only take-profit/stop-loss orders |
| `hl_leverage_v1`, `hl_isolated_margin_v1` | Market leverage and isolated collateral |
| `hl_setup_status_v1`, `hl_setup_v1` | Browser-key approval, status and revocation |
| `hl_funding_quote_v1`, `hl_funding_execute_v1` | Quote and complete native-USDC transfers |
| `hl_funding_capacity_v1` | Read available gross native USDC for deposit or withdrawal |
| `hl_funding_recover_v1` | Complete the original CCTP message or move a proven cash fallback into perps |
| `hl_activity_v1`, `hl_reconcile_v1`, `hl_retry_trade_v1` | Retained operations, evidence and exact-request recovery |

Read account state, market precision and relevant book/candle observations
before trading. Check returned per-order status and actual position after an
IOC close. Do not describe a partially filled, pending or ambiguous operation
as completed. Historical API limits are returned explicitly.

## Protocol references and dependencies

The integration follows the [Hyperliquid API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api),
[signing](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing),
[nonce and API-wallet rules](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets),
and [USDC integration guide](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/usdc).
CCTP calldata and receipt checks use Circle's
[Ethereum deposit guide](https://developers.circle.com/cctp/howtos/transfer-usdc-from-ethereum-to-hypercore),
[withdrawal guide](https://developers.circle.com/cctp/howtos/withdraw-usdc-from-hypercore-to-evm),
and [deployed HyperCore contracts](https://developers.circle.com/cctp/references/hypercore-contract-addresses).

Exchange signing uses `@nktkas/hyperliquid` **0.33.3**, checked against the
[official Python implementation](https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/2fdb18f9517675ea03695a0962bd19eece9c83f0/hyperliquid/utils/signing.py).
Viem **2.55.1** encodes EVM calls; decimal.js **10.6.0** supplies exact order
arithmetic. Candlesticks use TradingView Lightweight Charts **5.2.1**, retaining
its attribution. Dependencies keep their own licenses in generated package
notices; Neutron app code uses the shared `LICENSE.APP.USE` workflow.

## Qualification and release

```sh
npm --workspace neutron-hyperliquid run package
npm --workspace neutron-hyperliquid run test:release
npm --workspace neutron-hyperliquid run test:live
npm --workspace neutron-evm-wallet test
npx tsc -b apps/hyperliquid apps/evm_wallet --pretty false
npm run license:check
npm run security:check
```

Deterministic tests cover protocol vectors, exact amounts, caller review,
interrupted dispatch, key lifecycle and storage restoration. Browser tests use
the real UI and resident implementation with synthetic venue/Wallet evidence.
Live checks perform public reads only; they do not spend funds or submit orders.

The app introduces one managed memory root; existing Wallet memory versions
and released migration history remain unchanged. Use checked state-preserving
installation and the canonical [publication workflow](../../doc/package-updates.md).
The [implementation checklist](../../todo.hl.md) records completed evidence.
Publishing does not install into existing Neutrons or change the starter.
