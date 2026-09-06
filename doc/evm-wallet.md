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

EVM Wallet requires a Kernel with `wallet_custody_signing` API 1 and
installation-aware tool provenance. Apply a compatible Kernel successor and
updates to already installed apps together through the ordinary checked
**Upgrade all** transaction. First-time installation of an absent EVM Wallet
uses the setup flow after that support is available; **Upgrade all** updates
installed apps and does not add absent ones. The compatible packages are
published together, without separate production publication phases.

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
reenabling the unchanged capability preserves it too. Removing a slot removes
its authority and cache; restoring the same slot within the same installation
and trusted key configuration derives the same key. Uninstalling/reinstalling
the wallet, changing the trusted key configuration or creating a new Neutron
installation identity changes the key. The wallet has no seed phrase
or private-key export. Moving funds out before removal is distinct from recovering
an old namespace; automatic reassignment of removed custody identities is not
implemented. See the precise [signing lifecycle](./app-isolated-chain-key-signing.md).

## Networks, Balances And Costs

The initial networks are Ethereum (`1`), Arbitrum One (`42161`) and Sepolia
(`11155111`). An account has the same EVM address across them. Balances, tokens,
nonces and operation records always carry the explicit chain ID. UI selection
never changes the chain of another app's saved request.

Fund the selected network's address with ETH for gas. The Neutron also needs IC
cycles for chain-key signing and durable wallet updates. Browser RPC requests do
not consume this Neutron's outcall cycles. These are separate resources.
Token identity is the chain plus full contract address; symbols and manually
configured display decimals are not proof of identity. Balances cover requested
or selected tokens, history covers recorded wallet activity, and known approvals
cover locally observed spenders. None is an exhaustive portfolio index.

All Ethereum JSON-RPC requests go directly from Wallet's browser client to one
PublicNode endpoint for the selected chain. This includes balances, contract
reads, Uniswap quotes, fees, simulation, submission and receipt checks. The
client validates the endpoint's chain ID and uses CORS without browser-wallet
extensions or embedded API keys. It does not use the EVM RPC canister, replicated
HTTP outcalls, or a Kernel HTTP proxy. A single provider supplies observations;
these are not multi-provider consensus or Ethereum light-client proofs.

The backend retains account identity, immutable request intent, nonce
reservations, review revisions, chain-key signatures and signed transaction
bytes. Browser observations prepare a candidate, then gas estimation and
simulation use that exact candidate before the backend marks it ready for
review. A concurrent nonce change requires another simulation and approval.
Signing saves the raw transaction and hash before the browser submits it once.
An ambiguous submission is recovered by looking up that hash and, on an
explicit status check, resubmitting only the retained bytes when absent.

Gas preparation uses exact integer fields and live RPC evidence. Arbitrum gas
estimation already accounts for posting costs; the app does not add that cost a
second time. Sequencer inclusion, provider-reported safe/finalized heads, Ethereum
settlement and bridge withdrawal readiness are different observations.

For recognized ERC20 calls, Wallet review also records the token balance and
applicable allowance at an explicit block. Approval review shows the observed
allowance, requested allowance and change in exact atomic units. Missing or
failed reads stay visible. Refreshing these observations revises the same review;
it neither signs nor starts a new transfer. The block and observation time remain
visible because a saved observation is not a guarantee of the current balance.

Consumers can request a read-only transaction fee estimate without reserving a
nonce or preparing a command. The estimate separates expected cost from the
suggested fee cap and excludes the transferred value. Pricing can succeed while
gas estimation fails, for example before an approval is mined; a missing total
is shown as unavailable. Arbitrum estimates multiply the returned gas estimate
once, including its posting component. A chain-ID fixture alone does not test
Nitro posting costs or sequencer settlement.

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
| Lightweight contract result at latest or an explicit block | `evm_call_contract_v1` |
| Read-only transaction gas and fee observations | `evm_estimate_transaction_v1` |
| Transaction review and execution | `evm_send_transaction_v1` |
| Personal and typed-data signatures | `evm_sign_message_v1`, `evm_sign_typed_data_v1` |
| Caller-owned command reconciliation | `evm_operation_status_v1` |
| Public chain evidence by network and hash | `evm_transaction_v1` |
| Signed replacement ancestry for an exact original request | `evm_replacement_transaction_v1` |

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

A replacement has its own hash and does not match the original request's exact
hash. Consumers use the separate replacement-proof tool to establish signed
journal ancestry, then check the replacement's actual sender, destination,
value, calldata and canonical receipt. A speed-up can complete the saved step
only when its effects still match that step. A cancellation cannot complete a
swap or deposit. Existing version-1 transaction and operation response shapes
remain unchanged for installed consumers.

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
SwapRouter02. Connect requests the exact read tools together for the live
connection; quoting then compares pools concurrently over browser RPC and shows
the result while separate fee estimates finish. It saves the quoted minimum output, recipient and deadline,
requests an exact ERC20 approval when needed, then requests the swap through
EVM Wallet. Native ETH wrapping, output unwrapping and refunds are part of the
router calldata. Numeric network-fee observations are refreshed separately from
the saved quote and intent; an unavailable estimate is not replaced with the
Quoter's execution-gas number. Approval and swap are separate transactions.
Ordinary ERC20 allowances have no permit nonce, signature domain or expiry;
they last until spent or changed, independently of the swap deadline. V4, Permit2,
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


The initial completed release was Kernel 342, IC Wallet 316, Kitchen Sink 315, EVM Wallet 107
and Uniswap 104. [Release qualification](../.neutron/release-receipts/evm-wallet-completion-2026-09-06/validation.md)
records the state-preserving upgrades, version-bound local protocol runs and
batch 52 publication with its exact-byte receipt-v2 no-op. All wallet transaction
tests used local Anvil/PocketIC balances, with a disclosed ERC20 stand-in;
no production-wallet funds were used. The original local runtime was restored.
