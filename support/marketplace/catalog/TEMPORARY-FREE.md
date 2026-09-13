# Temporary free app period

The temporary free period ended at the user's request on 2026-09-13. All 28
first-party listings now have their original prices in stable and beta: the
five paid prices below were restored, and the other 23 remain free.

The original prices were read from the live publisher listings and committed
before the five paid listings were made free. The
[restoration receipt](prices-restored-2026-09-13.json) verifies both channel
views at 20:37 UTC. Other listing fields and release selections were preserved;
each changed listing advanced once, and exact retries retained its revision.

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

Restoration read each current `app_detail` as its existing publisher and called
`listing_save` with the saved `priceUsdMicros`, the current `expectedRevision`,
and all other current listing fields unchanged. It used the existing metadata
edit flow and required no app package rebuild or publication.
