# Temporary free app period

The user requested all apps be free on 2026-09-13. The original prices were read
from the live publisher listings and committed before the five paid listings
were changed. All 28 first-party listing prices are now zero in stable and beta.
No end date was specified; restore prices when the user requests it.

The durable source of original prices is
[prices-before-temporary-free-2026-09-13.json](prices-before-temporary-free-2026-09-13.json).
Amounts in that file are exact USD micros, including the 23 already-free apps.

| App | Original price |
|---|---:|
| OpenChat | $4.99 |
| Curve | $7.79 |
| Blast | $7.79 |
| Aave | $9.79 |
| Hyperliquid | $9.99 |

To restore, read each current `app_detail` as its existing publisher and call
`listing_save` with the saved `priceUsdMicros`, the current `expectedRevision`,
and all other current listing fields unchanged. Review any intervening price
edits. Do not restore old titles, descriptions, media or release selections from
the backup. Repeat the exact requests and verify both channel views afterward.
This uses the existing metadata edit flow; it does not rebuild app packages.
