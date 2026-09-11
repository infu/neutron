# Publisher profiles

An app retains its owning principal. That principal can register exactly one
publisher profile with a globally unique ID containing 3–20 lowercase ASCII
letters (`a`–`z`). Registration fixes both the ID and display name permanently.
The description remains editable. Repeating the same registration returns the
current profile and never restores an earlier description over a later edit.

Ordinary publishers register through their Neutron. The configured first-party
publisher registers through its existing direct CLI route. Profile registration
and editing use the same per-byte update fee as listing metadata; the configured
first-party principal remains exempt. Admin/auditor roles do not confer authority
to alter another publisher's identity.

New listing saves, upload creation and package candidates require a profile.
Existing uploads can still resume, and saved package candidates retain their
original recovery identity. An upgrade does not hide or rewrite old listings,
change their owner, cancel an upload or change any purchase or ledger state.
The first-party profile is registered as `aae` under its existing owner.

## Read contract

All profile reads are queries and may go directly from browser to protocol:

- `publisher_profile(publisherId)` returns the public profile.
- `publisher_profile_for(principal)` returns that principal's profile, or null.
- `publisher_profile_apps({publisherId, cursor, limit})` lists that publisher's
  currently visible apps with approved releases. Even the publisher's own public
  profile excludes hidden, unaudited and revoked releases.
- App records retain `publisher` and add optional
  `publisherProfile: {publisherId, name}` for the byline. Null means the owner has
  not registered a profile, including preserved listings from older releases.

A profile exposes `publisherId`, `name`, `description`, `principal`,
`ratingCount`, `ratingTotal`, `totalUsers`, `statsComplete`, `createdAtNs` and
`updatedAtNs`. Public app pages seek within the existing owner index; the opaque
numeric cursor is not an app ID. A page is a live observation, not a frozen
catalog generation.

## Portfolio statistics

The aggregate rating is `ratingTotal / ratingCount`, or unrated when count is
zero. This weights every app's rating by its number of reviews rather than
averaging app averages. Editing a review replaces the original contribution;
it does not add a reviewer. Statistics cover the publisher's retained portfolio,
including apps no longer publicly listed, so hiding an app does not erase its
history.

`totalUsers` counts distinct acquiring Neutron principals across the entire
publisher portfolio. Acquiring another app by that publisher, reinstalling,
upgrading or repeating the same purchase does not increase it. This counts
Neutrons, not independently verified humans. Both free and paid acquisitions
count after entitlement finalization.

Acquisition finalization updates a unique `(publisher principal, buyer Neutron)`
membership and its counter in the same await-free segment. Rating changes update
the aggregate through an idempotent per-app rating baseline. Queries read stored
counters; they do not scan purchase or rating history.

The upgrade adds a separately retained publisher root and leaves all prior
marketplace roots unchanged. Historical app ratings and acquisitions are
backfilled in bounded cursor batches. New purchases and rating edits use the
same membership and baseline checks, so they remain correct during backfill.
`statsComplete=false` explicitly marks incomplete history until both cursors
finish. Profile registration is independent of that work: statistics belong to
the owning principal even before it chooses a public ID.

## Verification

The focused suites cover clean initialization, permanent identities, concurrent
ID collisions, cycle/caller rules, public-page visibility and pagination,
portfolio user deduplication, weighted ratings and edits, resumable backfill
interleaved with live updates, and a keep upgrade from the exact production
predecessor. Existing publication, purchase, authorization, storage and retained
HTTP evidence tests remain part of the release checks.
