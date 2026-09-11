# Architecture and domain boundaries

## Fixed requirements

One standalone canister owns catalog, packages, images, audit records,
Neutron-owned entitlements, orders, earnings and daily forwarding. The Neutron
canister principal is the durable account ID. The client does not introduce a
second user login or make a browser key the owner of purchases.

Package bytes are served through certified HTTP. Paid downloads require
entitlement; assigned publishers/auditors have access to their review materials.
The Kernel handles generic authenticated acquisition and its existing install
and update workflows. Marketplace business rules stay in this protocol.

## Browser authentication and routing

Use the existing signed IC browser-agent model with a recoverable read delegation:

1. The marketplace client automatically restores its Neutron/app-ID custody
   read key and authorizes the saved browser signing identity with an IC
   delegation targeted only to this protocol. The browser signs reads locally;
   it never receives the permanent root's private key.
2. A small owner-authorized update through the Neutron registers that permanent
   read principal with the protocol once and attaches the required native cycles. The
   protocol derives the account from the actual Neutron caller, not a submitted
   account-ID string.
3. The protocol persists a binding from browser principal to Neutron account and
   its granted read authority. Private queries resolve the signed caller through
   this binding. The browser delegate does not acquire update authority.
4. Library, checkout preview/status, publisher status and earnings queries go
   directly from browser to protocol. Ordinary user and publisher updates use the
   Neutron's existing backend-call capability with attached native cycles.
5. Reinstall restores the same permanent read principal. A fresh browser signer
   receives another targeted delegation automatically, without registering a
   replacement account. Version 109 preserves older browser signing seeds and
   adds the permanent principal without deleting their old protocol binding.
   Ownership, earnings and protocol journals remain under the Neutron account;
   app-local journals are removed by uninstall. Update-route permissions belong
   to the installed app instance and are restored at the first actual mutation.

Ordinary update methods authenticate the actual Neutron caller. Assigned CLI
auditors and administrators authenticate their own role principals at dedicated
exempt endpoints. Those endpoints can be called directly without attached
cycles; an existing canister admin remains valid. The admin exemption covers
exactly `admin_auditor_set`, `admin_reserve_app`, `admin_set_burn_account`, and
`rates_refresh`. Their retained `feeVersion` field is compatibility data, not a
funding requirement. No admin or auditor UI is part of the marketplace app.
A browser client cannot register itself for another account by knowing that
account's public ID.

The configured first-party publisher is a distinct CLI account: production uses
Blast ID 0 for initial app ownership and future releases. Its own publication
and earnings-withdrawal updates are cycle-exempt, and its exact checked releases
may be approved automatically. This narrow exception does not change
Neutron-owned purchases or grant other administrators the same publishing rights.

Session renewal/revocation and origin-isolated storage must be explicit and
recoverable. Do not introduce an arbitrary session expiry or repeatedly ask for
authorization on each query. A revoked read credential cannot access private
queries or downloads; its revocation does not delete purchases or undo completed
actions. Registering, replacing or revoking a delegate is an update and follows
the same caller-funded route.

Existing precedents: [Taggr browser integration](../../../apps/taggr/src),
[ICPSwap client](../../../apps/icpswap/src), and
[app runtime/storage contract](../../../doc/app-developer-guide.md). Reuse the
browser-agent and storage facilities, not Taggr's account-ownership semantics.

| Work | Route |
|---|---|
| Catalog, rankings, images, public audit reports | Browser directly to protocol |
| First browser read authorization or recovery | Small Neutron-to-protocol update with attached native cycles |
| Private library, checkout previews/progress, publisher status and earnings queries | Signed browser directly to protocol after read authorization |
| Ordinary purchases, withdrawals, listing edits, uploads and grant changes | Existing Neutron backend calls with native cycles attached to each update |
| Authorized auditor updates | Direct CLI-to-protocol calls; cycle-funding exemption |
| The four authorized admin endpoints | Direct CLI-to-protocol calls; cycle-funding exemption |
| Configured first-party publishing and withdrawal of its own earnings | Direct CLI-to-protocol calls; cycle-funding exemption |
| Approving payment from the Neutron Wallet | Existing Wallet tools and their authority/approval flow |
| Collection, payouts, daily XRC and forwarding | Protocol calls the ledgers/XRC |
| Package/source bytes | Browser directly to certified HTTP, with a source access grant |
| Settings source authorization without marketplace app | Generic Neutron repository-access broker; no marketplace app dependency |

There are no prepaid cycle credits or general browser-direct user mutations.
This also applies to upload chunks and recovery continuations that mutate state.
HTTP downloads and public/private queries stay browser-direct; returning a saved
operation status does not require an update. See
[cycles and queries](cycles-and-queries.md).

Normal agent mutation approval remains separate from browser authentication.
Agent handlers use existing invocation authority and reviewed-action behavior;
possession of a browser session is not permission to bypass normal-mode approval.
Root agents follow existing root authority. Wallet funding remains subject to
Wallet's own normal/root interface.

## Persistent state and domain modules

Proposed structure under `support/marketplace/`:

```text
icp.yaml                    # future standalone canister project
mo/main.mo                 # caller capture and Candid entrypoints
mo/Context.mo              # shared domain dependencies and external services
mo/Catalog.mo              # listings, list-price bounds, visible catalog
mo/Publishing.mo           # publisher ownership, uploads, release submission
mo/Audits.mo               # assigned reviewers, exact-release verdicts
mo/BatchPublishing.mo      # trusted first-party atomic release batches
mo/Access.mo               # Neutron identity, browser read delegates and resource grants
mo/Purchases.mo            # one public purchase operation and its continuation
mo/Entitlements.mo         # durable library and acquisition claims
mo/Accounting.mo           # synchronous credits, splits and reservations
mo/Billing.mo              # fixed cycle estimates, upload coverage and charge receipts
mo/Withdrawals.mo          # one public withdrawal and internal forwarding
mo/Ledger.mo               # one typed ICRC call/error adapter
mo/Pricing.mo              # USD/rate arithmetic, daily XRC snapshots
mo/Rankings.mo             # acquisition counters and rolling expiry
mo/Referrals.mo            # codes and frozen referral attribution
mo/Ratings.mo              # entitled reviews and rating summaries
mo/Assets.mo               # immutable artifact identity and stored content
mo/Retention.mo            # retire unreferenced superseded package/source content
mo/Http.mo                 # certified HTTP and authorized streaming
mo/Jobs.mo                 # timer rescheduling and domain job dispatch
migrations/                # immutable supported predecessors and transitions
scripts/                   # publisher/auditor CLI and release evidence
test/                      # local protocol, browser and upgrade fixtures
```

This is a responsibility map, not a requirement to split every small helper into
another file. Keep one ledger adapter and one accounting implementation shared by
purchases, withdrawals and daily forwarding. `main.mo` should remain wiring.

Internal persistent storage retains domain records, immutable content and
unfinished operation journals. Its implementation is outside this specification.
Only current approved and pending-review package/source content is retained;
superseded bytes are removed without deleting purchases or audit history.

Purchase success orchestrates accounting, entitlement and ranking changes in one
await-free segment. Lower-level accounting and ranking modules never initiate
payments. Timer code delegates to the same domain functions instead of keeping a
second financial implementation.

Preserve the external ledger attempt so interrupted finalization can be repeated
without paying again. Upgrade tests must preserve balances, entitlements,
artifact identities and unresolved operations.

The standalone protocol is proprietary, with all rights reserved. Its future
Neutron client uses the repository's standard `LICENSE.APP` packaging workflow;
the client's license does not license the standalone protocol.

## Confirmed product rules and remaining setup

Acquisitions include future approved updates despite price changes; revocation
blocks ordinary downloads but preserves the entitlement for approved replacements.
There are no automatic refunds initially. Free and paid owners can leave one
editable rating per Neutron/app. Each Neutron has one universal referral code,
with global terms; self-referrals are rejected. The app remembers an activated
code for future checkouts and lets the user change or clear it. The protocol
retains attribution per purchase, so a later preference change does not alter an
existing payment. `referral_quote(code)` is a signed read-only query that returns
the canonical code, affiliate principal, discount basis points and terms version
for the authenticated Neutron. It rejects empty, unregistered and self-referral
codes without creating a referral, purchase or ledger request.

Any Neutron can submit a package. One assigned auditor approval suffices, with
required rejection reasons as described in [audits](audits.md). Failed daily
price refresh uses the last valid rate with freshness diagnostics.

Fixed estimated cycle charges fund updates and uploads; uploading prepays one
year of storage and processing. The initial coefficients and admin/auditor
principals still need configuration, and the three forwarding accounts will be
supplied later. After the prepaid first year, the operator funds storage.
Developers do not need to renew, and current packages and buyer ownership remain available.
The operator funds first-party publishing from the configured Blast ID 0 account.
No new Kernel policy limits are part of this design.
