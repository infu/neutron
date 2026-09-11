# Ethereum USDC checkout

Ethereum checkout accepts native USDC on Ethereum mainnet through either the
Neutron EVM Wallet or an ordinary browser wallet. The buyer remains the Neutron
principal. A funding Ethereum address does not become the owner of the apps.

The unlock point is a successful mined transaction verified by the protocol.
The buyer does not wait for ckUSDC wrapping or an additional confirmation count.
A pending transaction, an approval transaction, or a browser's success message
does not establish payment. This trades Ethereum finality for faster access:
an early download cannot be undone if the mined transaction is later reorganized.
Developer, affiliate and burn balances remain unavailable until ckUSDC collection.

## Invoice and payment

The ordinary USD quote selects the complete unowned dependency closure and
calculates the same actual-paid revenue split as an IC payment. An Ethereum
invoice freezes that quote, the funding address, the official minter route and a
unique marketplace subaccount. Its gross USDC amount includes the ckUSDC
collection fee. Ethereum approval and deposit gas are paid separately by the
funding wallet.

Issuing an invoice reserves its selected apps against another simultaneous
purchase by the same Neutron. The same request ID returns the same invoice;
ordinary IC payment cannot execute against an Ethereum invoice. An issued
invoice does not expire or silently adopt new prices while funds may be in flight.

The wallet approves only the invoice amount to the official subaccount-aware
helper and calls `depositErc20(address,uint256,bytes32,bytes32)`. The destination
is the marketplace principal and the exact invoice subaccount. The helper sends
the USDC directly to the official minter; the marketplace needs no Ethereum
custody key, gas account or subsequent Ethereum sweep.

The canonical minter's `get_minter_info` must confirm the helper and the USDC to
ckUSDC ledger mapping. Its `is_address_blocked` result is checked before funding
and accepting early receipt evidence, because a successful helper call alone
does not guarantee that the minter will accept the sender. This follows the
minter's acceptance rules; it adds no EOA-only or same-wallet ownership rule.

## Early app access

The browser polls its ordinary Ethereum provider. When a successful deposit is
mined, it submits the original transaction hash through Neutron with the fixed
verification charge. The protocol independently reads the receipt and its
canonical block through the deployed EVM RPC canister, requiring agreement from
three configured providers. This is RPC-provider consensus, not a light-client
proof or Ethereum finality.

The verified helper event must bind all of:

- Ethereum chain 1 and canonical USDC;
- the official helper retained by the invoice;
- the saved funding address and marketplace principal;
- the invoice subaccount and exact gross amount;
- a successful receipt and matching transaction, block and log identifiers.

Unrelated events in the same transaction are not evidence for this invoice.
The exact event identity is consumed once and checked again with invoice state
after asynchronous verification. Granting ownership and recording its first
acquisition happen once. My Apps can then install the approved package through
the existing certified download workflow while conversion continues.

The fixed verification allowance is 50 billion cycles plus the ordinary purchase
processing charge. The current adapter assigns 5 billion to an 8 KiB receipt
response and 45 billion to a 256 KiB block response. Block responses contain the
transaction-hash list, so estimating only the header is insufficient. Cost
queries reject an outcall that would exceed its budget; they do not reprice the
customer's approved update. See the dated estimates in the
[primary-source research](references/ethereum-checkout.md).

## Conversion, collection and recovery

The official minter processes the deposit and mints ckUSDC to the invoice's
marketplace-owned subaccount. Its balance is isolated from every other invoice.
The protocol collects the price with one retained ICRC-1 request and stores the
ledger's successful response before applying revenue allocations. Finalization
retries use that saved result and never send another transfer after success.

No ledger-history scanner, ICRC-3 endpoint, debugging-only minter event feed,
personal RPC credential or historical balance/contract-state request is needed.
If the browser lost the Ethereum hash, successful collection from the isolated
invoice also provides a fully funded path to the original entitlement. It does
not invent the missing Ethereum transaction's identity.

Closing a tab, uninstalling the client, or losing a response does not delete the
invoice. Queries expose access, conversion, original receipts and accounting as
separate outcomes. Background settlement can continue independently of the UI.
Fee changes or unresolved ledger outcomes preserve the original obligations;
they never reduce developer allocations silently or create a replacement payment.

An invoice can be canceled before access is granted. Its identity and subaccount
remain retained, because an already-issued Ethereum deposit can still arrive.
Converted funds from canceled invoices and additional deposits become unapplied
ckUSDC credit for the buyer after collection. The buyer may withdraw that credit
through the ordinary withdrawal workflow. This does not refund a completed sale
or remove an existing app license.

## Validation

The required PocketIC cases cover early access with no minted balance, locked
earnings, eventual exact-once allocation, shared purchase reservations, rejected
or inconsistent Ethereum evidence, replayed events, concurrent continuations,
cancel-and-late-payment recovery, extra deposits, fee shortfalls and upgrades
across receipt retention and finalization. Official deployed interface metadata
and source inspection complement local fixtures; they do not constitute a paid
mainnet checkout test.
