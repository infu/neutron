# EVM Wallet Architecture Decisions

[Documentation index](./index.md) · [Consumer integration](./evm-wallet.md)

This file records the implemented architecture and the reasons to preserve its
boundaries. The filename is retained for existing links; it is not an outstanding
implementation proposal. Derive supported networks, package versions, dependency
pins and deployment endpoints from the source files below.

## Source map

| Concern | Source of truth |
| --- | --- |
| Installed capabilities and managed roots | [Wallet manifest](../apps/evm_wallet/neutron.json) and [memory lineage](../apps/evm_wallet/neutron.lock.json) |
| Custody key derivation and revocation | Kernel signing [namespace](../apps/kernel/backend/chain_key_signing/Namespace.mo) and [service](../apps/kernel/backend/chain_key_signing/Service.mo) |
| Transaction intent, preparation and signing | Wallet [backend](../apps/evm_wallet/backend/main.mo), [journal](../apps/evm_wallet/backend/Journal.mo) and [EVM primitives](../apps/evm_wallet/backend/evm/) |
| Browser observations and transmission | [RPC transport](../apps/evm_wallet/src/browser_rpc.ts), [reads](../apps/evm_wallet/src/browser_reads.ts) and [operations](../apps/evm_wallet/src/browser_operations.ts) |
| Cross-app identity and request validation | [Shared Wallet client](../packages/neutron-tools/src/evm_wallet.ts) |
| Human and Agent review | [Tool service](../apps/evm_wallet/src/service.ts) and [provider](../apps/evm_wallet/src/provider.ts) |
| IC bridge ownership and settlement | IC Wallet [bridge journal](../apps/wallet/backend/bridge/Journal.mo) and [bridge tools](../apps/wallet/src/bridge_tools.ts) |

## Custody belongs to an explicitly trusted app

EVM Wallet is an ordinary provider app with an explicit
`wallet_custody_signing` grant. Kernel binds access to the installed app's
current capability scope, chooses the management key and derives the signing
namespace. Wallet supplies an exact digest after preparing its own operation.
Consumer apps receive neither that capability nor a private key.

This differs deliberately from app assertion signing. Assertion signing hashes
a Kernel-created domain-separated message; custody signs the supplied digest
unchanged. An assertion grant must not implicitly authorize EVM custody.
Wallet computes transaction, personal-message and typed-data digests in its
backend. Its protocol encoders and signature verification require independent
vectors; a frontend dependency does not verify the Motoko implementation.

The owner consequently trusts the installed Wallet package's signing behavior.
Kernel scope isolation prevents another app from selecting that authority, but
does not independently interpret the financial meaning of each Wallet digest.
Keep protocol-specific transaction interpretation in Wallet presentation and
consumer integrations. Changes to this trust boundary require an explicit design
decision, not an inferred hardening task.

Custody namespace v2 binds the key to the Neutron canister, app ID, slot,
algorithm and trusted key name. Installation identity and Kernel installation
epoch control runtime authority without changing this custody key. Reinstalling
the same app ID and slot can regain the same key after the custody grant; it does
not restore deleted history or pending-operation records. This contract does not
provide cross-canister recovery or recovery of a different historical namespace.
Never turn a key mismatch into an automatic reset. See the complete
[signing lifecycle](./app-isolated-chain-key-signing.md#wallet-custody-signing-v1).

## Financial intent is durable; observations are replaceable

An operation is identified by the authenticated calling app installation and
its request ID. Endpoint reconnects must not create a new financial identity.
The backend compares complete intent on replay, reserves nonces per account and
chain, freezes the reviewed candidate, and stores signed bytes and their local
hash before browser submission.

The browser gathers RPC observations and simulates the exact prepared candidate.
These observations are evidence from a provider, not Ethereum light-client
proofs. The backend validates their shape and consistency with the saved intent;
that validation does not make a malicious provider truthful. Keep unavailable,
conflicting and stale observations distinguishable from successful execution.

After an uncertain submission, reconcile the saved hash and, when appropriate,
resubmit the same bytes. After an uncertain signing outcome, preserve uncertainty
rather than generating another signature. A signature returned without a Wallet
broadcast is already released authority. Chain selection cannot add a domain
restriction to a message that does not contain one.

Read-only estimates must not allocate a nonce or create a command. Refreshing
review evidence changes the review revision; executing an older revision must
not silently sign changed fields. A replacement transaction has its own explicit
review and hash while competing for the original nonce.

## Browser RPC is the implemented transport

Wallet uses direct browser JSON-RPC with explicit chain selection, endpoint
chain-ID validation, omitted credentials and no automatic transport retry. The
backend retains durable authority and operation records; it does not make EVM
RPC canister calls. Earlier EVM RPC transport proposals are not implementation
instructions.

Native gas on the selected chain and Neutron cycles for signing/backend updates
are separate resources. Provider observations of inclusion, safe/finalized heads
and bridge settlement are also separate. Preserve chain-specific fee semantics;
in particular, do not add Arbitrum posting costs a second time to a gas estimate
that already includes them.

Token discovery, market prices, decoder metadata and NFT indexes supplement
chain observations. They must not replace exact asset identity, calldata,
ownership verification or settlement evidence. Complete portfolio indexing is
not implied by a selected-token balance tool.

## Consumers own protocol workflows, Wallet owns each effect

The shared client preserves invocation context and requires Kernel-attested
caller installation identity. A consumer saves its full intent before requesting
an effect. Human requests use Wallet's provider presentation; authenticated Agent
requests use the Kernel-bound provider approval callback. Separate root tools
require root audience attestation. Nested apps do not inherit that audience.

Multi-step approvals, swaps and bridge deposits are durable sequences rather
than atomic EOA operations. An approval receipt cannot complete the final
operation. Consumers verify exact sender, recipient, value, calldata and receipt,
and use Wallet request binding or replacement ancestry when reconciling root
execution. IC Wallet separately correlates Ethereum deposits with minter events
and verified IC mint blocks; an unrelated balance increase is insufficient.

Preserve the distinction between the existing IC funding API and EVM bridge
workflows. Read current bridge routes from IC Wallet instead of assuming that a
token on another EVM chain can be deposited into an Ethereum helper.

## Change qualification

Use the app test scripts and fixture documentation to select checks for the
changed layer: independent digest/encoding vectors, real Motoko execution,
provider provenance and cancellation, browser RPC failure recovery, durable
journals, local chain receipts and state restoration. A mocked response or a
chain-ID fixture alone does not qualify external protocol execution or finality.

Managed schemas and lock lineage remain immutable release history. Audit every
root, retain it for code-only changes, and add explicit forward migrations for
schema changes. Use [memory migration rules](./memory-migrations-and-uninstall.md)
and the [production package workflow](./package-updates.md). Keep version-bound
test results and publication receipts in release artifacts rather than this
architecture document.
