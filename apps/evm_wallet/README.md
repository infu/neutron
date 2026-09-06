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

## Using the wallet

- **Assets** shows native ETH and selected ERC-20 balances at the returned block.
  This view is not exhaustive token discovery. A selected token's label is a
  display hint; its identity is the network and contract address.
- **Send** prepares an exact native transfer, selected ERC-20 transfer or contract
  call. Review shows the account, network, recipient, value, calldata, nonce,
  simulation result and maximum gas fee before approval. Known ERC-20 selectors
  are decoded as hints, not proof of the called contract's behavior.
- **Activity** includes requests from other apps, message signatures, pending
  outcomes and receipts. It is the Wallet's own journal, not a complete external
  transaction index. Load older pages when checking older requests.
- **Approvals** lists spender/token pairs found in loaded Wallet approval
  transactions. Check the live allowance and request an exact zero approval to
  revoke it. External approvals and signed permits are not exhaustively indexed.
- **Sign** supports EIP-191 personal messages and EIP-712 typed data. The review
  shows the complete original JSON, including integer lexemes beyond JavaScript's
  safe-number range. Signatures can authorize actions outside this Wallet.
- **Settings** selects custom tokens and explains the account lifecycle.

Arbitrum gas estimates include its posting-cost component; the Wallet does not
add a second arbitrary posting fee. A receipt records canonical inclusion and
observed safe/finalized evidence. Arbitrum inclusion alone does not imply final
Ethereum settlement. EVM transactions need native gas on their EVM network;
chain-key signing and RPC calls separately consume this Neutron's IC cycles.

## Review, recovery and replacements

Other apps call the resident service. Effects marked `provider_once` open this
Wallet's private foreground review tool. The Kernel supplies the authenticated
caller app and installation UID. A separate root-agent tool family uses the
same backend preparation and execution path and requires Kernel root-agent
attestation. A nested app invocation does not acquire root authority.

Requests are identified by caller app, caller installation and a 16-byte request
ID written as 32 lowercase hexadecimal characters. Identical replay resolves the
saved request; changed intent conflicts. A new tile endpoint can recover the
same request within the same installation.

Prepared operations require their current review revision. If another request
reserves their proposed nonce first, the Wallet returns a revised review and
asks for approval again. It does not silently sign the changed transaction.

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
transaction evidence. Operation status is a reconciliation tool marked read,
write and network because it can update the journal and rebroadcast already
approved signed bytes. Transaction evidence can verify that a
public hash belongs to an exact saved Wallet request without revealing private
messages or signatures.

Human effect tools are `evm_send_transaction_v1`, `evm_sign_message_v1`,
`evm_sign_typed_data_v1` and `evm_replace_transaction_v1`. Their `_root_v1`
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

The first release uses the `evm_wallet` managed root at schema version 1. Review
its clean initialization and state retention tests together with backend crypto,
RPC, command recovery, provider and browser tests. Preserve the published schema
and lock lineage after release. Installation and publication follow
[`doc/package-updates.md`](../../doc/package-updates.md) and
[`doc/memory-migrations-and-uninstall.md`](../../doc/memory-migrations-and-uninstall.md).
The production update source is `233tv-xiaaa-aaaay-aacta-cai`.

This app uses the shared `LICENSE.APP.USE` packaging workflow. Source is offered
for inspection under those exact terms; see `NOTICE` and the packaged legal
metadata.
