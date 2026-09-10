# Protocol acceptance tests

This acceptance plan distinguishes required coverage from the runnable suites
below. A category is verified only by its corresponding passing test result.
All fixtures run locally in disposable PocketIC instances; production installation
uses the separate ICP CLI workflow.

## Harness and reproducibility

Keep test drivers and fixtures under `support/marketplace/test/`. Each Ash suite
is a dedicated actor exposing only test entry points. The inspected runner
supports both queries and updates, runs methods sequentially within a suite,
and runs suites concurrently. It currently discovers all eligible zero-argument
returning methods, despite help text referring to `test_*` queries. Do not list
the production actor or ledger fixtures as test suites.

Run from the repository root:

```sh
npm --workspace neutron-marketplace-protocol run test:ash
npm --workspace neutron-marketplace-protocol run test:integration
```

`scripts/test-ash.ts` loads `test/protocol.ash.json` and discovers the remaining
`test/**/*.test.mo` suites. `scripts/test-integration.ts` runs the host cases.
Either script accepts a suite/name filter as its first argument. Generated local
IDs, build artifacts and runtime state are not production deployment evidence.

Use domain fixtures for deterministic arithmetic and error coverage, then test
the same production functions through real inter-canister calls. Dedicated
driver actors create isolated protocol, Neutron relay, ledger and oracle
fixtures. Suites must not depend on another suite's mutable state or execution
order. Async scenarios perform calls outside the synchronous `mo:test` metrics
helper and return the runner's supported metric result.

Ash has no existing CLI flags for upgrade scenarios, deferred message control
or clock advancement. The host driver uses Ash's PocketIC session for those
controls and HTTP certificate verification. Upgrade cases invoke a real Wasm
upgrade at the same canister principal, with no reinstall fallback.

`test/toolchain.json` pins the Ash source commit, runner/session hashes, PocketIC
server/client and Candid tool. The adapter reads that immutable Git snapshot from
the adjacent Ash checkout, or `MARKETPLACE_ASH_SOURCE`, into a temporary directory;
it does not run the older installed Ash executable or modify another checkout.
Its compiler adapter uses the same repository-pinned Motoko compiler and package
resolver as release builds. A pinned three-line transport patch fixes Ash's
partial-response busy loop; the production-sized streaming case exercises it.
Test installation uses gzip transport for the unchanged compiled module. The public actor test
prints its Wasm SHA-256. Missing tools or mismatched hashes fail the run.

Official-ledger host cases use the separately pinned provisioner ICRC ledger
Wasm with six- and eight-decimal configurations. The native ICP cases separately
install DFINITY's pinned `ledger-suite-icp-2025-08-29` Wasm at the canonical local
ledger principal. They verify order-specific spender subaccounts, 32-byte memos,
collection and withdrawal deduplication, concurrent balance reservations, and
successful-receipt recovery after actual payment-engine upgrades. The fixture
provenance is in [native-icp.md](../test/fixtures/native-icp.md). These tests do not
establish every historical or future ledger version's behavior. The protocol
does not use ledger-history or archive interfaces. Likewise, same-build upgrades prove
retained-state restoration; they do not replace immutable prior-release fixtures
and supported migration tests once a production version exists.

The certified repository suite includes two paid releases in one installation
selection, before and after a real upgrade. It verifies the legacy endpoint's
proof of package absence before the installer uses authenticated HTTP. This
reproduced a byte-label comparison bug in the pinned JavaScript IC client.
The shared reader now uses lexicographic lookup for the verified asset witness;
certificate signatures and root checks remain unchanged. Its regression keeps
the captured witness and rejects unresolved pruned ranges and contradictory
presence responses. Both real repository cases and all 406 SDK cases pass.

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

Test delayed guaranteed-response calls and a browser disconnect while the
canister is still processing: the original call must complete and its saved
status must be recoverable without a second dispatch. Separately inject a local
finalization trap after a successful ledger response; assert its block is already
durable and continuation completes accounting without another ledger call.

Scripted commit-then-reject behavior is an exceptional faulty-ledger fixture,
not a model of ordinary guaranteed response delivery. It tests conservative
handling of rejects, distinct from typed ICRC no-effect errors. Preserve its
exact arguments/reservations; `Duplicate` settles once, while a later `TooOld`
cannot prove nonexecution and requires review. There are no ledger-history
adapters or caller-provided receipt blocks in the production API.

Assert conservation separately for every token: available credits, reservations,
confirmed payouts, burn allocation and charged ledger fees. Do not mix USD price
units with token liabilities or subsidize one account's withdrawal from another.

## Ethereum checkout suites

The Ethereum extension has three layers of executable coverage:

- `evm-minter.test.mo`, `evm-rpc.test.mo` and `evm-evidence.test.mo` validate the
  official route, deployed Candid shapes, provider agreement, canonical blocks,
  and exact helper-event fields. Negative cases reject reverted, removed,
  inconsistent, wrong-recipient and wrong-amount evidence; unrelated events in
  the same transaction do not prevent finding the unique matching deposit.
- `host/evm-fixtures.integration.ts` calls the production clients through actual
  PocketIC canisters installed at the canonical fixture principals.
  `host/evm-payments.integration.ts` exercises early grants, locked earnings,
  shared IC/EVM claims, cancellation during awaits, blocked-payer changes,
  duplicate proofs, fee shortfalls, extra deposits, and funded fallback recovery.
  Real upgrades cover a saved Ethereum receipt before entitlement finalization
  and saved sweep receipts before sale or buyer-credit accounting, with no
  second RPC verification or transfer required after the saved success.
- `host/evm-marketplace.integration.ts` drives the actual public actor through
  a Neutron relay with attached cycles. It independently checks payment ABI
  fields, verifies a certified private download while the invoice's ckUSDC
  balance is zero, upgrades during conversion, and verifies collection and
  earnings once. Canceled-invoice deposits become buyer credit recoverable by
  the ordinary withdrawal endpoint. IC status/history cannot misclassify these
  invoices as ordinary IC purchases.

Client suites separately verify original-hash recovery, concurrent journal
updates, reviewed cycle charges, scoped Wallet authorization and numeric browser
wallet rejection codes. The app's PocketIC adapter test compares independently
encoded Motoko and TypeScript payment calldata. Browser fixtures exercise the
checkout at compact and wide tile sizes. These checks establish local protocol
and client behavior, not live wallet connectivity or mainnet financial delivery.

## Neutron identity, cycles and direct reads

Use a Neutron relay fixture to attach native cycles to every non-auditor update.
Test the authenticated canister caller, not a supplied `neutronPrincipal` field.
Ingress and a browser read delegate cannot impersonate that caller or attach
native cycles. Auditor exemption requires both an admin-assigned auditor
principal and an exempt auditor endpoint.

Test insufficient/excess attachments, fixed estimated per-call charges and
refund behavior, concurrent charged calls and lost replies. Observed usage or
changing cycle prices must not automatically change the protocol tariff.
Insufficient cycles must fail before a financial dispatch; an error must not
release an existing uncertain reservation. An auditor calling a non-exempt
endpoint follows the charged route. An unassigned principal cannot obtain the
audit exemption. Test admin assignment/removal and rejection reasons visible to
the publisher.

Upload/modify tests assert fixed processing charges for the declared work and
one year of prepaid storage/processing on upload. Verify byte counts against
actual accepted content before retaining uncovered data, and charge before
expensive processing. Resumable retries retain the original storage-charge
receipt and cannot charge the same coverage twice. Neither a byte-storage charge
nor its one-year period becomes a general browser mutation credit or a buyer
license expiry. After year one, assert continued package/source availability and
buyer ownership under operator-funded storage. No developer renewal charge or
automatic deletion occurs, including across an upgrade at that boundary.

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

`host/installed-lifecycle.integration.ts` runs this through the real assembled
Neutron and current source-selected Kernel/Marketplace archives. It purchases a
two-app basket once, downloads certified private packages, and uses checked
installation transactions. Registry reads and managed counters verify the
result. Uninstall/reinstall retains protocol ownership while retiring only the
uninstalled app's memory; removing Marketplace still permits grouped Settings
updates of the two paid apps, with their remaining state and installation
identities preserved. The fixture derives method types from each assembled
canister's generated Candid. It never substitutes an installer-offer mock for
the actual registry assertions.

Separate Marketplace browser tests exercise the physical tile handoff and
saved request recovery after lost replies and remounts. Their transport fixture
enforces the existing Kernel rule that an unscoped background process cannot
open an installer. Root and Normal agent invocations retain their scoped route.

## Prices, audits and rankings

Test list prices free, $1 and $50, with rejection of negative, fractional
micro-unit, nonzero sub-$1 and above-$50 inputs. A permitted referral discount can
make a $1 listing cost $0.90. Verify USD-to-token rounding, actual-paid splits,
fresh/stale rate handling and ledger fee changes against accepted terms. A failed
daily refresh continues to use the last successful rate with its age/error;
the absence of any initial valid rate cannot fabricate a quote. Test one universal
code per Neutron, global per-checkout attribution and self-referral rejection
before financial effects. Free and paid owners retain updates after price changes
and can each leave one editable rating per app; edits do not duplicate a rating.

Any Neutron can submit after paying the upload charge. An app/release appears
publicly after one assigned auditor's valid approval. A pending successor does
not replace an eligible approved release. Verify exact artifact
binding, publisher ownership, rejected reasons, corrected resubmission, and the
confirmed approval-revocation behavior. Revocation blocks existing ordinary
download grants/continuations while preserving buyer ownership and approved
replacement access; it dispatches no automatic refund. UI visibility must agree
with query and HTTP authorization.

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

`host/rankings-scale.integration.ts` additionally uses PocketIC's production
instruction limits with 5,000 apps and 25,020 first acquisitions. It checks all
six complete chart outputs, stale/current pagination and 25,000 weekly expiries
over 50 maintenance ticks. The observed maximum was 99,069,632 metered
instructions for expiry plus publication (0.248% of the 40-billion update
limit), and the largest observed full-message cycle debit including garbage
collection was 1,551,551,550 cycles. An unchanged maintenance tick still rebuilds
the charts and advances their generation; the test verifies the resulting old-
cursor rejection. These measurements establish headroom at this fixture scale,
not an unlimited-size performance guarantee or a catalog quota.

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
