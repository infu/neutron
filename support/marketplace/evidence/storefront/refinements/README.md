# Marketplace 0.1.22 refinements

Category labels now render at 12px, with smaller icons and padding. Both charts
start with the 30-day ranking period. App-detail screenshots are 408px tall on
desktop and 306px on small screens, exactly 70% above the previous 240px/180px.
They retain their aspect ratio and scroll horizontally within the gallery.

All 28 first-party listing prices are temporarily zero in stable and beta.
The [original prices](../../../catalog/prices-before-temporary-free-2026-09-13.json)
were committed before changing the five paid listings. The
[restoration instructions](../../../catalog/TEMPORARY-FREE.md) preserve later
listing edits. No restoration date was specified. The
[price verification](prices-verified.json) records both channel views; each paid
listing advanced once, and exact retries left its revision unchanged.

## Release qualification

The exact archive is recorded in [package-audit.json](package-audit.json).
Its complete backend, managed-memory declaration, schema dependency closures,
migration and lock bytes match release 121. All 50 backend modules/lock files
are retained. The state root remains schema 2; clean initialization and retained
root plans are non-destructive.

The workspace package, app tests, type check, all nine browser suites and actual
client/protocol integration passed. Checked in-product upgrade qualification
covers released versions 112/schema 1, 118/schema 2 and 121/schema 2, preserving
identity, complete saved state and journals, with saved discounts for schema 2.
Kernel 359 stays unchanged in these isolated upgrade fixtures.

Marketplace 0.1.22 was [published to beta](beta-publish.json) in batch **22**
through root `npm run updates:publish`. The exact same command and bytes were
repeated; the [receipt-v2 postflight](beta-repeat.json) has `batch_id: null` and
all 28 selected packages and sources `unchanged`, matching their local versions,
URLs, paths, byte lengths and SHA-256 values. Verifier-process errors were
reconciled by retrying the same frozen artifacts, without bypassing verification.

[Release checks](release-checks.json) and checked upgrade receipts for
[112](upgrade-112.json), [118](upgrade-118.json) and [121](upgrade-121.json)
record the qualifications. The three upgrade cases passed 343 assertions;
26 unrelated imported cases remained explicitly gated. Stable package heads,
Kernel 362, installed Neutrons and the Dispenser starter were not changed.

| Screenshot | View |
|---|---|
| [Desktop](desktop.png) | Smaller category labels, 30 days and current free chart |
| [Sidebar](sidebar.png) | Compact labels on the left |
| [Mobile](mobile.png) | Compact category row and stacked featured cards |
| [App detail](detail-desktop.png) | 408px gallery images |
| [Mobile detail](detail-mobile.png) | 306px gallery images |

[Browser results](browser-results.json) include the rendered size and overflow
checks. [Catalog snapshot](public-storefront.json) records the actual free prices
and 30-day order.

## Reproduce the screenshots

These screenshots render the real app in its iframe sandbox at DPR 2 using
the read-only published catalog snapshot, its actual 30-day ordering, and exact
published media bytes. They do not imply installation into a production Neutron.

```sh
MARKETPLACE_STOREFRONT_SNAPSHOT=support/marketplace/evidence/storefront/refinements/public-storefront.json \
MARKETPLACE_STOREFRONT_ARTIFACTS=tmp/marketplace-storefront/refinement-production-screenshots \
node apps/marketplace/test/browser/storefront.mjs
```
