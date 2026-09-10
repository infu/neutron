# Query-first access and caller-funded updates

## Confirmed policy

Use HTTP and queries for reads wherever possible. **Every non-auditor update goes
through the Neutron with native cycles attached.** The owner selected this over
prepaid credits. Authorized auditor review updates are exempt and can be sent
directly by assigned auditor CLI identities. There is no prepaid cycle-balance
feature or general direct-browser mutation route in this design.

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

## Simple acceptance and billing

Expose the versioned operation fee through a query. An update authenticates the
actual Neutron, validates the accepted fee version/budget and attached amount,
then accepts the applicable cycle fee before chargeable domain work. Reject
insufficient attachments before financial dispatch. Leave surplus cycles
unaccepted so the platform refunds them through the Neutron's normal accounting.

`Billing.mo` owns fee validation, acceptance and charge receipts. It does not keep
another token treasury or prepaid credit ledger. Concurrent calls must associate
charges/refunds with their own invocation; a global cycle-balance difference
across an await is not an accurate per-call bill.

The public purchase/withdrawal operation remains idempotent even if resending its
update incurs another computation charge. Cycle charges and app-sale/payout
amounts are separate. Return both clearly. Exact fee values and treatment of
real retry work remain to be agreed; no numeric tariff, refill threshold or new
platform quota is selected here.

Use the existing unbounded broker behavior for calls carrying cycles rather than
introducing a bounded timeout that can lose attachments/refunds on an unknown
outcome. A lost frontend reply resumes the existing Neutron/protocol operation;
it is not authorization to create a second purchase or withdrawal.

## Background work and operating costs

Daily XRC, forwarding, ranking expiry, storage and exempt auditor work have no
current paying external caller. Fund their reserve through an explicitly agreed
update/publication tariff or operator funding. Requiring payment for state-changing
work does not make unauthenticated rejected ingress or passive storage costless.
Ledger approval/transfer fees remain separate from protocol cycle fees and cannot
be silently used as their substitute.

## Acceptance tests

Test missing/insufficient/excess attachments, fee changes, accepted/refunded
accounting, direct browser mutation rejection, private queries and HTTP without
attachments, auditor endpoint/role combinations, concurrent calls, response loss,
ledger retry idempotency and upgrades with in-flight operations. A cycle error
must never clear an unresolved financial reservation.

References:

- [Neutron backend call types](../../../packages/neutron-motoko-capabilities/src/lib.mo)
- [Existing cycle-attachment transport](../../../apps/kernel/backend/backend_calls/Raw.mo)
- [IC cycles](https://docs.internetcomputer.org/concepts/cycles/)
- [Inter-canister cycles](https://docs.internetcomputer.org/guides/canister-calls/inter-canister-calls/)
- [Execution properties](https://docs.internetcomputer.org/references/message-execution-properties/)
- [Cycle costs](https://docs.internetcomputer.org/references/cycle-costs/)
- [IC system API](https://docs.internetcomputer.org/references/ic-interface-spec/canister-interface/)
