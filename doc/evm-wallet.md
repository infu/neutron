# EVM Wallet And Consumer Apps

[Back to the documentation index](./index.md).

EVM Wallet is the separate `evm_wallet` app. It owns one chain-key ECDSA account,
its EVM transactions and signatures, and the confirmation UI used by other apps.
IC Wallet continues to own IC assets and ck-token bridge progress. Uniswap and
Kitchen Sink call the shared wallet tools; neither receives the wallet's signing
capability.

This guide describes the implementation being qualified. Publication and exact
archive evidence belong in the release record, not in these general instructions.

## Installation And Account Identity

Install the compatible Kernel successor before first installing EVM Wallet.
Older compilers do not understand the new custody capability. Existing installed
apps and the Kernel can still be updated together through the ordinary checked,
state-preserving upgrade transaction; this does not require separate production
publication phases.

EVM Wallet requests `wallet_custody_signing` API 1 with the immutable slot `main`.
The owner reviews this custody authority during installation. The capability
retrieves its scoped public key and signs an exact 32-byte digest. Its derivation
domain is distinct from the existing assertion-signing capability, whose API
and keys remain unchanged.

Kernel binds custody to the Neutron, installation epoch, app installation UID,
slot, algorithm and trusted management key configuration. Another app declaring
`main` gets a different key. Another app cannot take the installed wallet's
namespace; no second reservation registry is required.

Compatible upgrades retaining that identity preserve the address. Disabling and
reenabling the unchanged capability preserves it too. Removing/reinstalling the
wallet, removing/reintroducing a slot, changing the key configuration or
reinstalling the entire Neutron may rotate the key. The wallet has no seed phrase
or private-key export. Moving funds out before removal is distinct from recovering
an old namespace; automatic reassignment of removed custody identities is not
implemented. See the precise [signing lifecycle](./app-isolated-chain-key-signing.md).

## Networks, Balances And Costs

The initial networks are Ethereum (`1`), Arbitrum One (`42161`) and Sepolia
(`11155111`). An account has the same EVM address across them. Balances, tokens,
nonces and operation records always carry the explicit chain ID. UI selection
never changes the chain of another app's saved request.

Fund the selected network's address with ETH for gas. The Neutron also needs IC
cycles for chain-key signing and EVM RPC calls. These are separate resources.
Token identity is the chain plus full contract address; symbols and manually
configured display decimals are not proof of identity. Balances cover requested
or selected tokens, history covers recorded wallet activity, and known approvals
cover locally observed spenders. None is an exhaustive portfolio index.

The backend uses the released EVM RPC canister interface through existing
`backend_calls` reservations. Read requests use multiple providers and expose
unavailable or inconsistent outcomes. Cycle attachment comes from the RPC cost
methods, within the platform's existing declared bounds. No provider API key is
embedded in the app. Optional indexers, credentialed RPC providers and enhanced
simulation services can be added as app adapters later.

Gas preparation uses exact integer fields and live RPC evidence. Arbitrum gas
estimation already accounts for posting costs; the app does not add that cost a
second time. Sequencer inclusion, provider-reported safe/finalized heads, Ethereum
settlement and bridge withdrawal readiness are different observations.

## Requests And Recovery

A consumer saves its complete intent and a random 16-byte request ID before
requesting any effect. Kernel attests the caller's app ID and installation UID;
EVM Wallet keys the command by that installation and request ID. Endpoint
replacement does not create a new identity. Repeating the same intent returns
the saved operation; changing it under the same ID conflicts.

The backend freezes reviewed transaction fields, allocates a nonce per account
and chain, verifies the signature, and saves signed bytes and the local hash
before broadcast. Concurrent approvals that change prepared fields require a
new review revision. Confirmed execution, revert, rejection, preparation,
submission and uncertainty are different results.

After a timeout, reload or lost reply, query the existing operation. Do not
create a new ID because the first result is unknown. Reconciliation may resend
the exact already-authorized signed bytes; it does not create a fresh transfer
or repeat an uncertain signature. A definite failure before signing can be
reviewed and retried explicitly using its saved identity. Speed-up/cancel uses
an explicitly reviewed replacement with the same nonce; cancellation competes
with the original transaction and is not guaranteed to win.

A returned personal or typed-data signature is released authority even when the
wallet broadcasts nothing. The UI preserves the exact EIP-712 JSON text for
review and hashing, including integers larger than JavaScript's safe numeric
range. Use decimal strings or the SDK serializer for large integers. Personal
messages and typed data without chain binding can be usable outside the selected
network; selecting a network does not add a signature-domain restriction.

## Shared Consumer Client

Import the versioned client from `neutron-tools/evm_wallet`. Inject the current
invocation's `context.kernel` when handling a tool, so caller provenance and
cancellation remain intact. Do not use a global client to forward an invocation
or supply caller identity yourself.

```ts
import {
  createEvmWalletClient,
  createEvmRequestId,
  prepareEvmWalletIntent,
  resumeEvmWalletIntent,
} from "neutron-tools/evm_wallet";

const wallet = createEvmWalletClient(context.kernel);
const saved = await prepareEvmWalletIntent(wallet, "transaction", {
  requestId: createEvmRequestId(),
  accountId: "main",
  chainId: "1",
  to: recipient,
  valueWei: amountWei,
  data: "0x",
}, persistIntent);

// Run from an explicit user action. On reload, read the original saved intent.
const operation = await resumeEvmWalletIntent(wallet, saved);
await persistOperation(operation);
```

`persistIntent` must finish durable storage before the effect is requested.
The helper pins the wallet address and key fingerprint and checks status before
sending a request that the wallet has never seen. A saved prepared operation
still needs an explicit review action. Consumer sequence journals also need to
retain completed approvals and failed/pending later steps.

| Client operation | Tool |
| --- | --- |
| Account and network discovery | `evm_accounts_v1`, `evm_networks_v1` |
| Native/requested ERC20 balances | `evm_balances_v1` |
| Contract result and code at an observed block | `evm_read_contract_v1` |
| Transaction review and execution | `evm_send_transaction_v1` |
| Personal and typed-data signatures | `evm_sign_message_v1`, `evm_sign_typed_data_v1` |
| Caller-owned command reconciliation | `evm_operation_status_v1` |
| Public chain evidence by network and hash | `evm_transaction_v1` |

Amounts, chain IDs and nonces use canonical decimal strings; bytes use hex.
The SDK validates closed request and response shapes and matching identities.
The explicit-chain client is the integration interface used by these apps;
a wallet-global EIP-1193 selected-chain adapter is not required.

Human effects use `provider_once`: EVM Wallet's foreground tile owns the final
review. Direct root Agent effects use the separate `*_root_v1` tools and the
Kernel's attested root audience. Calling an ordinary app from Agent does not
give that app or its nested calls root signing authority.

For multi-app Agent flows, the consumer saves and returns the exact next intent;
root calls EVM Wallet directly, then supplies chain evidence to the consumer.
Consumers validate actual sender, destination, value, calldata and receipt
against the saved intent. For root execution they also supply the saved
`walletRequest` identity to transaction lookup and require
`walletRequestMatches: true`. The backend checks the stored command and signed
hash, preventing an old identical transaction from being relabeled as a new
request. This returns a match verdict without exposing another caller's journal.

## Consumer Examples

Kitchen Sink's `#evm_wallet` page demonstrates account/network/balance reads,
contract reads, native/ERC20 transfers, approval plus contract call, and personal
and EIP-712 signatures with independent verification. It saves intents through
its existing resident browser-storage capability. Opening the page sends no
transaction. Its existing IC Wallet and external-browser-wallet examples remain
available. See [Kitchen Sink](../apps/kitchensink/README.md).

IC Wallet offers EVM Wallet or an external browser wallet as the source of an
Ethereum ck-token deposit. It saves helper/token mapping, account, amount,
recipient and each approval/deposit step before dispatch. Completion is tied to
the exact deposit, minter event and IC mint block; an unrelated incoming balance
cannot complete it. Ethereum ck-token deposits are not direct Arbitrum deposits.
The saved Send/Withdraw journal also preserves exact ledger/minter arguments
across uncertain replies. Where a minter outcome cannot be proven, it remains
unresolved rather than generating a fresh withdrawal. See
[IC Wallet](../apps/wallet/README.md).

Uniswap compares direct V3 pools on Ethereum and Arbitrum, using QuoterV2 and
SwapRouter02. It saves the quoted minimum output, recipient and deadline,
requests an exact ERC20 approval when needed, then requests the swap through
EVM Wallet. Native ETH wrapping, output unwrapping and refunds are part of the
router calldata. Approval and swap are separate transactions. V4, Permit2,
multi-hop/split routing and liquidity provision are outside this initial route.
See [Uniswap](../apps/uniswap/README.md).

## Verification And Release

The test layers cover independent protocol vectors, actual Motoko execution,
RPC failure/recovery, durable journals, SDK/provider boundaries, local chain
receipts, official Uniswap contract execution, and checked upgrades. Mocked
transport tests alone do not establish real chain execution. Local Anvil and
contract fixtures use disposable test balances; no production funds are required
for automated qualification.

The [implementation checklist](./todo.evm-wallet.md) tracks completed evidence.
Every changed production app is versioned and packaged through its workspace
command. Publish the compatible set atomically with its offered sources, then
require the exact-byte receipt-v2 no-op, following
[package updates](./package-updates.md). Publishing does not install the updates
or change the Dispenser starter.
