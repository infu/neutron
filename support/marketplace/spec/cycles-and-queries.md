# Query-first access and caller-funded updates

## Confirmed policy

Use HTTP and queries for reads wherever possible. **Every non-auditor update goes
through the Neutron with native cycles attached.** The owner selected this over
prepaid credits. Authorized auditor review updates are exempt and can be sent
directly by assigned auditor CLI identities. There is no prepaid cycle-balance
feature or general direct-browser mutation route in this design.

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
| Purchase/withdrawal preview from retained rates/fee observations | Direct query; mutation validates accepted terms |
| Package and offered-source bytes | Direct authorized certified HTTP |
| Purchase/free claim, withdrawal, listing change, rating, upload chunks | Neutron update with attached cycles |
| Browser read binding or source grant that writes authorization | Neutron update with attached cycles |
| Add auditor/admin configuration | Admin-authorized Neutron update with attached cycles |
| Auditor stamp and auditor-only access issuance | Direct assigned-auditor update, exempt from caller cycle charges |

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

Auditor exemption checks both the assigned principal and the audit endpoint.
Auditor principals using unrelated update methods follow the normal charged
route. A browser read delegation never authorizes paid direct updates.

## Fixed estimated fees and acceptance

Use a fixed fee schedule with coefficients measured and chosen before release.
Ordinary methods have fixed estimated operation costs; uploads and modifications
use fixed coefficients for their declared bytes and processing work. Larger
uploads can therefore cost more without dynamically adjusting the coefficients.
Do not auto-adjust prices, meter live execution into a changing bill, or derive
fees from the canister's current cycle balance. Record the fixed coefficient-set
identifier in quotes and charge receipts so accepted estimates stay reproducible.

Expose the applicable estimate and its components through a query. An update
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

Each non-auditor update still attaches cycles through Neutron. Its fixed estimate
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

Daily XRC, forwarding, ranking expiry, storage and exempt auditor work have no
current paying external caller. The one-year publication allocation funds its
app storage/processing scope. Account for shared jobs and exempt review work in
the initial fixed cost estimates; storage beyond the first year is funded by the
operator. Initial reserve sizing is deployment configuration, not a dynamic fee
adjustment. These costs cannot silently consume sale-token liabilities or trigger
new developer renewal charges.
Requiring payment for state-changing work does not make unauthenticated rejected
ingress or passive storage costless.
Ledger approval/transfer fees remain separate from protocol cycle fees and cannot
be silently used as their substitute.

## Acceptance tests

Test missing/insufficient/excess attachments, fixed schedule versions,
accepted/refunded accounting, direct browser mutation rejection, private queries and HTTP without
attachments, auditor endpoint/role combinations, concurrent calls, response loss,
ledger retry idempotency and upgrades with in-flight operations. A cycle error
must never clear an unresolved financial reservation.

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
