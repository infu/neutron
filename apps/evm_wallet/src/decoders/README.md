# Wallet transaction decoders

Wallet uses one presentation pipeline for Activity, owner confirmation and Agent
review. Protocol apps still send ordinary EVM requests through the existing
Wallet client. Decoding cannot alter transaction bytes, sign, or grant authority.

## Using decoder packs

Open **Wallet → Settings → Transaction explanations**, import a JSON file or paste
its contents, then preview the contract addresses, chain IDs and functions.
Install saves the exact document and enables it. A changed document with the
same ID needs a higher positive integer version. Settings also supports
disabling, reenabling, replacing and removing packs.

An enabled pack also explains matching older Activity entries. Removing or
disabling it leaves every transaction intact and restores the ordinary fallback.
Imported explanations carry their pack name/version; Details shows their ID,
origin, exact document SHA-256 and optional source text. The source is a statement
by the pack author: Wallet does not fetch it or treat it as verification.

Built-in Uniswap, Curve, Aave and Permit2 adapters retain precedence, followed by
standard ERC-20 interpretation. If multiple enabled imports match, Wallet shows
the generic transaction and an ambiguity notice. Installation order never
chooses between conflicting definitions. Native transfers remain ordinary
native transfers.

Generic token selector hints remain authoritative over imports. ERC-721
`approve` and `transferFrom` share ERC-20 selectors. When fungible-token metadata
is unavailable, these calls show the exact **allowance or token ID** / **amount
or token ID** without treating token ID zero as an allowance revocation. Full
NFT interface recognition remains a separate adapter task; imported packs do
not silently suppress token approval information.

## Authoring a pack

This illustrative vault has a `deposit(uint256,address)` function. Replace both
example addresses with the actual deployment and underlying token before use.

```json
{
  "format": 1,
  "id": "example-vault",
  "version": "1",
  "name": "Example vault",
  "description": "Deposit underlying tokens in exchange for vault shares.",
  "source": "Local example; source not verified",
  "deployments": [
    { "chainId": "11155111", "address": "0x1111111111111111111111111111111111111111" }
  ],
  "functions": [{
    "signature": "deposit(uint256 amount,address receiver)",
    "title": "Deposit into vault",
    "value": "zero",
    "fields": [
      {
        "path": "args.0", "label": "Deposit amount", "format": "tokenAmount",
        "tokenAddress": "0x2222222222222222222222222222222222222222", "role": "amount"
      },
      { "path": "args.1", "label": "Share recipient", "format": "address", "role": "party" }
    ]
  }]
}
```

`format` is the decoder document schema version. `version` is a positive decimal
integer string belonging to this pack; it is independent of Wallet release and
memory versions. IDs match `[a-z0-9][a-z0-9._-]*`. Deployments require exact chain
IDs and contract addresses. Each signature describes one ABI function, optionally
prefixed with `function `. Selectors within a pack must be unambiguous.

`value: "zero"` requires zero native payment. `"payable"` permits a native payment,
which is displayed independently unless the primary field already represents
`transaction.value`. This setting describes which calls the pack recognizes; it
does not stop a user from submitting a different transaction.

Fields select `args.0`, nested tuple names/positions such as `args.0.receiver`,
array positions such as `args.0.1`, or `transaction.from`, `transaction.to`, and
`transaction.value`. These are validated ABI paths, with no expressions or
templates. Formats are `address`, `integer`, `boolean`, `bytes`, `timestamp`,
`tokenAmount`, and `nativeAmount`. A `tokenAmount` requires exactly one literal
`tokenAddress` or address-valued `tokenPath`. It cannot declare its own token
symbol or decimals. One field may have `role: "amount"`; `"party"` appears in the
main review and other fields appear in Details. Titles, descriptions, labels and
source text are rendered as inert text.

Matching requires the transaction's chain, destination, selector, permitted
native value and complete canonical ABI encoding. Decoding and reencoding must
reproduce every byte; unsupported or malformed inputs retain generic review.
Calldata and exact native value remain available regardless of presentation.
Matching an ABI does not prove the contract implements that meaning, and an
owner-imported title is not a verified protocol badge.

## Code and metadata

`registry.ts` registers pure built-in adapters in `adapters/`. A new complex
adapter returns `OperationPresentation | null` and receives only the operation,
known assets and network. It has no RPC or signing client. Review any deployment
or command-language assumptions in that adapter and add independent calldata
fixtures. Ordinary ABI functions can use JSON packs without a Wallet rebuild;
nested routers or conditional multicalls may still require a code adapter.

`runtime.ts` enriches explicit token references through `metadata.ts`, then
reruns the same presentation. Saved/custom metadata wins; missing metadata is
read from `decimals()` and `symbol()` at an explicit block through Wallet's
existing read-only browser RPC. Successful observations use a volatile cache;
failures leave raw atomic amounts. Missing decimals never default to 18.
Identity remains chain plus address, even when two tokens share a symbol.
These are current display observations, not metadata recorded when an older
transaction was signed. No transaction history or selected-token list is rewritten.

`store.ts` verifies exact document digests and parsed identities. The backend
stores JSON, SHA-256, version, enabled state and timestamps in `evm_decoders@1`.
The released `evm_wallet@1` and `evm_evidence@1` schemas and their lineage stay
unchanged. A compatible upgrade keeps them and initializes the new root. The
existing private self-call mechanism owns pack management; no cross-app tool,
remote code loader, new Kernel permission or automatic protocol discovery is
introduced.

## Research and design choices

[MetaMask transaction insights](https://docs.metamask.io/snaps/features/transaction-insights/)
demonstrate an extensible transaction-insight surface, with
[explicit Snap permissions](https://docs.metamask.io/snaps/reference/permissions/).
Neutron already supplies its own Wallet approval boundary; this implementation
uses local data definitions and pure packaged adapters within that boundary.

[ERC-7730](https://eips.ethereum.org/EIPS/eip-7730) and
[Ledger's clear-signing guide](https://developers.ledger.com/docs/clear-signing/for-dapps/manual-implementation)
informed the separation of deployment identity, ABI decoding and display fields.
This small format is **inspired by ERC-7730**, not an implementation of its JSON
schema, and Ledger descriptors cannot be imported unchanged.

[ABI tooling](https://docs.ethers.org/v6/api/abi/) provides a common language for
decoding function arguments. Contract verification services such as
[Sourcify](https://docs.sourcify.dev/blog/technical-verification-walkthrough/)
provide evidence about source/bytecode correspondence; that evidence is distinct
from transaction safety and human-readable intent. Wallet does not automatically
download or trust arbitrary ABIs from such services in this release.
