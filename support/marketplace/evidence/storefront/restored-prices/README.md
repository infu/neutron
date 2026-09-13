# Restored original app prices

On 2026-09-13, the user ended the temporary free period. OpenChat is $4.99,
Curve and Blast are $7.79 each, Aave is $9.79 and Hyperliquid is $9.99. The other
23 first-party listings remain free. The immutable
[original price backup](../../../catalog/prices-before-temporary-free-2026-09-13.json)
provided the exact USD-micro amounts.

The [restoration receipt](../../../catalog/prices-restored-2026-09-13.json)
verifies all 28 listings in stable and beta. Only the five prices changed;
other listing metadata and release selections were preserved. Exact request
retries retained the resulting revisions. This was an ordinary `listing_save`
metadata edit; Marketplace remains at beta 0.1.22.

The Playwright screenshots render the actual app at DPR 2 with a read-only
[published beta catalog snapshot](public-storefront.json), restored prices,
actual 30-day ordering and verified published artwork. They do not imply
installation into a production Neutron. The
[browser results](browser-results.json) record responsive layout, card counts,
12px category labels, the 30-day default and enlarged detail gallery checks.

| Screenshot | View |
|---|---|
| [Desktop](desktop.png) | Featured apps and restored paid chart |
| [Sidebar](sidebar.png) | Categories on the left in a wide tile |
| [Mobile](mobile.png) | Compact category row and stacked featured cards |
| [Free apps](free-apps.png) | Free chart after paid prices were restored |
| [App detail](detail-desktop.png) | 408px gallery images |
| [Mobile detail](detail-mobile.png) | 306px gallery images |

```sh
MARKETPLACE_STOREFRONT_SNAPSHOT=support/marketplace/evidence/storefront/restored-prices/public-storefront.json \
MARKETPLACE_STOREFRONT_ARTIFACTS=tmp/marketplace-storefront/restored-price-screenshots \
node apps/marketplace/test/browser/storefront.mjs
```
