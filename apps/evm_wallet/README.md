# EVM Wallet

EVM Wallet is a separate Neutron app for a chain-key Ethereum account. It is not
an extension of the IC Wallet app. The same `main` account works on Ethereum,
Arbitrum, HyperEVM and the configured Ethereum test network; every request includes an
explicit chain ID. Network balances, gas and nonces stay separate.

The backend owns the account, selected assets, prepared requests, nonce
allocation, signed bytes and transaction history. The tile keeps only live form context; reload recovery comes from the backend
journal in Activity, including pending signatures and replacements. Ordinary
tiles need no persistent browser storage grant. Neither the tile nor consumer apps receive a private
key or a Kernel signing capability.

All EVM JSON-RPC calls use the browser's direct CORS connection to one public
endpoint per network: PublicNode for Ethereum/Arbitrum and dRPC for HyperEVM.
No MetaMask or API key is required. Balances, contract
reads, fees, simulation, broadcast and receipt checks do not pass through an IC
HTTP outcall. The backend preserves wallet state and performs chain-key signing.

## Using the wallet

- **Assets** shows the network's native gas token (ETH or HYPE) and preloaded/selected ERC-20 balances at the returned block.
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
  V3 collections through the NFT manager show that collection destination and
  each forwarded asset's exact minimum separately; they do not assume those
  assets include every token collected from the position.
  Collection is labeled **Collect available amounts**: V3 proceeds can include
  previously withdrawn principal as well as fees, so the review does not label
  the entire payout as income.
  Curve Router calls on Ethereum and Arbitrum show the exact payment, minimum
  received and recipient, plus the absence of an onchain expiry. Compatible pool
  liquidity interfaces show indexed token budgets, LP burns, output minima and
  the receiver from calldata; interface recognition does not assert factory
  membership. These same details reach Agent review. The existing Wallet and
  evidence roots retain their released v1 schemas. See Account lifecycle and
  authority below for signing identity and upgrade requirements.
  Aave V3 Ethereum Core and Arbitrum Pool and Rewards Controller calls show
  supply, withdrawal, variable borrowing and repayment, repayment with supplied
  aTokens, collateral settings, efficiency-mode category IDs and reward claims.
  Reviews distinguish the token recipient from the debt owner and explain
  whole-position amount sentinels. Current immutable WETH Gateway calls show
  native supply, withdrawal, borrowing and repayment, with exact ETH payment
  budgets and refund recipients. aWETH approvals show exact supplied-token limits.
  WETH variable-debt-token delegations show the
  borrowing limit, delegatee and responsibility for the resulting debt.
  Recognition requires the exact network,
  deployed contract and canonical calldata; unsupported calls retain generic
  review. The same presentation reaches owner and Agent review, with every
  asset address, amount, beneficiary and original byte available for inspection.
  Known ERC-20 selectors
  are decoded as hints, not proof of the called contract's behavior. Recognized
  `approve`, `transfer` and `transferFrom` calls show the observed token balance
  and applicable allowance, exact approval change, and observation block/time.
  Failed reads remain unavailable. Saved observations can be refreshed without
  changing the transaction's destination, value, calldata, nonce or gas fields.
- **Activity** includes requests from other apps, message signatures, pending
  outcomes and receipts. It is the Wallet's own journal, not a complete external
  transaction index. Amounts, recipients, protocol explanations and signature
  previews remain readable; Details retains original calldata and decoder
  provenance. Matching older transactions benefit from the same decoders as new
  reviews. Refresh reloads the complete visible history window, including older
  statuses; loading more reads a contiguous window even when new requests arrive.
  Load older pages when checking older requests.
- **Settings → Transaction explanations** imports versioned JSON definitions for
  additional protocols. Preview their exact networks, contracts and functions
  before saving; disable, replace or remove them at any time. Imported labels
  carry their origin and do not constitute contract verification. See the
  [decoder authoring and architecture guide](./src/decoders/README.md).
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

Automatic transaction limits include 20% gas headroom, rounded up, when the
estimate exceeds 21,000 gas. The Wallet simulates that exact limit and includes
it in the reviewed maximum fee before signing; ordinary 21,000-gas transfers
remain exact. Explicit caller gas limits are never increased. Read-only fee
estimates use the same calculation so Max and protocol previews reserve the
same gas budget. Headroom reduces estimate-related failures but cannot ensure
that later contract state will still permit execution.

Gas-estimation and simulation failures retain the original unsigned operation,
review revision, failure stage, observation block and provider diagnostic. They
return `preparing` with a message that no signing occurred. An explicit retry
uses the same request ID; completing preparation clears the old error. Late
diagnostics cannot overwrite a newer review or a signed operation.

`evm_balances_v1` reads optional `decimals()` and `symbol()` for requested tokens
outside the saved asset list at the same block as their balances. Missing
metadata never discards a successful `balanceAtoms`; the existing `error` field
identifies each unavailable `balanceOf`, `decimals` or `symbol` observation.
Labels remain display hints and are not added to the saved asset list.

`evm_transaction_v1` accepts `includeGasLimit: true` to return the submitted
transaction's exact `gasLimit` alongside the receipt's actual `gasUsed`. Omit
this option when calling older installed providers whose input schema does not
advertise it. Requests without the option retain the original response shape;
updated consumers also accept older responses without gas evidence. Neither a
high gas usage nor a failed receipt by itself establishes the revert reason.

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
If an unsigned preparation was interrupted before its simulation completed,
retrying the same request refreshes automatically chosen fees from the current
head and invalidates the earlier simulation revision. Explicit fee settings and
already prepared or signed transactions retain their exact reviewed fields.
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

Kernel 0.3.46 (release 346) always derives custody namespace v2 from this
Neutron canister, app ID `evm_wallet`, slot `main`, algorithm and trusted key
name. Installation UID and Kernel installation epoch are not inputs. Another
app ID receives a different key even if its slot is also named `main`.

Upgrading from Kernel 0.3.44 requires a fresh account. **Fully uninstall EVM
Wallet while still on 0.3.44; then install Kernel 0.3.46 and reinstall EVM Wallet
0.1.19.** These are separate
completed install transactions. Do not keep the old Wallet installed during
this cutover: its cached address and journals belong to a different key. The
new installation starts with blank Wallet memory and a new address. This
abandons supported signing access to the old account; its on-chain balances,
approvals and protocol positions remain at the old address and do not move.

After that fresh start, compatible upgrades and reinstalling EVM Wallet in the
same Neutron recover the same namespace-v2 account when you grant its custody
capability. Disabling or removing a slot stops signing without changing its
key identity. An owner-approved replacement package using the same app ID and
slot can therefore control the same account: only grant custody access to a
package you trust. Uninstall removes Wallet history, preferences, custom
tokens, decoder packs and transaction records. Those local records are not
restored automatically.

Kernel 0.3.46 restores the same Kernel memory v4 used by 0.3.44 without a
migration. Wallet also keeps its three v1 schemas; the fresh install initializes
blank roots. Settings checks the Kernel version and cached account namespace,
warning when an old account still requires a manual fresh install.

There is no seed/private-key export. A different Neutron canister has a
different key scope; copying Wallet data or a frontend draft to it does not
recover this account. Changing the slot, algorithm or threshold master-key
configuration also changes its key. Destructive reinstallation of the entire
Neutron is outside this app-reinstall contract. See the
[fresh-start checklist](../../doc/todo.wallet-fresh-start.md).

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

Release 120 supports Hyperliquid's qualified EIP-712 struct names, including
`HyperliquidTransaction:ApproveAgent` and `HyperliquidTransaction:SendToEvmWithData`.
The exact type names are signed; ordinary field validation and the selected
signing-chain check remain unchanged. Hyperliquid callers use Arbitrum (42161)
as the signing context and include only the declared signed message fields.
The release retains all three version-1 memory roots and their exact lineage.

Release 121 adds HyperEVM mainnet (chain 999, native HYPE with 18 decimals) for
completing stalled CCTP deposits with the original message and attestation.
The existing v1 network and asset maps receive the missing HyperEVM entries;
existing settings, balances, account identity, nonce reservations and command
history remain intact. All three schemas and their released lock lineage remain
unchanged. dRPC supplies genuine explicit-block state reads, unlike the default
HyperEVM RPC, which substitutes latest state for numeric block tags. HyperEVM
shares HyperBFT consensus with HyperCore; the existing v1 `finalityKind` label
`ethereum` describes the same safe/finalized JSON-RPC observation mechanism,
not Ethereum settlement.

Exact recovery reviews cover `CctpForwarder.mintAndForward` on HyperEVM and
`MessageTransmitterV2.receiveMessage` on Ethereum or Arbitrum. They display the
original beneficiary, message nonce, net USDC and gas token, and explain that
recovery does not burn more USDC. The destination contract validates the
attestation and its single-use nonce. The Wallet also interprets the exact
Hyperliquid `UsdClassTransfer` master signature for moving recovered same-account
cash into perpetuals; it does not place a spot trade. This recovery support adds
no custody restrictions and no new persistent schema.

Network and recovery references:
[HyperEVM](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm),
[official RPC provider list](https://hyperliquid.gitbook.io/hyperliquid-docs/builder-tools/hyperevm-tools),
[Circle recovery](https://developers.circle.com/cctp/howtos/retry-failed-mint),
[CctpForwarder](https://github.com/circlefin/hyperevm-circle-contracts/blob/master/src/CctpForwarder.sol).

Release 116 adds the independent `evm_decoders@1` root for imported definitions.
It keeps the exact released Wallet and evidence roots and initializes the new
inventory without migrating or rewriting account state or transaction history.
Decoder, metadata, provider, browser and memory tests cover pack matching,
ambiguity, unavailable metadata, persistence and retrospective Activity display.
Generic token and Uniswap V3 decoding checks the complete canonical calldata,
including nested calls. Shared ERC-20/ERC-721 selectors with unknown token
metadata show exact allowance-or-token-ID values. The zero-allowance action
first checks a valid `allowance()` response so it cannot silently interpret an
unsupported NFT approval as a fungible allowance revocation. These are interface
hints, not contract verification. Decoder changes also refresh other open Wallet
windows; an explicit Wallet refresh retries unavailable token metadata.

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
