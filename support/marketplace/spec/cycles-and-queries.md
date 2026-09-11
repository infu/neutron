# Query-first access and caller-funded updates

## Confirmed policy

Use HTTP and queries for reads wherever possible. **Ordinary user and publisher
updates go through Neutron with native cycles attached.** The owner selected
this over prepaid credits. Authorized audit updates and exactly four admin
endpoints are exempt and accept direct authenticated CLI calls:
`admin_auditor_set`, `admin_reserve_app`, `admin_set_burn_account`, and
`rates_refresh`. There is no prepaid cycle balance or general direct-browser
mutation route. The app has no admin or auditor UI.

The configured first-party publishing principal has a separate, explicit
exception. Production uses Blast ID 0, which owns the initial listings. Its
publishing calls, including future releases, and withdrawals of its own earnings
are direct CLI updates without attached cycles. Its exact checked releases can
be approved automatically in an atomic batch. This authority comes from the
configured principal, not general admin or auditor membership. Other publishers
still pay the normal charges and require an assigned auditor.

Any Neutron may publish. Its developer pays attached cycles for uploads and
modifications using fixed, rough processing-cost estimates. Upload charges also
prepay one year of the app's storage and processing. After year one, the operator
funds storage, with no developer renewal requirement. These charges deter costly
unfunded writes; they do not introduce a publisher allowlist or ownership quota.

Ordinary browser query execution is currently uncharged in cycles. Storage/idle
costs, timers, certification writes, XRC and replicated inter-canister work still
need service funding. A query method called from an update is evaluated through
replication; it is not the free browser-query route.

| Operation | Route |
|---|---|
| Catalog, rankings, listing details, images, public audit reports | Direct HTTP/query |
| Library, order status, earnings, publisher review status | Direct signed query resolving the Neutron's read delegate |
| Discount-code activation/validation (`referral_quote`) | Direct signed query resolving the Neutron's read delegate; no cycles attached |
| Purchase/withdrawal preview from retained rates/fee observations | Direct query; mutation validates accepted terms |
| Package and offered-source bytes | Direct authorized certified HTTP |
| Purchase/free claim, withdrawal, listing change, rating, upload chunks | Neutron update with attached cycles |
| Browser read binding or source grant that writes authorization | Neutron update with attached cycles |
| `admin_auditor_set`, `admin_reserve_app`, `admin_set_burn_account`, `rates_refresh` | Direct assigned-admin update, exempt from caller cycle charges |
| Auditor stamp and auditor-only access issuance | Direct assigned-auditor update, exempt from caller cycle charges |
| Configured first-party publishing and withdrawal of its own earnings | Direct CLI update, exempt from caller cycle charges |

Do not create updates for page views, download counts or status polling. Rankings
come from entitlement finalization. Prefer quote query → Wallet approval → one
purchase update; a successful ordinary purchase needs no ledger-history scan.
Read saved outcomes through queries, rather than repeatedly invoking a paid
mutation just to retrieve its result.

## Existing native-cycle transport

Browser ingress cannot attach native cycles. Neutron's existing `backend_calls`
broker already attaches `request.cycles` to an inter-canister call and accounts
for accepted versus refunded cycles. Declare the exact protocol methods and
appropriate agreed budgets in the marketplace manifest. No new Kernel cycle
mechanism, marketplace policy or proxy canister is needed.

The same broker can carry typed update calls and publisher upload chunks. Keep
query/HTTP bytes out of it. Charged writes necessarily incur this backend hop
under the selected policy; do not disguise a direct browser write as an attached-
cycle call. Generic repository authorization uses the same principle and works
without the marketplace app installed.

Role exemptions check the actual assigned principal and the endpoint. Admin or
auditor principals using ordinary update methods follow the normal Neutron
route unless the caller is also the explicitly configured first-party publisher
using that separate exception. A browser read delegation never authorizes direct mutations. The four
admin methods retain `feeVersion` for Candid compatibility but perform no cycle
funding/fee-version check; any cycles attached by a canister caller remain
unaccepted and refunded. Existing canister admin principals stay valid alongside
explicitly configured CLI admin principals.

## Fixed estimated fees and acceptance

Use a fixed fee schedule with coefficients measured and chosen before release.
Ordinary methods have fixed estimated operation costs; uploads and modifications
use fixed coefficients for their declared bytes and processing work. Larger
uploads can therefore cost more without dynamically adjusting the coefficients.
Do not auto-adjust prices, meter live execution into a changing bill, or derive
fees from the canister's current cycle balance. Record the fixed coefficient-set
identifier in quotes and charge receipts so accepted estimates stay reproducible.

Expose the applicable estimate and its components through a query. A charged update
authenticates the actual Neutron, validates the accepted fee version/budget and
attached amount, then accepts the applicable fee before expensive processing,
retention or financial dispatch. Validate uploaded sizes against the quoted
artifact commitment; an understated size cannot authorize extra unpaid storage
or work. Leave surplus cycles unaccepted so the platform refunds them through
the Neutron's normal accounting.

`Billing.mo` owns fee validation, acceptance and charge receipts. It does not keep
another token treasury or prepaid credit ledger. Concurrent calls must associate
charges/refunds with their own invocation; a global cycle-balance difference
across an await is not an accurate per-call bill.

The public purchase/withdrawal operation remains idempotent even if resending its
update incurs another computation charge. Cycle charges and app-sale/payout
amounts are separate. Return both clearly. Exact fixed coefficients and charges
for actual retry work still need measured initial values and agreement; this
specification selects no numeric tariff or new platform quota.

Use the existing unbounded broker behavior for calls carrying cycles rather than
introducing a bounded timeout that can lose attachments/refunds on an unknown
outcome. A lost frontend reply resumes the existing Neutron/protocol operation;
it is not authorization to create a second purchase or withdrawal.

## One-year upload allocation and resumable charges

An upload quote identifies the app/artifacts, expected bytes and work, fixed
schedule version, processing charge and one-year storage allocation. Record the
accepted charge, covered artifacts/bytes and coverage dates with the durable
upload identity. This is a payment for that upload's storage and processing,
not a spendable per-Neutron credit balance and not permission for direct-browser
updates.

Accept the applicable allocation before retaining the paid upload data or doing
its expensive processing. Resume using the same upload identity, artifact
commitments and saved charge receipts after interruption or upgrade. A repeated
begin/finalize request or retransmitted chunk cannot charge the same one-year
allocation again or restart its coverage period. Concurrent continuations share
the retained receipt rather than each accepting another allocation.

Each ordinary upload update still attaches cycles through Neutron. Its fixed estimate
distinguishes any per-invocation processing charge from storage/processing already
covered by the upload receipt. Repeated requests may pay the agreed handling
charge, but do not purchase the same covered work or storage twice. A modification
quote likewise identifies its processing and any newly covered storage instead
of silently rebilling an existing allocation.

After the prepaid first year, the operator funds continued storage. There is no
developer renewal charge, package/source deletion or expiry of buyer ownership
and download rights at that boundary. Preserve the original coverage record for
accounting while retained content continues under operator funding. Later uploads
and modifications still pay their applicable fixed estimated charges for new work.

## Background work and operating costs

Daily XRC, forwarding, ranking expiry, storage and exempt admin/auditor work have no
current paying external caller. The one-year publication allocation funds its
app storage/processing scope. Account for shared jobs and exempt review work in
the initial fixed cost estimates; storage beyond the first year is funded by the
operator. The operator also funds exempt first-party publishing and withdrawal
processing; ledger transfer fees still come from the withdrawing beneficiary.
Initial reserve sizing is deployment configuration, not a dynamic fee
adjustment. These costs cannot silently consume sale-token liabilities or trigger
new developer renewal charges.
Requiring payment for state-changing work does not make unauthenticated rejected
ingress or passive storage costless.
Ledger approval/transfer fees remain separate from protocol cycle fees and cannot
be silently used as their substitute.

## Acceptance tests

Test missing/insufficient/excess attachments, fixed schedule versions,
accepted/refunded accounting, direct browser mutation rejection, private queries and HTTP without
attachments, admin/auditor endpoint and role combinations, concurrent calls, response loss,
ledger retry idempotency and upgrades with in-flight operations. A cycle error
must never clear an unresolved financial reservation.

Cover all four admin methods through direct authenticated ingress without
cycles, including existing canister admins, unauthorized callers, retained
`feeVersion` arguments, and unaccepted surplus attachments. These exemptions
must not extend to purchases, publisher changes, uploads, or withdrawals.

Test the separate first-party exception with the exact configured identity and
with other admins, auditors, publishers and browser delegates. Only that identity
can publish without cycles, approve its own checked release batch, or withdraw
its own earnings directly. The same withdrawal accounting and retry handling
must apply; the exception must not create access to another account's earnings.

Verify that any Neutron can enter the publisher flow and pays the quoted fixed
processing/storage estimate. Cover upload-size mismatches, charge-before-retention,
resumed and concurrent uploads, repeated chunks/finalization, modifications with
existing coverage, and upgrade-restored receipts. A retry must not duplicate the
one-year allocation or extend its dates. Fee coefficients must not change from
live metering. Crossing the coverage end must retain package/source availability
and buyer ownership under operator-funded storage, without a developer renewal
charge. Repeat across an upgrade at the boundary.

References:

- [Neutron backend call types](../../../packages/neutron-motoko-capabilities/src/lib.mo)
- [Existing cycle-attachment transport](../../../apps/kernel/backend/backend_calls/Raw.mo)
- [IC cycles](https://docs.internetcomputer.org/concepts/cycles/)
- [Inter-canister cycles](https://docs.internetcomputer.org/guides/canister-calls/inter-canister-calls/)
- [Execution properties](https://docs.internetcomputer.org/references/message-execution-properties/)
- [Cycle costs](https://docs.internetcomputer.org/references/cycle-costs/)
- [IC system API](https://docs.internetcomputer.org/references/ic-interface-spec/canister-interface/)
