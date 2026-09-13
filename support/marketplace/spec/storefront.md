# Storefront presentation and categories

The storefront separates short promotional copy from an app's released name,
description and package. Administrators can curate categories and featured order
without republishing packages or changing prices, ownership, audits or channel
heads. The Marketplace app shows the first two eligible featured apps as large
cards, the first four remaining paid apps as medium cards, then compact paid
cards; the same four-and-remainder layout follows for free apps.

## Data and public reads

`mo/memory/storefront/v1.mo` owns the new persistent `storefrontMemory` root:

| Value | Meaning |
|---|---|
| `config.tags: [{id, name}]` | Ordered category IDs and editable display names |
| `config.featured: [appId]` | Ordered featured candidates |
| `config.revision` | Revision for conditional config edits; starts at zero |
| `apps[appId].title`, `.subtitle` | Short editorial headline and supporting copy |
| `apps[appId].tags` | Assigned category IDs |
| `apps[appId].coverArtifact` | Optional image artifact from the saved listing gallery |
| `apps[appId].revision` | Independent conditional-edit revision |

The existing protocol `App.title` and client `AppListing.title` still mean the
app **name**. Public storefront records wrap the unchanged `ChannelApp` in
`release`, alongside `presentation`. The client exposes the latter as `headline`,
`subtitle`, `tags` and `coverUrl`. Empty editorial copy falls back to the selected
release's name/summary. There is no new copy-length quota: use roughly 48
characters for a headline and 88 for a subtitle as editorial guidance. The UI
clamps both to two lines and truncates compact labels.

- `storefront_query({mode, tag, search})` returns config and eligible featured
  records, preserving the admin's order. It skips unpublished/revoked entries
  and follows the existing stable/beta selection, category and search rules.
  The protocol retains all configured featured IDs; displaying two is a client
  layout choice. Beta-only apps never appear in stable discovery.
- `storefront_browse({request, mode, tag, exclude})` shares the existing catalog
  ranking snapshots, cursors and eligibility loop. `request` is the unchanged
  `CatalogRequest`, including tier, ranking window, search, cursor and limit.
  Filtering and exclusions happen before page filling. The UI excludes only
  the featured apps it actually displays and pages each price tier separately.
  Search includes app ID/name/summary, editorial copy, tag names and publisher
  ID/name. Kernel and Marketplace stay out of discovery lists.

Release selections, selected audit evidence, installation status, prices and
exact acquisition counts keep their existing contracts. The client rejects an
in-flight discovery result if the Kernel release preference changed. Legacy
catalog, detail, publisher and purchase endpoints remain available.

## Administrator edits

The configured admin principal can call these directly, without cycles or a
Neutron relay. They add no app backend route or Kernel permission requirement.

| Endpoint | Input / result |
|---|---|
| `admin_storefront_app_get(appId)` (query) | Optional saved presentation, including revision and artifact ID |
| `admin_storefront_set` | `{tags, featured, expectedRevision}` → saved config |
| `admin_storefront_app_set` | `{appId, title, subtitle, tags, coverArtifact, expectedRevision}` → saved presentation |

Tag IDs and featured IDs must be distinct and nonempty; category names must be
nonempty. Featured entries need an existing listing, so an admin can prepare
curation before a release becomes eligible. App assignments must use known,
distinct tag IDs. Renaming a category's display name retains assignments and
its order is controlled by the config array. Removing a tag prunes that ID from
all app assignments in the same update and increments affected app revisions.
Reintroducing its ID does not restore old assignments.

An exact repeat returns the current identical value without increasing its
revision, even if it carries the original expected revision. A different edit
with a stale revision returns `storefront_conflict`. Keep the exact reviewed
input after a lost response. Config and each app are separate commits; there is
no claim that a multi-app editorial update is one catalog transaction.

## Covers, icons and initial copy

The [first-party storefront](../catalog/first-party-storefront.json)
contains 26 app presentations and eight editable categories. Jetfreeper and
Hullshift are the initial featured pair. This JSON is operator input, not a
hardcoded seed installed into protocol memory.

Sixteen generated covers are saved in `catalog/media/<appId>/cover.webp`, at
1672 × 941 pixels, enough for approximately twice the displayed large-card
width. The [exact generation prompts](../catalog/cover-prompts.json) identify
the image-generation mode and each asset. These are promotional illustrations;
the existing actual UI screenshots are retained. The
[media manifest](../catalog/first-party-media.json) appends covers to their
existing galleries.

The production preflight found newer Hullshift screenshots than the old local
copies. `published-overview.png` and `published-entry.png` retain those exact
certified live bytes so cover publication appends to its actual gallery too.

All 28 listing icons use the selected sculpted 3D bitmap style. The shipped
assets are 256 × 256 WebP, about 6–14 KB each (283 KB total), with identical
bytes in each app's launcher asset. Full-size generated PNG masters stay
outside app packages. [Icon prompts](../catalog/icon-prompts.json) record the
mode and per-app prompts. Kernel has no launcher; Blast is headless but receives
a package release to snapshot its new listing icon. The release set contains
27 changed app packages and leaves Kernel 362 unchanged. Card footers show app
names and tags; publisher navigation remains in app details.

Covers use the existing image upload, listing and certified HTTP path. An admin
can explicitly select a newly published current-listing image without replacing
the selected release's frozen screenshots, name or package. Reads only expose
that artifact while it is referenced by the current or selected gallery and is
public under existing artifact-access rules. Otherwise the cover falls back to
the selected release's first screenshot. Removing an explicit selection uses
that fallback too. No new artifact-retention path is introduced.

Large cards render the whole cover behind the content. CSS applies a masked
`backdrop-filter` and a gradient under the lower copy, fading the glass into the
same image. Medium cards use the same asset with a compact footer; small cards
use icons. Categories move from a horizontally scrollable top row to a left
navigation at a tile width of 1480px. The layout uses the tile container width,
so a narrow Neutron tile on a wide monitor still gets the compact navigation.
Category labels render at 12px. Both charts default to 30 days. App-detail
gallery images retain their aspect ratio at 408px tall, or 306px on small
screens, and scroll horizontally within the dialog.

Follow [Storefront curation](../OPERATIONS.md#storefront-curation) to publish
media, prepare exact artifact IDs/revisions and apply reviewed admin edits.

## Memory audit and release order

The app has one managed root, `state`, still at schema **2**. Its complete
declaration, released `v1.mo`, `v2.mo`, `v1_to_v2.mo` and `neutron.lock.json`
remain unchanged. Release version **122** is independent of that memory version.
The existing exact-archive qualification covers saved schema 1 from release 112
and saved schema 2 from releases 118 and 121, through the checked Kernel installation
transaction, plus clean initialization. It retains read identity, configuration,
discount and original/revised recovery journals.

The standalone protocol preserves all five predecessor roots: `memory`,
`publisherMemory`, `certificationMemory`, `releaseMemory` and `feedbackMemory`.
It adds `storefrontMemory`, initially empty, through enhanced orthogonal
persistence. Its schema source is new immutable lineage; no released schema or
migration module is replaced. `storefront.integration.ts` checks clean init,
compiler stable compatibility, a populated predecessor keep-upgrade, unchanged
listings/purchases/profiles/release heads and a second keep-upgrade after admin
edits. The test's predecessor path is explicit; a PR-base build is development
evidence, not proof of the currently deployed production module.

For release, follow the repository's canonical
[package workflow](../../../doc/package-updates.md):

1. Qualify the protocol successor against the actual deployed predecessor and
   keep-upgrade the source. Verify existing catalog, ownership, certified media
   and the new public reads. This is a prerequisite to offering the new client;
   older clients can still use the upgraded source.
2. Publish and verify the selected cover bytes through the existing media
   workflow, then apply reviewed config and per-app presentations. Repeat exact
   admin requests to verify unchanged revisions. Do not change app prices to
   reproduce screenshot fixtures.

   The separately requested [temporary free period](../catalog/TEMPORARY-FREE.md)
   ended at the user's request. Original prices were restored through ordinary
   listing edits; the backup and verification are retained.
3. Build each affected app through its complete workspace package command and
   run its release checks. Review exact archives and offered-source bytes. Keep
   every released memory declaration and lineage, including Marketplace schema
   2, and the existing Marketplace update source `sj2r4-haaaa-aaaay-aadgq-cai`.
4. Publish the reviewed package/source via root `npm run updates:publish`, then
   repeat against identical bytes and require receipt-v2 `batch_id: null` with
   every selected package and source verified `unchanged`. Qualify and promote
   the same beta bytes through the existing stable-promotion workflow only when
   a stable release is requested.

This storefront requires no Kernel code change. If a release set also includes
an intended compatible Kernel successor, publish/promote that set atomically as
documented; do not create a timed Kernel-first catalog phase. Existing Neutrons
install through the checked in-product transaction. Dispenser starter staging
is a separate decision. Preparing a PR, package and local evidence performs none
of these production actions.
