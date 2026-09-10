# Publishers, auditor principals and stamps

## Authority

An admin function adds auditor principals. The protocol checks the authenticated
admin account; knowing an admin principal or passing an `auditor` flag grants no
authority. Auditor CLI calls authenticate as an assigned principal. Any client
delegation used for a role must be explicitly authorized through the account
model, not supplied as an unverified acting-as field.

Auditor review endpoints are exempt from caller cycle charges. Exemption checks
both the endpoint and auditor authority. An auditor buying an app, changing a
publisher listing or calling an unrelated update does not receive a blanket
exemption. Configured administrators may call `admin_auditor_set`,
`admin_reserve_app`, `admin_set_burn_account`, and `rates_refresh` directly from
their authenticated CLI identity without attached cycles. Those four endpoints
retain `feeVersion` for compatibility without a fee or funding check. Existing
canister admins remain valid, and their attached cycles are left unaccepted.
The marketplace app has no auditor or admin interface.

Any Neutron can submit apps. Its developer pays fixed estimated cycle charges
for upload and modification through that Neutron, including one year of app
storage/processing on upload. Submission does not require a separate publisher
admission decision; app-ID ownership and package validity still apply.

## Review workflow

1. A publisher submits an immutable package candidate and its offered source.
   Record app ID, proposed version, exact hashes/lengths and listing context.
2. Assigned auditors query a queue of unaudited candidates, retrieve their
   package/source through authorized certified HTTP, and inspect them.
3. An auditor submits a version-bound stamp with its analysis: approved or
   rejected. Rejection requires a nonempty reason.
4. Developers can query their candidate's status, report and rejection reason,
   correct it and submit a new candidate for review.
5. One assigned auditor's approval makes the exact candidate eligible for
   publication. An app with no approved release stays outside the marketplace
   catalog and rankings.

Candidate identity and published release identity are separate. Corrections
produce a new candidate/hash without overwriting the rejected candidate or stamp.
Once a version is published, its bytes are immutable and changed bytes require a
higher app release version. A later candidate awaiting review does not displace
the previous approved release.

Revocation blocks ordinary downloads of the affected package, including reads
using previously issued grants, while retaining its audit history and authorized
review access. Buyers keep their entitlement and can download an approved
replacement. The initial protocol does not issue automatic refunds or remotely
remove an installed app. Revocation is not an uninstall or a silent downgrade.

Suggested public surface, names to finalize with Candid:

| Method | Kind | Purpose |
|---|---|---|
| `admin_auditor_set` | Exempt admin update | Assign or remove an auditor through the actual configured admin principal |
| `audit_queue` / `audit_candidate` | Query | Assigned auditors inspect unaudited packages |
| `audit_access` | Exempt auditor update, if a new HTTP grant is needed | Authorize exact review artifacts |
| `audit_stamp` | Exempt auditor update | Approve or reject an exact candidate with analysis/reason |
| `publisher_review_status` | Query | Publisher sees its submissions and rejection reasons |
| `public_audit_report` | Query/HTTP | Show the reviewed published release and auditor analysis |

An audit submission has an idempotency key and exact candidate identity. Repeating
the same stamp returns it; changing a decision under the same identity is a
conflict. Later supersession/revocation is a separate historical event under the
agreed policy. Do not edit a past rejection into an apparent original approval.

Keep candidate/analysis access available to its publisher and assigned auditors;
“hidden from marketplace” does not mean the developer cannot inspect a rejection.
Public UI shows the approved release, reviewer and report for the exact bytes.
The report describes the checks actually performed; approval alone must not be
presented as evidence of a malware scan or a guarantee of every app behavior.

## First-party automated publication

The production publishing scripts may approve their own checked artifacts only
when authenticated as the explicitly configured first-party principal. The
selected production identity is Blast ID 0. Admin or auditor membership alone
does not enable this publishing path, and another caller cannot select it by
supplying that principal in a request.

That principal owns the initial app listings. All its releases, including future
updates, are cycle-exempt. It can withdraw its own earned funds directly through
the CLI using the normal withdrawal accounting and ledger-fee rules.

The scripts inspect the package, its manifest and dependencies, and its matching
offered-source artifact before submitting their exact digests for approval. The
retained analysis identifies the automated checks actually performed. Automatic
first-party approval does not claim a manual malware review. Other publishers
continue through the assigned-auditor workflow above.

A compatible Kernel and app release set is approved and made visible in one
catalog transaction. Each stamp binds its candidate and package/source digests;
the batch request retains the exact set for recovery after an interrupted reply.
Repeating an unchanged publication verifies the existing releases without
creating another release or audit history entry.

## Storage and consistency

Use app/publisher ownership, immutable package candidates, published releases,
auditor assignments and append-only stamp records in the shared database.
Release publication checks that the stamp still names the exact bytes and that
the version can advance. Update the approved pointer, certificate metadata and
ranking eligibility in one local commit. Stale concurrent submissions cannot
replace already-published bytes at the same version.

The marketplace retains the current approved package and offered source, plus
candidates still awaiting review. After a replacement is approved, superseded
package/source content is removed when no other current release or pending
candidate references it. Shared content is not removed while another live
reference needs it. A completed upload awaiting candidate submission also retains
its exact bytes. Upload-to-candidate associations distinguish these staged files
from consumed upload history, including when identical source bytes are reused.
Rejecting a candidate releases its content if no live reference remains; the
rejection report and candidate identity remain readable. Listing images are
separate from package-version retention.
Purchase ownership, payment receipts, candidate identities and audit reports
remain available as records. Existing local release archives and the old source
canister's historical public artifacts remain release evidence.

Removal also invalidates the retired artifact's certified HTTP paths and
streaming access in the same update. A previous install selection may need to
prepare the latest release; its old hash is never redirected to replacement
bytes. A completed upload retry whose artifact has since been retired reports
that condition explicitly rather than fabricating a usable artifact.

## Acceptance tests

Unassigned principal cannot inspect private queue artifacts or stamp; publisher
cannot approve its own package without assigned auditor authority; missing
rejection reason fails; duplicate stamp does not duplicate history; changed bytes
invalidate the old stamp's applicability; developer can read/fix its rejected
candidate; one assigned approval is sufficient; an arbitrary Neutron can submit
after paying its fixed estimated upload cost; approved release remains available
during later review; revocation blocks existing ordinary download grants without
deleting purchases; and the cycle exemption does not apply to unrelated updates.
