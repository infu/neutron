# Protocol acceptance tests

This is a draft test plan. No marketplace protocol, fixture suite or test result
is implemented by this document. Use Ash with PocketIC for disposable local
tests; use the separate ICP CLI workflow for production installation.

## Harness and reproducibility

Keep test drivers and fixtures under `support/marketplace/test/`. Each Ash suite
is a dedicated actor exposing only test entry points. The inspected runner
supports both queries and updates, runs methods sequentially within a suite,
and runs suites concurrently. It currently discovers all eligible zero-argument
returning methods, despite help text referring to `test_*` queries. Do not list
the production actor or ledger fixtures as test suites.

The proposed ordinary command is:

```sh
ash test support/marketplace/test/protocol.ash.json --verbose
```

The config and suites are future implementation work. Use `--set` only to record
an intentional performance baseline after correctness passes. Generated local
IDs, build artifacts and runtime state are not production deployment evidence.

Use domain fixtures for deterministic arithmetic and error coverage, then test
the same production functions through real inter-canister calls. Dedicated
driver actors create isolated protocol, Neutron relay, ledger and oracle
fixtures. Suites must not depend on another suite's mutable state or execution
order. Async scenarios perform calls outside the synchronous `mo:test` metrics
helper and return the runner's supported metric result.

Ash has no existing CLI flags for upgrade scenarios, deferred message control
or clock advancement. Add a thin host driver using the Ash PocketIC session for
those controls and for HTTP certificate verification. Do not describe these as
already-supported `ash test` flags or substitute reinstall for an upgrade.

Before implementing the suite, pin and verify the actual Ash, PocketIC, Motoko,
Candid-tool and official ledger fixture versions/hashes. The inspected local Ash
checkout and older installed executable are not known to match; this is an open
toolchain task. Record the compiled protocol Wasm hash with test results and
verify the release build uses the tested compiler options.

## Financial operations

Exercise the production `purchase` and `withdraw` functions through scripted
ledger interfaces and real official ledger Wasm fixtures for ICP, ckBTC and
ckUSDC compatibility. A fixture must model caller/subaccount ownership, allowance,
fees, exact memo/time deduplication and actual applied effects. Assertions compare
ledger effects and retained accounting, not only response wording.

| Case | Required evidence |
|---|---|
| Normal paid basket | One collection; correct fee charged to buyer; one entitlement/event per newly acquired app; allocations sum exactly to collected token amount |
| Free or already-owned app | No collection; retry/reinstall does not add another acquisition |
| Same ID, same intent | Original outcome returned or continued; no second financial effect |
| Same ID, changed intent | Conflict before dispatch; original record remains recoverable |
| Concurrent identical calls | At most one active dispatch/finalization; other callers receive current progress |
| Overlapping baskets | Same Neutron/app cannot be charged twice through competing orders; unrelated baskets remain independent |
| Abandoned preparation | No acquisition reservation blocks another purchase before dispatch |
| Concurrent withdrawals | Reservations cannot exceed available token credit; later earnings are not silently included in an earlier withdrawal |
| Daily forwarding with user payouts | Only the burn allocation is spent; each beneficiary covers its own fee |

Cover all actual ICRC result variants used by the supported ledgers, including
`Duplicate`, `BadFee`, `InsufficientFunds`, `InsufficientAllowance`, `TooOld`,
`CreatedInFuture`, `TemporarilyUnavailable` and `GenericError`. Approval fixtures
also cover expected-allowance changes and expiration. Validate amounts using the
vendored [ledger standards and advisories](references/README.md).

For each external await, test rejection before an effect, committed effect with
a lost response, delayed response, malformed reply, local finalization failure
and late/out-of-order callbacks. A ledger trap before commit is not a substitute
for a committed transfer whose reply was lost. Retrying uncertainty preserves the
exact ledger attempt arguments and its reservation. A later `TooOld` or `BadFee`
must not erase an earlier unknown effect. Verified `Duplicate` completes the
matching attempt once. Exact ledger/archive evidence, not a matching balance or
index candidate alone, resolves exceptional historical outcomes.

Assert conservation separately for every token: available credits, reservations,
confirmed payouts, burn allocation and charged ledger fees. Do not mix USD price
units with token liabilities or subsidize one account's withdrawal from another.

## Neutron identity, cycles and direct reads

Use a Neutron relay fixture to attach native cycles to every non-auditor update.
Test the authenticated canister caller, not a supplied `neutronPrincipal` field.
Ingress and a browser read delegate cannot impersonate that caller or attach
native cycles. Auditor exemption requires both an admin-assigned auditor
principal and an exempt auditor endpoint.

Test insufficient/excess attachments, changed accepted fee version, the agreed
per-call charge/refund behavior, concurrent charged calls and lost replies.
Insufficient cycles must fail before a financial dispatch; an error must not
release an existing uncertain reservation. An auditor calling a non-exempt
endpoint follows the charged route. An unassigned principal cannot obtain the
audit exemption. Test admin assignment/removal and rejection reasons visible to
the publisher.

Verify browser-direct public catalog, rankings, images and status queries need
no Neutron backend call. Private library, earnings and publisher reads resolve a
valid read delegation to the owning Neutron and reveal no other Neutron's data.
Spoofed owners, wrong keys and invalid or superseded grants fail. Test the agreed
credential lifecycle without inventing additional expiration or access policy.
Read credentials never authorize direct paid mutations. Querying progress must
not dispatch a transfer, create ownership or charge an update fee.

## Certified buyer-only HTTP

Verify responses using the actual certificate verifier, not only an actor's
returned hash. Test owned paid artifacts, free/public artifacts, authorized
publisher/auditor inspection of pending releases, and unauthorized access.
Certified package and offered-source bytes must match their exact reviewed
digest and size.

Cover altered bodies, paths, status, relevant headers and witnesses; Authorization
CORS/preflight; streaming continuation scope; resumable downloads; and range
responses if implemented. A continuation for one artifact or credential must not
read another. Test cache separation between buyers and non-buyers and ensure
legacy/debug/chunk endpoints do not bypass ownership checks. Reads remain HTTP
or queries: no package-byte proxy through Neutron and no HTTP-to-update upgrade
merely to download bytes.

Exercise batch installation and Settings upgrades through the generic source
transport, including after marketplace app uninstall. A presented install offer
is not successful installation; confirm the resulting installed registry. A
failed download must preserve the installed app and its state.

## Prices, audits and rankings

Test list prices free, $1 and $50, with rejection of negative, fractional
micro-unit, nonzero sub-$1 and above-$50 inputs. A permitted referral discount can
make a $1 listing cost $0.90. Verify USD-to-token rounding, actual-paid splits,
fresh/stale rate handling and fee changes against accepted terms.

An app/release appears publicly only after the required audit approval. A pending
successor does not replace an eligible approved release. Verify exact artifact
binding, publisher ownership, rejected reasons, corrected resubmission, and the
agreed approval-revocation behavior. UI visibility must agree with query and HTTP
authorization.

For all six charts, compare incremental results to a complete event-derived
oracle in tests. Count distinct Neutrons acquiring each app, never retries,
downloads, updates or reinstalls. Cover one basket acquiring several apps,
different Neutrons, free/paid classification and price-tier changes.

At time `T`, verify the exact rolling window `(T-W, T]` for both 7 and 30 days,
including equal-timestamp boundary events. Exercise expiry interruptions,
acquisitions during catch-up, stable ties, delisting, rank falls exposing the
next app, and pagination within a coherent generation. Current audit revocation,
delisting or tier changes must filter stale snapshot entries immediately without
duplicating or skipping other eligible entries across pages. A lagging chart reports
its actual `asOf`; partially expired aggregates must not be presented as current.
All-time counts survive expiry and restart.

## Initialization, upgrades and release evidence

Test clean initialization without production data or keys. Once a production
version exists, preserve its immutable fixture and test each supported upgrade
path, including skipped versions, at the same canister principal. Upgrade
failures fail the test; no fallback reinstall or reset is acceptable.

Populate representative entitlements, acquisition events, credit/reservations,
ledger attempts, roles, approved/rejected releases, package/source/image bytes,
upload progress, read grants, rates and daily jobs. Compare observable state and
artifact bytes before/after upgrade. Resume original uncertain operations without
new payment identities. Verify timer re-registration and idempotent daily work,
ranking catch-up and retained certificate access after upgrade.

Keep public documentation and artifacts free of proprietary database internals
and configuration. Verify `ashroot.json` is ignored and absent from tracked files
and distributed artifacts. Release checks also verify the agreed all-rights-
reserved protocol notice and the Neutron app's standard license/notice workflow.

Report domain assertions, real ledger/inter-canister tests, certificate checks,
upgrade tests and frontend/install tests separately. A passing fresh install or
mock-ledger test does not establish the other categories. No mainnet financial
action is implied by this acceptance plan.
