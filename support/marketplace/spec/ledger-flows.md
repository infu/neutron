# Purchase and withdrawal ledger contract

## Small public surface

There are two public user-facing financial mutation entrypoints:

```text
purchase(requestId, immutablePurchaseIntent) -> PurchaseResult
withdraw(requestId, immutableWithdrawalIntent) -> WithdrawalResult
```

Each owns execution and continuation of its saved operation. Ordinary preparation
is a read-only quote. Retry means calling the same function with the same ID and
business intent. There are no separate public execute/continue/retry methods for
the same financial action.
Read-only quote, status, history and evidence methods remain available.

For mutations, `Access` uses the actual Neutron caller, with native cycles
attached through the existing Neutron broker. Registered browser read principals
can query that account's quotes, history and receipts directly; they cannot
dispatch purchases or withdrawals. The ledger payer is the Neutron account.
A caller-supplied alternative buyer is never authority.

An operation ID is unique within its authenticated account. Reusing it with
different cart selection, token, referral or recipient is a conflict. Explicitly
accepted quote/fee revisions may change only before dispatch, or after every
earlier attempt is proven to have no effect; an unknown attempt stays immutable.
Results include typed status, exact ledger error, retained attempt,
receipt/block if known, and a precise next action rather than a bare `retrySafe`.

## Purchase

The normal flow is **quote query → Wallet approval → one `purchase` update**.
The query returns exact terms and a canonical commitment/order-specific spender
derived from the resolved Neutron, operation ID and retained listing, rate, fee
and referral revisions. The browser retains that quote for Wallet review.

`purchase` recomputes and validates the accepted commitment before saving the
order/claims/ledger attempt and collecting. Query-supplied times are not authority
to extend quote validity; compare accepted revisions against retained timestamps
and the agreed current-state/validity policy. No query signature is needed for
collection correctness because the update validates its own authoritative state.

If approval is insufficient, the same function can return saved funding
instructions and later resume. It trusts the ledger collection result, not a
frontend's approval assertion. Querying an already-used ID returns its retained
operation/quote rather than suggesting another payment. A withdrawn audit approval
or changed cart/price returns a review requirement before any dispatch.

Already-owned items are removed before a new cart is priced/reviewed. A free cart
grants ownership without a ledger call. A basket has one payment token and one
collection, followed by one local entitlement per newly acquired app.

Use an order-specific spender subaccount bound to the immutable order commitment.
Pass the bare purchase amount to Wallet: its funding helper already adds the
collection fee to allowance, with the approval fee charged separately. Freeze
explicit `transferFrom` fields before awaiting: ledger, spender subaccount,
from/to accounts, amount, fee, memo and `created_at_time`.

Immediately before dispatch, recheck ownership and atomically claim each
`(Neutron, appId)` acquisition. Competing carts for the same app return the active
operation instead of collecting twice. Unrelated carts can proceed concurrently.
Quotes reserve nothing. Saved pre-dispatch approval-required orders hold no
acquisition claims, so abandoned preparation blocks nothing. If ownership changed
while awaiting approval, return ownership or a revised cart review without
charging the old total.

On exact `Ok` or `Duplicate` evidence, finalize in one await-free segment:

1. Verify the current saved attempt and existing finalization marker.
2. Record payment evidence and token-denominated developer/affiliate/burn credits.
3. Grant entitlements, append acquisition events and increment rankings once.
4. Replace acquisition claims with ownership and record completion.

If local finalization traps, the ledger payment still happened. The same operation
recovers its original payment and repeats only the local finalization. Late
callbacks cannot credit again or change complete back to failed.

## Withdrawal and daily forwarding

An immutable withdrawal intent contains token, destination, authorized total
debit and fee authority. Its normal preview is a query; one `withdraw` update
validates the accepted preview and reserves/sends. Review net received as
`totalDebit - transferFee`.
An “all” selection resolves to a reviewed total debit in the preview. Reservation
cannot exceed that authority; a changed available balance can require a new
review. Later earnings are not silently added during execution or retry.

Atomically reserve that account's debit before awaiting `icrc1_transfer`. Two
requests cannot spend the same available credit. A confirmed transfer consumes
its reservation once; a proven no-effect attempt can release it. Unknown outcomes
retain the reservation. Every retry rechecks current operation state rather than
writing back a balance snapshot captured before an await.

Daily forwarding uses this same internal withdrawal engine for the burn allocation,
with a durable day/token job identity and one of the three configured destinations.
It never sweeps developer or affiliate balances. Missing destinations or amounts
unable to cover their transfer fee remain allocated. Users pay only their agreed
fees; no other beneficiary subsidizes a withdrawal.

## Retry and error rules

Business operation identity and ledger attempt identity are distinct. Preserve
every dispatched attempt's exact fields. A successor attempt with changed fee,
timestamp or memo is allowed only after the predecessor is proved to have no
effect and the changed terms are within reviewed authority. Otherwise return a
fresh-review requirement through the same public function.

| Observation | Required behavior |
|---|---|
| `Ok(block)` or matching `Duplicate(duplicate_of)` | Complete that saved attempt once; retain exact block and duplicate evidence |
| Definite first-attempt insufficient funds/allowance | Return funding or approval instructions; retain the business operation |
| Definite no-effect `BadFee` | Refresh fee; require review/approval if needed before a successor attempt |
| `CreatedInFuture` | Respect the returned ledger time; do not churn creation timestamps while an outcome is uncertain |
| `TemporarilyUnavailable` or understood no-effect error | Return the typed error and allow exact continuation |
| Transport exception, lost/malformed reply or unknown call outcome | Preserve arguments and reservations; expose `outcome_unknown` |
| `TooOld`, `BadFee` or another error after an earlier unknown attempt | Do not treat it as proof the earlier transfer failed; reconcile that attempt |

Separate a temporary active driver from durable financial reservations. A second
call while that driver is running can return current progress. A caught transport
failure or an upgrade must leave an accessible continuation, not a permanent
“busy” marker. Driver recovery never releases funds just because time passed.
Ledger outcomes and finalization markers are merged monotonically under the
saved attempt identity.

The protocol's three supported ledgers need compatibility tests for actual
error/dedup behavior. The advisory documents explain stronger expectations and
edge cases; do not assume undocumented guarantees for an arbitrary ledger.

## Ledger evidence and ordinary-path simplicity

`Ledger.mo` contains small typed ICRC-1/2 calls and result normalization.
`LedgerEvidence.mo` handles exceptional reconciliation. Ordinary successful
purchases do not scan history or run an extra receipt search after `Ok`.

ICRC-1 does not define history retrieval. Use supported ICRC-3 ledger/archive
interfaces where available; ICP can require its native `query_blocks` adapter.
An index discovers candidates. Exact ledger evidence must match the saved
operation's accounts, amount, fee, memo and available timestamp/spender fields.
Missing fields cannot be invented. Balance changes or nearby transfers alone do
not prove this operation settled. Browser-read evidence requires the appropriate
certificate/hash verification; replicated ledger calls are a separate trusted
canister-call path.

Deduplication windows are ledger-defined. After an uncertain attempt becomes too
old to replay, retain its identity and inspect exact historical evidence. Do not
change its timestamp and call that a retry. The UI must distinguish actionable
known rejection, active processing and unresolved historical outcome.

## Acceptance tests

Cover all typed errors, duplicate replies, callback traps, response loss,
out-of-order callbacks, upgrade around every await, expired deduplication and
archived blocks. Exercise identical/conflicting IDs, overlapping baskets,
abandoned preparation, ownership acquired by another order, competing withdrawals
and forwarding concurrent with user payouts. Assert exact liabilities, one grant
and ranking event per app acquisition, one credit allocation per payment, and no
reservation released from an uncertain attempt.

See [upstream specifications and advisories](references/README.md),
[Wallet funding](../../../apps/wallet/src/funding.ts),
[Motoko await semantics](https://docs.internetcomputer.org/languages/motoko/fundamentals/actors/actors-async/),
and [IC retry guidance](https://docs.internetcomputer.org/guides/canister-calls/idempotency/).
