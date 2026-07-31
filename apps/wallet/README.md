# Wallet

Wallet tracks ICRC ledgers, balances, transfers, and per-network deposit routes
owned by the Neutron canister principal. Ledger calls use owner-approved
`backend_calls` capabilities injected by the kernel; the app never constructs a
backend actor directly.

The ledger picker offers both reviewed presets and an **Add custom ledger**
action. A custom canister id is parsed and canonicalized as an IC principal
before it can be selected. Applying the selection asks the owner for the four
exact ICRC-1 methods Wallet uses—metadata, balance, fee, and transfer—plus
`icrc3_get_blocks` for its index-less Activity fallback.
Principal validation checks the id itself; metadata refresh reports an error if
the target does not implement the required ICRC-1 interface.
Custom ledgers are Internet Computer routes only; they do not inherit a native
minter, USD price mapping, or reviewed history index from the preset catalog.
Wallet supports up to 16 selected ledgers and retains at most 64 historical
custom ledger records. A deselected custom ledger without activity is reclaimed;
one with locally recorded transfers stays available to Activity history.

Fresh installs activate ICP, ckBTC, and ckUSDC. Their reviewed ledger, index,
minter, and ckETH gas-helper reservations are accepted with the app installation;
changing the picker later still uses the same runtime permission flow. An
existing configured wallet keeps its current selection during an update.

Wallet's tray popout mounts the same `WalletApp` component, state model, inner
pages, actions, and styles as the Wallet tile. Assets, Activity, Receive, Send,
transfer confirmation, and the searchable ledger setup page therefore do not
have a second tray-only implementation that can drift. The tile and popout are
separate sandboxed iframes, so each has its own short-lived React instance and
performs a fresh snapshot/catalog read when mounted; app-state invalidations
refresh the visible balances and Activity data in either instance.

Normal preapproved refreshes and user-confirmed sends work directly in the
popout. Three focused-tile platform capabilities cannot run from a tray iframe:
changing backend reservations, writing to the clipboard, and connecting an
Ethereum provider. Only those controls hand off to the exact Wallet inner page;
the setup page uses an explicit **Open Wallet** action, copy affordances use an
open icon instead of pretending to copy, and Ethereum deposit entry starts only
after the handoff so no draft is discarded. Escape dismisses the popout.

The non-persistent resident exposes two agent-visible tools: `wallet_overview` reads the
bounded wallet projection, while `wallet_refresh` refreshes selected ledger
balances and returns that same projection. Both use closed schemas and preserve
`Nat`/`Int` values as decimal strings. Wallet intentionally publishes no tray
badge: it has no unread cursor, and balance errors are not unread items.

Assets show an indicative USD position value and portfolio total using the
native asset behind each reviewed ledger (`ckBTC` uses BTC, `ckETH` uses ETH,
and so on). Wallet frontends request one keyless CoinGecko batch every minute,
fall back to Kraken spot tickers and then Coinbase exchange rates, and keep the
last validated quote book in frontend memory. Browser storage is used as an
optional cache only when the embedding context exposes it; opaque-origin
Neutron tiles continue without it. These are direct frontend requests: no
price enters Wallet memory or transaction logic, and providers receive only
public asset symbols, never balances, principals, account addresses, or ledger
identifiers.

Reviewed preset ledger principals are reserved as whole canisters. Custom
ledgers and chain-key minters use exact method reservations; the latter cover
address discovery, deposit refresh, gas quotes, and withdrawal. Permanent ckBTC
and ckDOGE addresses are cached in Wallet memory.
While a Wallet tile is open, supported minters are checked immediately and
every ten minutes; ckETH and ckERC20 balances are refreshed on the same interval
after their minter's own helper-contract scraper runs.

The Bitcoin and Dogecoin deposit pages expose an explicit refresh action and
show the minter's UTXO state. Concurrent deposits remain separate by transaction
id and output index, with their own amount, confirmation count, required count,
and progress meter. Checked, suspended, rejected, and recently minted outputs
are shown independently; the backend bounds retained status and minted history.

Ethereum deposits use the current helper contract and supported ERC-20 address
reported by the ckETH minter. The browser-wallet action is user initiated and
requires Ethereum Mainnet. Before requesting a transaction, Wallet verifies provider-side
contract bytecode and checks that the helper's `getMinterAddress()` matches the
minter-reported address. Current helpers use `depositEth` / `depositErc20` and
legacy default-account helpers use their verified `deposit` ABI. ckERC20 resets any
different prior helper allowance, approves exactly the entered amount, verifies
that allowance, and calls `depositErc20`. The injected provider and connected
account remain in the top-level kernel broker and are never exposed directly to
the opaque Wallet iframe. Wallet receives only a short-lived, endpoint-bound
EIP-1193 request proxy and does not persist it. After the Ethereum
transaction confirms, Wallet polls its canister balance while the minter credits
the corresponding ckToken.

Wallet keeps durable Activity history in its v1 app memory. Every preset ledger
has a permanent companion index principal in the catalog. Activity sync first
refreshes all enabled balances in one batch. A ledger whose balance still equals
its checkpoint is finished without calling its index or block log. When a balance
changed, Wallet trusts the pinned index mapping and reads only that account's
transactions; it does not repeatedly verify the index identity, index progress,
or global ledger tip. The account query supplies one atomic balance and newest
transaction boundary, and a lagging index leaves the checkpoint untouched for a
later retry.

Custom ledgers have no pinned index, so changed balances use a bounded ICRC-3
scan of the captured live ledger window and filter blocks for Wallet's default
account. The fallback never follows an archive callback outside the approved
ledger canister: if the required range was archived, Wallet reports that an
index is required and preserves the old checkpoint.

Successful sends, native burns, gas burns, and known deposit mints are recorded
immediately by `(ledger, block index)` and later enriched in place. A kernel
scheduled task reconciles enabled ledgers every 12 hours even when the tile is
closed. First sync establishes a bounded opening balance instead of scanning
genesis. Later indexed scans page only the canister's default account and preserve
exact `Nat`/`Int` values. Direct ledger scans commit only a complete range whose
effects explain the observed balance; races and archived ranges retry without
advancing the checkpoint. Because balance equality is the gate, net-zero account
activity is deferred until a later balance change causes that checkpoint window
to be scanned. Disabling a token hides it from Assets and stops sync without
erasing its retained history. Settings can disable the Wallet task globally, and
Activity exposes a manual refresh plus source errors.

IC destinations use `icrc1_transfer`. Bitcoin, Dogecoin, Ethereum, ERC-20, and
Solana destinations use the token's official approve-then-withdraw flow: Wallet
creates a ten-minute ICRC-2 allowance for the minter and calls its native
withdrawal method. ckERC20 withdrawals also quote gas and create a separate
short-lived ckETH allowance. Contact revisions and exact destination values are
revalidated after every inter-canister await and all Wallet sends are serialized
to prevent shared minter allowances from racing.

```sh
npm --workspace neutron-wallet test
```
