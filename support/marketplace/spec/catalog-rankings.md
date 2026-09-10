# Catalog prices and acquisition rankings

## Price and counting rules

The protocol accepts list price `0`, or integer USD micro-units in the inclusive
range `[1_000_000, 50_000_000]`. Validate this in the publisher domain, not just UI.
The agreed referral discount applies afterward: a $1 listing can cost $0.90.
Preserve listing revisions and exact checkout terms; do not truncate amounts.

Show **Top free** and **Top paid**, each over **7 days**, **30 days**, and
**All time**. Count distinct Neutrons acquiring each app, as confirmed by the
owner. Downloads, chunks, approvals, quotes, installs, updates, retries and
reinstalls never add popularity. A paid acquisition counts only after payment
and entitlement finalization. A free claim counts when its entitlement is granted.

One basket can add one acquisition for each newly owned app. Deduplicate on the
durable `(Neutron, appId)` acquisition, not browser identity or payment-call count.
This counts Neutrons, not independently verified humans; no anti-Sybil policy is
implied.

## Tables and indexes

| Table | Purpose and keys |
|---|---|
| `apps` / `listingRevisions` | Unique app ID; current price/approved release and immutable earlier listing terms |
| `orders` / `orderItems` | Unique account/request ID and frozen per-app purchase terms |
| `acquisitionClaims` | Unique `(Neutron, appId)` only while collection can still have an effect |
| `entitlements` | Unique `(Neutron, appId)`; by-Neutron index for My Apps; first acquisition identity |
| `acquisitionEvents` | Append-only first acquisition: app, Neutron, kind, finalization time, terms, ledger proof when paid |
| `appRankingStats` | One row/app: free and paid counters for 7d/30d/all time and current catalog eligibility |
| `rankingMaintenance` | Two durable expiry cursors and last coherent published generation |
| `publishedCharts` | Six ordered chart snapshots with generation and exact `asOf` |

Acquisition events have an ordered `(finalizedAtNs, eventId)` index for expiry and
an `(appId, finalizedAtNs, eventId)` index for diagnostics. The protocol assigns
finalization time; clients cannot backdate popularity through quote timestamps.
Keep first-acquisition evidence even if a later refund/access policy revokes an
entitlement. Any agreed adjustment should be a separate event, not deletion that
allows another purchase to masquerade as a new distinct Neutron.

Use six full ordered optional indexes over `appRankingStats`, keyed by score and
stable app-ID tie-breaker. Emit entries only for currently visible apps with an
approved eligible package and matching current free/paid tier. Store all index
candidates and read only the requested leaders, so rank falls and delisting
expose the next eligible apps without reconstructing missing candidates.

Do not run a purchase-history scan for each homepage request. Score-index reads
seek directly into ordered per-app aggregates. Approval, delisting and price-tier
changes update that app's eligibility together with its catalog change.

Free and paid acquisition history remains separate. Proposed presentation:
currently free apps rank by free acquisitions, currently paid apps by paid
acquisitions. Changing price tier does not convert old free claims into sales or
old sales into free claims. Future-update rights and refund adjustments remain
purchase-policy decisions; retain evidence to implement them explicitly.

## Exact rolling expiry

Acquisition finalization increments its kind's all-time, 7-day and 30-day counters
once in the same await-free commit as ownership and accounting.

Maintain one ordered expiry cursor per rolling window. At time `T`, a window `W`
contains events with `T-W < finalizedAt <= T`. Decrement events at or before its
lower boundary and advance the cursor atomically. Each event expires once per
window. Timer jobs resume these cursors after interruption/upgrade; they do not
restart from genesis or overwrite new acquisitions with a pre-await snapshot.

Catch-up can span messages. A fixed old cutoff is insufficient while new
acquisitions continue. Each maintenance segment captures a fresh `T`; publish a
new generation only when **both** expiry cursors have caught up through their
boundaries at `T` and all six chart snapshots are built in that same await-free
segment. Existing events then have timestamps at or before `T`. No purchase gate
is needed.

During backlog, serve the last coherent published generation and its `asOf`, with
refreshing metadata. Do not label partially expired counters as current. Initial
empty charts are a coherent generation. Chart pagination must remain within a
retained generation or explicitly ask the client to refresh a stale cursor;
ordinary live index pagination is not a snapshot guarantee.

Every chart response also checks current catalog and audit eligibility. A
delisted, revoked or differently priced-tier app disappears immediately, even
when its score belongs to the last published generation. Filter while traversing
that generation, advancing the cursor over skipped entries; never expose an
ineligible app just to fill a page. Scores retain their stated `asOf`, and newly
eligible entries join when the next coherent generation is published.

Snapshot page size and maintenance chunk work are implementation parameters to
measure against platform execution limits. They are not acquisition/ownership
quotas and no thresholds are selected by this specification. Daily buckets are
optional only if a future dashboard needs them; two expiry cursors suffice for
the requested rolling windows.

## Acceptance tests

Test price 0/$1/$50 boundaries and discounted $0.90; duplicate/concurrent
finalization; multi-app baskets; exact 7/30-day boundary ties; interrupted expiry;
new acquisitions during backlog; immediate hiding on revocation/delisting during
backlog; rank falls exposing the next app;
free/paid price changes; and restart retaining the same generation. Compare
materialized counts against a full event-derived oracle in tests, never in the
ordinary production query path.

Run these cases through the [Ash/PocketIC acceptance suite](testing.md). This
specification does not claim that the ranking implementation has been built.
