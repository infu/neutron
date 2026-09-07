# EVM Wallet

EVM Wallet is a separate Neutron app for a chain-key Ethereum account. It is not
an extension of the IC Wallet app. The same `main` account works on Ethereum,
Arbitrum and the configured Ethereum test network; every request includes an
explicit chain ID. Network balances, gas and nonces stay separate.

The backend owns the account, selected assets, prepared requests, nonce
allocation, signed bytes and transaction history. The tile keeps only live form context; reload recovery comes from the backend
journal in Activity, including pending signatures and replacements. Ordinary
tiles need no persistent browser storage grant. Neither the tile nor consumer apps receive a private
key or a Kernel signing capability.

All EVM JSON-RPC calls use the browser's direct CORS connection to one PublicNode
endpoint per network. No MetaMask or API key is required. Balances, contract
reads, fees, simulation, broadcast and receipt checks do not pass through an IC
HTTP outcall. The backend preserves wallet state and performs chain-key signing.

## Using the wallet

- **Assets** shows native ETH and preloaded/selected ERC-20 balances at the returned block.
  This view is not exhaustive token discovery. A selected token's label is a
  display hint; its identity is the network and contract address.
- **Send** prepares an exact native transfer, selected ERC-20 transfer or contract
  call. Review shows the amount, network, recipient or spender, requesting app,
  and maximum network fee before confirmation. Calldata, nonce, simulation and
  other technical fields start collapsed. Supported Uniswap V3 and V4 router calls
  show the exact input amount and enforced minimum output from their calldata.
  V3/V4 position calls describe minting, adding, removing, collecting or closing,
  with position IDs, input maxima, output minima and recipients. Permit2 approvals
  show their exact token, spender, amount and expiry. Existing-position calldata
  that contains only an NFT ID labels token0/token1 amounts as atomic units; it
  does not invent token identities. Unrecognized call sequences keep the generic
  contract review with complete original bytes.
  Known ERC-20 selectors
  are decoded as hints, not proof of the called contract's behavior. Recognized
  `approve`, `transfer` and `transferFrom` calls show the observed token balance
  and applicable allowance, exact approval change, and observation block/time.
  Failed reads remain unavailable. Saved observations can be refreshed without
  changing the transaction's destination, value, calldata, nonce or gas fields.
- **Activity** includes requests from other apps, message signatures, pending
  outcomes and receipts. It is the Wallet's own journal, not a complete external
  transaction index. Load older pages when checking older requests.
- **Settings → Token approvals** lists spender/token pairs from successful confirmed Wallet
  transactions, including canonical speed-up replacements. Pending or reverted
  replacements do not establish an approval. Read the allowance at the returned
  block and request an exact zero approval to revoke it. External approvals and
  signed permits are not exhaustively indexed.
- **Settings → Sign message or data** supports EIP-191 personal messages and EIP-712 typed data. The review
  shows the complete original JSON, including integer lexemes beyond JavaScript's
  safe-number range. Signatures can authorize actions outside this Wallet.
- **Settings** includes custom tokens, advanced tools and account details.

Balances and history update while the tile is visible and when it regains focus.
Secondary actions use compact icon buttons with accessible labels and tooltips.
The shared [token catalog](./TOKENS.md) supplies verified network-specific
defaults and bundled artwork without modifying existing saved tokens.

Tile actions use explicit buttons and validated keyboard handlers because the
Kernel sandbox does not permit native form submission. Enter in a single-line
field activates its review/save action; Enter in message and calldata textareas
continues editing. Required-field validation is preserved before these actions.

Arbitrum gas estimates include its posting-cost component; the Wallet does not
add a second arbitrary posting fee. A receipt records canonical inclusion and
observed safe/finalized evidence. Arbitrum inclusion alone does not imply final
Ethereum settlement. EVM transactions need native gas on their EVM network;
chain-key signing and durable wallet updates consume this Neutron's IC cycles.
Direct browser RPC calls do not incur IC outcall cycles.

## Review, recovery and replacements

Other apps call the resident service. Effects marked `provider_once` open this
Wallet's private foreground review tool for ordinary users. In Agent mode, the
same public tools prepare the exact transaction or signature and request a fresh
Kernel permission decision from the active root Agent. Its review includes the
signing account, network, complete transaction or signature payload, nonce, fees,
simulation and available token observations. The amount and parties use the same
calldata-derived presentation as the owner dialog. The Kernel binds this one-use
approval callback to the authenticated provider invocation; an Agent-mode flag
alone never authorizes execution. Installation tool grants connect consumer apps
without replacing this fresh effect review.

The Kernel supplies the authenticated caller app and installation UID. Nested
requests stay owned by that consumer installation. A separate root-agent tool
family retains the same backend preparation and execution path and requires
Kernel root-agent attestation. A nested app invocation does not acquire root
authority. Denial or cancellation before execution leaves an unsigned request
available for the same-ID retry; already submitted requests return their saved
outcome without another approval.

Requests are identified by caller app, caller installation and a 16-byte request
ID written as 32 lowercase hexadecimal characters. Identical replay resolves the
saved request; changed intent conflicts. A new tile endpoint can recover the
same request within the same installation.

Prepared operations require their current review revision. If another request
reserves their proposed nonce first, the Wallet returns a revised review and
asks for approval again after estimating and simulating the new candidate.
It does not silently sign the changed transaction. Send shows preparation
progress immediately, including the token amount and recipient, then displays
the exact transaction and an explicit approval button.
An Agent provider call returns `prepared` when its reviewed candidate changes;
the consumer must call again with the same request ID to obtain a fresh decision.
The previous approval cannot be reused for the changed candidate.
Explicit token-observation refresh also advances the review revision so an
approval for an older view cannot race the refreshed view. Its observations are
saved separately from the transaction and can become stale as the chain changes.
Older saved operations have no token observations until explicitly refreshed.

An uncertain signing outcome is retained and never automatically signed again.
Signed transaction bytes and their hash are saved before broadcast. Checking a
pending operation updates its journal and may rebroadcast only the exact
already-approved signed bytes when the transaction is absent. Recovery does not
create a fresh transfer and does not rebroadcast a superseded original. Receipt loss/reorgs remain visible as unresolved state rather
than fabricated confirmation.

Pending activity offers explicit speed-up/cancel requests using the original
nonce. The review includes the resolved replacement recipient, value and
calldata. A cancellation is a zero-value self-transfer and can lose the race to
the original. An original marked `replaced` is not a completed transfer: the
replacement hash is shown separately.

## Account lifecycle and authority

The manifest requests one `wallet_custody_signing` slot, `main`, using
`ecdsa_secp256k1`. This grants the installed app authority to request the scoped
public key and sign exact 32-byte digests. It is stronger authority than the
existing assertion-signing grant: the Kernel does not interpret ERC-20
approvals, swap calldata or EIP-712 permits. Wallet code owns that review.

The Kernel's existing installation namespace reserves the key while the app is
installed. Another app using the slot name `main` receives a different key.
Compatible upgrades preserve the installation namespace, slot and address.
Disabling the capability prevents signing; reenabling the same installed slot
restores its use. Removing the app and reinstalling creates a new namespace and
address. Removing the slot loses its active handle; a replacement app cannot
claim the old handle. There is no independent post-uninstall reservation or
owner reassignment registry in this release.

Keep EVM Wallet installed while the address has funds, approvals or outstanding
signatures. There is no seed/private-key export. Restoring durable state in the
same Neutron must preserve the Kernel installation identity and Wallet memory;
a different Neutron canister has a different derivation scope. Copying a frontend
draft is not account recovery.

## Consumer tools

Use the shared `neutron-tools/evm_wallet` client and closed schemas. Read-only
methods cover accounts, networks, requested balances, contract calls and public
transaction evidence. `evm_call_contract_v1` reads return bytes at latest or an
explicit block without downloading contract bytecode; the existing
`evm_read_contract_v1` retains its code-inclusive result for consumers that need
it. `evm_estimate_transaction_v1` estimates fees for exact
transaction fields without creating a command, reserving a nonce or signing.
It returns its pricing basis, partial facts and unavailable reasons; its estimate
is not spending authorization. Arbitrum total gas already includes posting cost.

`evm_replacement_transaction_v1` checks whether a signed hash belongs to an
explicit replacement of an exact original request. This journal proof is
separate from chain evidence: consumers must also verify the replacement's
transaction fields and successful canonical receipt.

Operation status is a reconciliation tool marked read,
write and network because it can update the journal and rebroadcast already
approved signed bytes. Transaction evidence can verify that a
public hash belongs to an exact saved Wallet request without revealing private
messages or signatures.

Public effect tools are `evm_send_transaction_v1`, `evm_sign_message_v1`,
`evm_sign_typed_data_v1` and `evm_replace_transaction_v1`. They support both owner
dialogs and nested Agent review. Their `_root_v1`
counterparts are available only to the active root Agent. Consumer apps persist
complete intent and the expected Wallet identity before invoking them. Do not
replace a saved request ID after a timeout.

Kitchen Sink's EVM Wallet page demonstrates the consumer protocol. IC Wallet
uses it to prepare Ethereum bridge transactions; only the supported Ethereum
mainnet helper accepts those ck-token deposits. Uniswap owns quote/swap intent
and requests Wallet approval/signing through this protocol.

## Build and release

From the repository root:

```sh
npm --workspace neutron-evm-wallet run package
npm --workspace neutron-evm-wallet test
```

Release 106 retains the published `evm_wallet` version-1 root unchanged and adds
the independent `evm_evidence` version-1 root for token observations. An upgrade
keeps the existing account, requests, signed bytes and nonce state and initializes
the new root; no fake migration changes the original schema. Existing version-1
self-call inputs and closed output shapes are unchanged; review evidence uses
a new private endpoint.

The release suite includes an actual browser iframe with `sandbox="allow-scripts"`
and no `allow-forms` permission. It verifies Sign, Send, replacement and token
editing actions, field validation, keyboard behavior and duplicate prevention.
Own Wallet requests travel through the resident service back to their originating
tile's private review handler. This same-app route checks the Kernel-authenticated
tile and resident identities and does not accept Agent invocations. Cross-app
requests use the Kernel's foreground provider presentation for ordinary users
and its one-use Agent approval callback for Agent invocations. These paths use the
same durable prepare, review and execution flow; repeating a request ID returns
its saved outcome.
The former EVM RPC canister adapter remains historical test material. Current
app paths use the direct browser RPC client and no backend outcall capability.
Direct observations are provided by one server, not replica/provider consensus.
History reads retry existing aggregate response-size failures with smaller pages
at the same offset. Initial loading and Load more share this path; no operations
are discarded or capped. Unrelated errors and a single operation that cannot fit
remain explicit errors. The regression fixture preserves the actual 25-operation
Candid reply that exceeded the existing metadata limit during local qualification.

Review clean initialization and state retention tests together with backend crypto,
RPC, command recovery, provider and browser tests. Preserve the published schema
and lock lineage after release. Installation and publication follow
[`doc/package-updates.md`](../../doc/package-updates.md) and
[`doc/memory-migrations-and-uninstall.md`](../../doc/memory-migrations-and-uninstall.md).
The production update source is `233tv-xiaaa-aaaay-aacta-cai`.

## USD estimates

Balances, tracked token totals, send amounts and transaction fees show secondary
USD estimates. Prices come directly from the browser to DefiLlama's keyless
`coins.llama.fi` API ([official client](https://github.com/DefiLlama/api-sdk/blob/master/src/client.ts),
[price endpoint](https://github.com/DefiLlama/api-sdk/blob/master/src/modules/prices.ts)).
The resident service shares one volatile cache across Wallet, Uniswap and agents;
it batches contract IDs and reuses observations for about 60 seconds. It sends
only public asset identifiers, never an account address. No canister HTTP outcall,
new persistent root or Kernel change is involved.

UI requests run once a minute while the app document is visible and focused,
waking on focus. Inactive workspace tiles stay mounted, so page visibility alone
is insufficient. Closing or leaving the app stops its price polling. Agent
requests refresh on demand and do not start a background timer.

Agents use `evm_wallet_prices_v1({ assets: [{ chainId: "1", address: null }] })`,
or SDK `client.prices(...)`. Each row carries the unit USD price, provider
observation and fetch timestamps, status, source ID and any error. Atomic amounts
retain their token decimals. The existing balance and transaction tool contracts
are unchanged. Prices are optional display information, never transaction inputs
or swap quotes; unavailable prices do not block financial actions.

Native ETH and canonical WETH share the ETH price. Every other asset uses its
exact chain/contract price, including stablecoins and wstETH. A refresh does not
guarantee a new market observation: older observations remain explicitly stale,
with source/time in tooltips. Missing values show `—`; a partial portfolio total
is labeled as containing only priced tokens. Failed refreshes keep the previous
value with stale status and retry on the next active minute.

This app uses the shared `LICENSE.APP.USE` packaging workflow. Source is offered
for inspection under those exact terms; see `NOTICE` and the packaged legal
metadata.
