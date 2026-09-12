# EVM Wallet And Consumer Apps

[Back to the documentation index](./index.md).

Use this guide when changing EVM Wallet or integrating a consumer app. EVM Wallet
owns EVM custody, transaction preparation, signatures and provider review. IC
Wallet owns IC assets and bridge progress. Consumer apps call Wallet tools and
retain their own protocol workflow journals.

Read the [architecture decisions](./evm-wallet-research.md) for the trust and
persistence boundaries. Use the [manifest](../apps/evm_wallet/neutron.json) for
current capabilities and managed roots, the [shared client](../packages/neutron-tools/src/evm_wallet.ts)
for public schemas, and the [tool service](../apps/evm_wallet/src/service.ts) for
registration and audience rules. Package versions, supported tool inventories,
release receipts and dependency pins belong in their source artifacts.

## Installation And Account Identity

The installed Kernel must support the package's declared capabilities and
installation-aware tool provenance. Resolve unsupported capabilities through the
checked package workflow; do not bypass installer checks. Publish mutually
compatible packages atomically. **Upgrade all** updates installed apps; it does
not install an absent Wallet. See [package updates](./package-updates.md) for
installation and publication semantics.

EVM Wallet requests `wallet_custody_signing` API 1 with slot `main`. This grants
access to its scoped public key and exact 32-byte digest signing. The owner
reviews this custody authority during installation. Assertion signing remains a
separate API with a different signing and key-derivation domain.

Custody namespace v2 derives the key from the Neutron canister, app ID
`evm_wallet`, slot, algorithm and trusted management key name. Neither the
installation UID nor the Kernel installation epoch changes this account.
Another app ID derives a different key even if it uses the same slot name.

Reinstalling the same app ID and slot in the same Neutron can regain that key
when the owner grants custody again. A replacement package with that identity
can control the account, so custody is a trust decision about the Wallet code.
Compatible app upgrades and disable/re-enable retain the key; signing is
unavailable while disabled. Uninstall deletes local history, settings, imported
decoders and pending transaction records, which key recovery does not restore.
Production upgrades must preserve those records.

A saved account from a different custody namespace is not recovered merely by
retaining its cached address. Wallet detects the legacy lifecycle and verifies
returned signatures against the saved key. Do not silently clear memory or turn
historical fresh-install instructions into an upgrade path. Reconcile the actual
installed namespace and outstanding operations before any account-lifecycle
change. There is no seed phrase, private-key export or automatic cross-canister
recovery. See the precise [signing lifecycle](./app-isolated-chain-key-signing.md#wallet-custody-signing-v1).

## Networks, Balances And Costs

Read configured chains and default assets from [backend configuration](../apps/evm_wallet/backend/Config.mo)
and the current RPC endpoints from [browser transport](../apps/evm_wallet/src/browser_rpc.ts).
An account shares its EVM address across configured chains, while balances,
tokens, nonces and operations always carry an explicit chain ID. UI selection
must not change another app's saved request.

The selected chain's native currency pays transaction gas. Neutron cycles pay
for chain-key signing and durable backend updates. Browser RPC requests do not
consume the Neutron's HTTP-outcall cycles. Token identity is the chain plus full
contract address; symbols and display decimals are not proof of identity.
Balances cover requested assets, history covers recorded Wallet activity, and
known approvals cover locally observed spenders. None is an exhaustive index.

EVM JSON-RPC goes from the Wallet browser service to the configured chain
endpoint, including balances, reads, gas, simulation, submission and receipts.
The client validates the endpoint's chain ID and omits browser credentials.
It uses neither an external wallet extension nor an EVM RPC canister or Kernel
HTTP proxy. A provider's response is an observation, not multi-provider consensus
or an Ethereum light-client proof.

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

Discover available tools and their installed schemas before using optional
features. The shared client defines versioned account, read, effect, operation
status and transaction-evidence contracts. Its validators are authoritative;
do not duplicate an inventory or hand-maintain response shapes in a consumer.

Amounts, chain IDs and nonces use canonical decimal strings; bytes use hex.
The SDK validates closed request and response shapes and matching identities.
The explicit-chain client is the integration interface used by these apps;
a wallet-global EIP-1193 selected-chain adapter is not required.

Consumer apps declare exact cross-app tools in their install-reviewed manifest:

```json
{
  "capabilities": {
    "frontend_tools": {
      "api": 1,
      "targets": [{
        "app": "evm_wallet",
        "tools": ["evm_accounts_v1", "evm_call_contract_v1", "evm_send_transaction_v1"]
      }]
    }
  }
}
```

These declarations remove repeated connection prompts. They do not replace
provider confirmation or expose private or root-only tools. Uniswap and IC
Wallet declare the exact tools their integrations use.

Effects use `provider_once`. For ordinary users, EVM Wallet's foreground tile
owns the final transaction review. During an authenticated Agent invocation,
EVM Wallet prepares the exact same operation and asks the Kernel to send its
review to the root Agent's permission reviewer. Execution starts only after that
fresh decision. The operation remains owned by the calling app installation;
that app receives neither the custody capability nor root audience. The Agent
reviewer receives the owner's original request and later steering, so a retry
retains the original swap context and later changes or cancellation still apply.
Direct root effects remain available through the separate `*_root_v1` tools
and the Kernel's attested root audience.

For direct-root orchestration, the consumer saves and returns the exact next
intent; root calls EVM Wallet directly, then supplies chain evidence to the consumer.
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
swap or deposit. Preserve released response contracts when extending this
evidence; optional fields require installed-schema discovery, and incompatible
shapes require a separate versioned tool.

## Consumer Examples

Use existing consumers as implementation references, retaining their ownership
and recovery checks rather than copying only a successful dispatch:

- [Kitchen Sink](../apps/kitchensink/README.md) exercises the shared client,
  persisted intents and independent signature verification. Opening its example
  page does not itself request a transaction.
- IC Wallet's [bridge tools](../apps/wallet/src/bridge_tools.ts) and
  [bridge journal](../apps/wallet/backend/bridge/Journal.mo) bind Ethereum effects
  to their saved requests, correlate minter events and verify IC mint blocks.
  Its [conversion tools](../apps/wallet/src/conversion_tools.ts) orchestrate wrap
  and unwrap flows using the existing durable bridge and withdrawal journals.
  An approval, deposit or burn acceptance does not itself prove destination
  settlement. Use current route discovery rather than assuming token or chain
  support; Ethereum ck-token deposits are not direct deposits from another chain.
- Uniswap's [action workflow](../apps/uniswap/src/action_workflow.ts) keeps
  approval and final swap/liquidity steps under one saved operation. It verifies
  actual Wallet receipts before advancing and retains uncertain dispatches
  across plan expiry. ERC20 allowance and Permit2 allowance are separate grants;
  the former does not expire when a Permit2 approval does. See the
  [Uniswap integration contract](./uniswap-v4-liquidity.md).

## Verification And Release

The test layers cover independent protocol vectors, actual Motoko execution,
RPC failure/recovery, durable journals, SDK/provider boundaries, local chain
receipts, official Uniswap contract execution, and checked upgrades. Mocked
transport tests alone do not establish real chain execution. Local Anvil and
contract fixtures use disposable test balances; no production funds are required
for automated qualification.

Every changed production app is versioned and packaged through its workspace
command. Publish the compatible set atomically with its offered sources, then
require the exact-byte receipt-v2 no-op, following
[package updates](./package-updates.md). Publishing does not install the updates
or change the Dispenser starter.
