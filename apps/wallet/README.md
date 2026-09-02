# Wallet

Wallet tracks ICRC ledgers, balances, transfers, and per-network deposit routes
owned by the Neutron canister principal. Ledger calls use owner-approved
`backend_calls` capabilities injected by the kernel; the app never constructs a
backend actor directly.

Wallet is also the owner's trusted token-transaction provider for other
Neutron apps. Kernel authenticates the requesting and Wallet endpoints and
opens or focuses Wallet's exact tile, but it forwards only opaque presentation
data and does not render or interpret token decisions. Wallet reads the ledger,
formats symbols, decimals, fees, recipients, spenders, and allowances, renders
the one approval modal, and uses only exact preapproved backend methods. Those
methods may prepare review state or persist rejection; only acceptance may
dispatch value-moving execution. This is an operational Wallet for
owner-trusted apps and live agents, not a cold-storage boundary against the
installed Wallet package. Installing or updating Wallet is therefore a
consequential trust decision.

## App Funding Contract

The resident keeps the versioned `wallet_fund_v1` tool at the exact
`app:wallet:background` endpoint, so apps written against the existing public
contract remain compatible. A caller supplies a bounded request id, ledger
principal, base-unit amount, freshness deadline, and one closed route:

- `direct` names an exact ICRC account which receives an `icrc1_transfer`;
- `allowance` names an exact spender account and short expiration for an
  `icrc2_approve`, after which the Swap service may call
  `icrc2_transfer_from`.

The allowance funding route is ICRC-2 only. The reviewed ICP ledger can still
use direct ICRC-1 funding, and Approvals can list and revoke its separate legacy
approvals, but this first contract does not create a new legacy ICP approval
for a Swap.

The tool is annotated with `{"neutron:consent":"provider_once"}`. Kernel
requires an ordinary human request to start from the focused calling tile with
transient user activation and validates its JSON before dispatch. The Wallet
background validates the request and feature-detects the invocation-scoped
`context.presentUserInterface()` callback before preparing or changing any
command. Kernel then opens, reuses, and focuses Wallet's `wallet` tile and
routes the opaque request only to Wallet's private
`wallet_funding_present_v1` tool. That tool is annotated with
`"neutron:visibility":"same_app"` and
`"neutron:audience":"foreground_tile"`; it checks Kernel's audience
attestation, reads authoritative ledger metadata, decimals, current fees, and
allowance state, freezes the command, and renders Wallet's modal.

The owner makes one decision in Wallet. The primary action executes the frozen
command through Wallet's exact preapproved self call; Cancel records a definite
rejection without a ledger call. Kernel displays no approval dialog and never
interprets token semantics. The presentation capability is bound to the
original caller, provider, and originating live public handler call and can be
consumed only once. A calling app cannot invoke the private tile tool directly,
and exact or wildcard tool session grants cannot replace this decision.

The funding descriptor uses metadata-only Kernel audit projection. Kernel keeps
bounded caller/provider/tool/outcome facts rather than financial arguments or
review contents; Wallet's durable command record and Activity/Approvals views
own transaction-specific reconciliation and history.

The review for a direct route states the exact raw and formatted token amount,
ledger fee, maximum debit, destination, optional memo, command id, and
freshness deadline. An allowance review separately states the amount the
spender intends to pull, transfer-from fee, current-to-replacement absolute
allowance and expiration, approval fee, maximum source-account debit, exact
spender account, command id, and freshness deadline. The normal replacement
allowance is the requested pull amount plus the ledger's current transfer-from
fee; the approval fee is a separate immediate debit. An ICRC-2
allowance is not a one-use transfer: the spender may make multiple pulls and
choose destinations while allowance remains. Swap owns quote validation,
minimum output, its DEX reservation, and post-funding execution; Wallet never
accepts an arbitrary canister method or DEX call.

An exact amount and short expiration bound, but do not eliminate, spender risk.
A DEX canister may be upgraded at the same principal after review and its new
code can spend within the remaining allowance; reviewing the Swap app does not
attest that mutable external code. Where a trustworthy attestation is
available, Wallet or Swap may optionally pin a reviewed module hash and fail on
drift. That is provider/consumer-app hardening, not Kernel or token semantics.

If the installed Swap backend performs `icrc2_transfer_from` itself, every app
backend still shares the Neutron canister principal. The ledger sees that
principal and the Swap-supplied `spender_subaccount` and arguments; it cannot
attest which compiled app module initiated the call. The reviewed, narrowly
hard-coded Swap backend and its exact ledger-method reservation are therefore
the app boundary. An allowance is not cryptographic per-app sandboxing, and
Kernel does not add token-specific interpretation to simulate one.

Wallet rejects its own default source account as spender, treating an absent
(`null`) subaccount and the all-zero subaccount as equivalent. Direct-calling
Swap apps and fixtures must use a distinct exact spender subaccount because
ICRC-2 same-account `transfer_from` is not allowance-bounded.

Before first dispatch, Wallet rechecks review-sensitive metadata, fee,
freshness, and current allowance state. A change rejects that prepared command
and requires a fresh request and review; Wallet never silently increases the
reviewed fee, debit, or allowance.

Agent automation uses a separate `wallet_fund_root_v1` tool with the same
closed input and output schemas. Its descriptor combines
`"neutron:visibility":"same_app"` with
`"neutron:audience":"agent_root"`. Kernel shows and routes it only to the
incoming live depth-zero Agent root, and Wallet verifies the audience before it
uses the same prepare and execute helpers. That path has no Wallet or Kernel
approval UI. Human callers and nested Swap-to-Wallet agent calls are rejected
before target dispatch; they cannot turn the root-only tool into delegated
authority. The invocation and cancellation remain bound through
`context.kernel.updateSelf()`. This is live root authority, not unattended
background authority: the current root turn still begins from the enabled
exact agent's focused tile with transient user activation.

Published Wallet 0.3.6 used the now-deprecated scoped
`context.requestApproval()` callback. Kernel retains that generic compatibility
member and its raw JSON dialog; published Wallet 0.3.6 depends on it, but the
runtime does not version-gate it. Current Wallet code requires
`context.presentUserInterface()` before preparation and never falls back to the
legacy callback or an ordinary reusable tool grant. Wallet features unrelated
to provider funding and direct-root routing are required to remain usable in
every partial-upgrade combination.

The compatibility contract for the pending K325/W308 successors, together with
the released K323/K324/W306/W307 lanes, is the exact matrix in
[App Method Access And Call Consent](../../doc/app-method-access-and-call-consent.md#provider-mediated-one-shot-tools).
It distinguishes human presentation from root-tool availability, including the
K324/W308 lane where human funding fails closed but direct-root funding works.
Final pending-successor cells remain subject to qualification against the exact
candidate archives. At the source-contract level, existing callers need no
migration: W308 retains the endpoint, schemas, provider annotation, and caller
semantics of `wallet_fund_v1`. Existing custom ledger state is required to
remain usable; allowance features require the additional exact scopes described
below.

The ledger picker offers both reviewed presets and an **Add custom ledger**
action. A custom canister id is parsed and canonicalized as an IC principal
before it can be selected. Applying the selection asks the owner for the four
exact ICRC-1 methods Wallet uses—metadata, balance, fee, and transfer—plus
`icrc3_get_blocks` for its index-less Activity fallback. Allowance features
add only the exact `icrc2_allowance`, `icrc2_approve`, and
`icrc103_get_allowances` scopes. Existing custom-ledger installations do not
receive those scopes automatically: Approvals and cross-app allowance funding
show **permission required** until the owner applies the additional reservation
batch in Wallet settings.

Principal validation checks the id itself; metadata refresh reports an error if
the target does not implement the required ICRC-1 interface.
Custom ledgers are Internet Computer routes only; they do not inherit a native
minter, USD price mapping, or reviewed history index from the preset catalog.
Wallet supports up to 16 selected ledgers and retains at most 64 historical
custom ledger records. A deselected custom ledger without activity is reclaimed;
one with locally recorded transfers stays available to Activity history. If a
custom ledger does not provide the complete ICRC-103 listing route, Wallet
shows the approval view as degraded or incomplete rather than presenting a
history-derived list as complete. The distinct legacy ICP approval adapter is
selected only for the reviewed ICP ledger; matching method names on an
arbitrary custom ledger do not make it an ICP ledger.

Fresh installs activate ICP, ckBTC, and ckUSDC. Their reviewed ledger, index,
minter, and ckETH gas-helper reservations are accepted with the app installation;
changing the picker later still uses the same runtime permission flow. An
existing configured wallet keeps its current selection during an update.

Wallet's tray popout mounts the same `WalletApp` component, state model, inner
pages, actions, and styles as the Wallet tile. Assets, Activity, Approvals,
Receive, Send, transfer confirmation and revoke actions, and the searchable ledger
setup page therefore do not have a second tray-only implementation that can
drift. The tile and popout are separate sandboxed iframes, so each has its own
short-lived React instance and performs a fresh snapshot/catalog read when
mounted; app-state invalidations refresh the visible balances, Activity, and
Approvals data in either instance.

Normal preapproved refreshes, user-confirmed sends, and approval revocations
work directly in the popout. Three focused-tile platform capabilities cannot
run from a tray iframe:

changing backend reservations, writing to the clipboard, and connecting an
Ethereum provider. Only those controls hand off to the exact Wallet inner page;
the setup page uses an explicit **Open Wallet** action, copy affordances use an
open icon instead of pretending to copy, and Ethereum deposit entry starts only
after the handoff so no draft is discarded. Escape dismisses the popout.

The non-persistent resident exposes three public tools:
`wallet_overview` reads the bounded wallet projection, `wallet_refresh`
refreshes selected ledger balances and returns that same projection, and
`wallet_fund_v1` performs the human funding flow above. It also declares the
private, direct-root-only `wallet_fund_root_v1` automation tool. All use closed
schemas and preserve `Nat`/`Int` values as decimal strings. Wallet intentionally
publishes no tray badge: it has no unread cursor, and balance errors are not
unread items.

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

## Approvals

Approvals lists live outstanding approvals only for selected ledgers for which
Wallet has the required backend-call access. ICRC ledgers use the draft,
paginated `icrc103_get_allowances` query and retain only entries whose source is
the Wallet's exact default account. The adapter treats a missing and all-zero
subaccount as that same default account, advances with both the last
`from_account` and `to_spender`, stops when ordering moves to another
Wallet-owned subaccount, requires strict cursor progress, and bounds pages,
entries, reply bytes, accounts, and expirations. ICP uses its
existing paginated `get_allowances` and `remove_approval` API instead.

For a standard ICRC-2 approval, **Revoke** prepares
`icrc2_approve(amount = 0, expected_allowance = displayed current)` and then
refreshes the authoritative list. `AllowanceChanged` causes a refresh, not an
unconditional retry. ICP has no equivalent CAS/idempotency timestamp, so an
unknown removal outcome is reconciled by listing again before Wallet decides
whether another request is safe. Each row shows the ledger and symbol,
formatted remaining allowance, exact spender ICRC account or ICP account
identifier, expiration, and revoke fee.

The **Revoke** button is the Wallet's trusted UI decision. Its prepared command
and execution use exact preapproved self calls, so revocation does not add a
second generic Kernel backend-call dialog.

ICRC-103 is an allowance-enumeration protocol, not the ICRC-2 single-spender
query. A ledger which implements only `icrc2_allowance` cannot reveal unknown
spenders, so Wallet does not claim a locally reconstructed subset is “all
approvals.” Nor can Wallet discover approvals on arbitrary ledgers which the
owner never selected.

Response bounds, account filtering, and cursor checks validate an enumeration's
shape, not the selected ledger's honesty. A malicious ledger can omit or invent
allowance rows or implement spending inconsistently, so this screen reports the
ledger's bounded claims rather than a cryptographic proof of completeness.

Cross-app funding and revocation use a separate bounded `wallet_commands` v1
managed-memory root. The released `wallet` v1 Activity/configuration root stays
unchanged. Commands are keyed by immediate caller app and request id, freeze
the exact ledger arguments and `created_at_time` before value-moving awaits,
and distinguish prepared, pending, succeeded, and definitely rejected states.
An identical replay loads the same command; a reused key with a different
intent is rejected. A terminal command returns its durable result, while a
pending command enters protocol-safe reconciliation through the same execute
key. Wallet reuses only frozen arguments where safe and never rebuilds an
ambiguous outcome as a fresh transaction. Replaying a terminal receipt does
not dispatch another financial operation or require another decision; a fresh
request id requires a fresh Wallet decision on the human path or a fresh
direct-root invocation.

IC destinations use `icrc1_transfer`. Bitcoin, Dogecoin, Ethereum, ERC-20, and
Solana destinations use the token's official approve-then-withdraw flow: Wallet
creates a ten-minute ICRC-2 allowance for the minter and calls its native
withdrawal method. ckERC20 withdrawals also quote gas and create a separate
short-lived ckETH allowance. Contact revisions and exact destination values are
revalidated after every inter-canister await and all Wallet sends are serialized
to prevent shared minter allowances from racing.

The existing contact-bound `wallet_transfer` method keeps its released
signature and semantics but is now an exact preapproved self update. The
Wallet's own Send/Withdraw confirmation is therefore the single user decision;
there is no second generic backend-call dialog. Cross-app direct and allowance
funding use separate versioned prepare/execute methods and share the same
internal transfer, approval, fee, history, and reply-decoding helpers rather
than copying the send implementation.

```sh
npm --workspace neutron-wallet test
```
