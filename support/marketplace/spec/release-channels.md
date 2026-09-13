# Release channels and feedback

This is the channel contract for the Marketplace source and participating
Kernel clients. [App Package Updates](../../../doc/package-updates.md) owns the
release workflow; [Operations](../OPERATIONS.md) owns commands and rollout.
The [historical production record](production-release.md) is deployment evidence
for its recorded bytes, not evidence that this successor has been deployed.

## Releases and selection

Each app has independent stable and beta heads referencing immutable candidate
identities. Each head has its own revision. New approved releases enter beta;
approval remains required before beta distribution. Stable changes through an
explicit promotion of the exact current beta. The first-party path retains its
existing authority to approve artifacts after automated package/source checks.

Stable mode selects only an eligible stable head. Beta mode selects the newest
eligible stable or beta head, preferring stable when version and bytes match.
Equal-version different bytes is equivocation. There is no rewind to a historical
candidate. Revocation makes the referenced candidate ineligible in both channels;
an independently eligible other head can still be selected. It does not remove
an installed app or grant a downgrade.

**Beta updates**, under Kernel **Settings → Advanced users**, is one durable
owner-controlled preference per Neutron, off by default. Settings updates,
Marketplace discovery, quotes, dependencies and prepared installations use that
mode. Ordinary storefronts omit beta-only apps. A preference change invalidates
undispatched prepared review through its revision, even if another device makes
the change. Dispatched installations and financial requests still reconcile
under their original operation identities.

Disabling beta leaves installed versions and memory intact. A newer installed
beta waits for stable without a downgrade; promotion of its exact bytes makes
it current without reinstallation. Deliberate owner imports of local packages
or URLs retain manual review. Package bytes do not themselves encode channel
membership, and repository offers cannot substitute an unverified channel label
for source evidence.

## Certified repository contract

Existing closed v1 release records remain unchanged. The stable-only path is
`/repo/v1/releases/<app-id>.json`; beta uses
`/repo/v1/channels/beta/releases/<app-id>.json` with the same record body.
Package and offered-source URLs remain digest-addressed.

| Resource | Protocol | Binds |
| --- | --- | --- |
| `/repo/v1/channels.json` | `neutron-repo-channels-v1` | Source principal |
| `/repo/v1/channels/apps/<app-id>.json` | `neutron-repo-channel-heads-v1` | Source, app, stable/beta revisions, candidate IDs and release records |
| `/repo/v1/channels/manifests/<manifest-id>.json` | `neutron-repo-channel-selection-v1` | Source, mode, manifest ID/digest and complete exact package selection |

The shared closed parsers and path builders live in
`packages/neutron-tools/src/release_channels.ts`. Candidate IDs and revisions
are canonical unsigned decimal strings. An absent head has null candidate and
release; a revoked head retains its candidate/revision but has a null release.
A selected package binds app ID, candidate ID, version, digest, size, channel
and head revision. Parsers do not establish origin: clients verify certification
and compare the declared source with the repository's actual principal.

Setup negotiates the fixed optional `repo_channel_metadata({path; index})`
query. On production, only a verified node-signed method-not-found rejection of
that query (`IC0536`, reject code `5`) establishes method absence; local fixtures
use their explicit runtime trust policy. Normal replies require a valid IC
certificate and asset witness, including certified absence. A Candid-only v1
repository can therefore keep serving setup. Generic exceptions, HTTP failures,
other rejection codes and bad proofs never select legacy handling. See the
[IC method-not-found reference](https://docs.internetcomputer.org/references/execution-errors/#method-not-found)
for the execution error's meaning.

Certified descriptor absence permits legacy handling only before positive
channel identification. Once known, a missing descriptor is an error. Present
descriptor, heads and selection always require full certified evidence; the
legacy browser HTTP hidden-header exception does not apply to these resources.

Stable setup retains the closed v1 manifest. Beta setup uses
`protocol: "neutron-repo-channel-manifest-v1"` and required `channel: "beta"`,
with the other v1 manifest fields. Old Kernels reject that envelope even when
given a beta setup link; successor Kernels additionally require certified
channel-selection evidence. A download grant establishes access, not stable
membership. The source resolves the requested set and dependencies in one
synchronous selection; Kernel verifies its complete manifest binding and current
heads when loading, then revalidates those heads before staging deployment.
Unrelated app publications do not invalidate selection through a global catalog
revision.

## Atomic promotion and retention

`promotion_prepare` reads the selected current beta identities. `release_promote`
binds authenticated publisher, request ID, exact app/candidate/version,
package/source digests and lengths, dependencies, and expected beta/stable
references and revisions. It checks ownership, approval, available artifacts,
identity, strictly advancing stable versions and the resulting transitive
dependency graph before mutating anything. An already identical stable head is
a no-op. A dependency must already be stable or become stable in the same set.

Commit advances the selected heads, certification, receipt and retirement
decisions in one await-free transaction. It does not rebuild or re-upload
artifacts. A replacement beta before commit conflicts. `promotion_status` and
exact retries recover the original receipt; reusing an identity for different
entries conflicts, and an old retry never rolls stable back. Whole-actor
compilation and managed-memory checks still occur at installation against the
actual installed app set.

Both heads retain their packages, offered sources and release listing media,
including when both reference one candidate. Pending audits/uploads retain their
existing artifact rights. Listing description, screenshots and release notes
belong to the selected release; a beta listing must not replace stable content.
Ownership, prices and entitlements remain app-wide. Promotion never charges for
the app again. Unreferenced artifacts can retire; old grants do not promise
permanent downloads. Candidate, audit, purchase and receipt identities survive.

## Feedback

The unique acquiring-Neutron/app star rating is permanent and editable. App and
publisher totals survive publication, promotion and comment retirement.
`rating_summary_v2` adds counts for five through one stars; its `complete` flag
distinguishes backfill progress from a complete histogram. A restartable backfill
records each rating's counted contribution, so concurrent edits neither double
count nor lose a bucket update. `rating_set_v2` writes stars without text.

`version_comments_v2`, `version_comment_set_v2` and
`version_comment_delete_v2` bind app, candidate, version and package digest. One
owner's comment is editable for that offered release. A concurrent publication
cannot attach text to a different version. Promotion of the same candidate keeps
its thread. Losing the last stable/beta reference immediately makes the thread
unavailable for reads/writes; restartable maintenance deletes its text and
indexes. There is no historical comment archive.

Upgrade adds independent channel and feedback roots while preserving released
database and publisher schemas. Existing published pointers bootstrap as stable,
with revocation preserved, and beta starts empty. Legacy rating text has no
release identity: it is preserved through this bootstrap without guessing a
version. Only after the successor Marketplace client is available through stable
does the administrator explicitly activate `admin_feedback_cutover`. That gates
nonempty legacy text with `feedback_update_required` before maintenance deletes
the old text. Stars-only legacy writes remain valid; stars, owners, timestamps
and aggregates survive cleanup.

Every schema installed by a beta user is released migration history, whether
or not that beta reaches stable. Future packages must retain its immutable
schema/migration lineage and supported forward paths. Test clean initialization
and state-preserving upgrades from the deployed source and app predecessors
before release; compilation alone does not establish semantic preservation.
