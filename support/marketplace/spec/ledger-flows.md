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
Read-only quote, status and operation history expose the saved write receipts.

For mutations, `Access` uses the actual Neutron caller, with native cycles
attached through the existing Neutron broker. Registered browser read principals
can query that account's quotes, history and receipts directly; they cannot
dispatch purchases or withdrawals. The ledger payer is the Neutron account.
A caller-supplied alternative buyer is never authority. Protocol cycle charges
use fixed rough cost estimates; they are distinct from the token ledger's actual
approval/transfer fees and from the USD app price.

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

Daily XRC refresh failure keeps the last successful rate usable, without an
age-based purchase cutoff. Quotes expose its observation time, age and refresh
error. If no successful rate exists yet, pricing is unavailable. A successful
later refresh can change the accepted checkout amount and require fresh review;
continuing to use the last known rate is not authority to accept arbitrary
client-supplied rates or backdated quotes.

Resolve a per-checkout universal affiliate code and apply the global split to
the actual amount paid. Reject a self-referral when code owner equals the
authenticated buyer Neutron before Wallet funding or collection.

If approval is insufficient, the same function can return saved funding
instructions and later resume. It trusts the ledger collection result, not a
frontend's approval assertion. Querying an already-used ID returns its retained
operation/quote rather than suggesting another payment. A withdrawn audit approval
or changed cart/price returns a review requirement before any dispatch.

Already-owned items are removed before a new cart is priced/reviewed. A free cart
grants ownership without a ledger call. A basket has one payment token and one
collection, followed by one local entitlement per newly acquired app.
Both paid and free ownership include future approved updates, including after
price changes. Release revocation blocks ordinary package downloads but preserves
ownership for an approved replacement. No automatic refund is dispatched.

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
| Exceptional reject, malformed ledger reply or protocol callback failure before a receipt is retained | Preserve arguments and reservations; expose `outcome_unknown` |
| `TooOld`, `BadFee` or another error after an earlier unknown attempt | Do not treat it as proof the earlier transfer failed; reconcile that attempt |

Separate a temporary active driver from durable financial reservations. A second
call while that driver is running can return current progress. An exceptional rejected call
or an upgrade must leave an accessible continuation, not a permanent
“busy” marker. Driver recovery never releases funds just because time passed.
Ledger outcomes and finalization markers are merged monotonically under the
saved attempt identity.

The protocol's three supported ledgers need compatibility tests for actual
error/dedup behavior. The advisory documents explain stronger expectations and
edge cases; do not assume undocumented guarantees for an arbitrary ledger.

## Guaranteed responses and retained receipts

`Ledger.mo` uses ordinary unbounded-wait Motoko calls to the configured ledgers:
ICRC-2 `transferFrom` for purchases and ICRC-1 `transfer` for payouts. These calls
have the IC's guaranteed-response semantics. A disconnected browser does not
cancel the call or erase the marketplace's response. Reopening the app reads the
saved operation; it does not search a ledger or create another payment.

Store the ledger's `Ok(block)` or `Duplicate(block)` response before entering a
separate finalization message. If entitlement/accounting finalization traps, the
returned block survives. Continuing the same ID completes local finalization
without another ledger transfer. An active call returns its progress and is not
redispatched by a concurrent continuation.

The protocol has no ICRC-3, native ledger-history or archive lookup adapters, and
accepts no caller-supplied block as payment proof. Transaction receipts come from
the ledger's original typed write response. This keeps purchase and withdrawal
recovery within the original call and durable journal.

A guaranteed response can also be a reject. Exceptional ledger/protocol errors
must not be confused with typed ICRC no-effect results. Preserve the original
attempt after an ambiguous reject; exact deduplicated continuation cannot change
its timestamp, memo or amount. If such an exceptional attempt exceeds the
ledger's retry window, stop with `review_required` instead of inventing success,
releasing reserved funds or attempting a replacement payment.

See [guaranteed-response calls](https://docs.internetcomputer.org/guides/canister-calls/inter-canister-calls/)
and [callback transaction boundaries](https://docs.internetcomputer.org/guides/security/inter-canister-calls/).

## Acceptance tests

Cover typed errors, duplicate replies, delayed guaranteed responses, browser
disconnection, callback/finalization traps, rejected calls, upgrade recovery and
expired deduplication. Do not model ordinary IC response delivery as best effort. Exercise identical/conflicting IDs, overlapping baskets,
abandoned preparation, ownership acquired by another order, competing withdrawals
and forwarding concurrent with user payouts. Assert exact liabilities, one grant
and ranking event per app acquisition, one credit allocation per payment, and no
reservation released from an uncertain attempt.

See [upstream specifications and advisories](references/README.md),
[Wallet funding](../../../apps/wallet/src/funding.ts),
[Motoko await semantics](https://docs.internetcomputer.org/languages/motoko/fundamentals/actors/actors-async/),
and [IC retry guidance](https://docs.internetcomputer.org/guides/canister-calls/idempotency/).
