# Wagyu

Status: v0.3.2 limited-release implementation specification

App id: `wagyu`

Public protocol: `wagyu_v1`

Wagyu is a user-owned social network built from Neutron canisters. This
document describes the current app, not an aspirational replacement for it.
The manifest, checked-in Candid, protocol codecs, backend services, verifier,
resident process, UI, and tests remain the executable sources of truth.

Wagyu is not yet eligible for a public production launch. Its reviewed
app-level stop-ship findings have been remediated. The shared Kernel
certified-asset implementation still needs measured, release-bound production
and browser/gateway evidence, as recorded in
[Certified HTTP And Certified Assets](../../doc/kernel-http-v2-and-certified-assets.md#qualification-status).

## 1. Why Wagyu Exists

Conventional social apps put identity, relationships, content, moderation, and
distribution inside one provider's service. Wagyu gives each person their own
social backend:

- one human owns one Neutron canister;
- one Wagyu installation in that canister is one social identity;
- the owner publishes from that canister and stores their authored state there;
- relationships connect canister principals directly; and
- recipients verify public objects from the canister that claims to have
  authored them.

There is no global Wagyu service, shared feed database, global relationship
graph, central like counter, or global profile registry. Each installation
stores only its owner's authored state, its local relationship state, bounded
incoming candidates and notifications, reaction evidence for its own posts,
and the durable delivery work needed to participate.

Wagyu is push-based. The author pays to send compact references to recipients;
recipients do not crawl peer backends looking for changes. Public content is
fetched only when needed and is not released to the UI until its certification
and application bindings verify.

## 2. System Model

### 2.1 Owner, user ID, and network

One Neutron has one human owner. The kernel may authorize several Internet
Identity, recovery, or tool principals, but those are equivalent credentials
for the same owner. They are not Wagyu users and must not appear in the social
graph.

The Wagyu user ID is the Neutron canister principal. Display name, description,
and avatar are mutable presentation data certified by that principal; they are
not identity and need not be unique.

Every installation also receives a compiler-owned 32-byte `network_id` derived
from the trusted IC or PocketIC root-key SPKI DER. The generated actor persists
it across compatible upgrades. Wagyu action and profile validation rejects the
wrong network, so local/test objects cannot be confused with mainnet objects.
Neither app code, a manifest, a browser, a peer, nor runtime query data chooses
this value.

The UI uses ordinary language such as user, user ID, post, and Home. Kernel
principals, proof internals, route names, and cycle mechanics belong in
diagnostics or documentation rather than normal social UI.

### 2.2 Relationship direction

If Alice follows Bob:

- Alice's node stores Bob in `following`;
- Bob's node stores Alice in `followers`;
- Bob sends new post and share references to Alice; and
- Alice accepts a delivery from Bob only while her local `following` intent
  permits it and the subscription ID matches.

The records are intentionally asymmetric. Alice can stop receiving
immediately, even if her paid cleanup message to Bob is delayed. A stale
follower row at Bob may waste Bob's prepaid delivery capacity, but it cannot
make Alice accept content.

Block is local policy. A blocked user cannot establish a new relationship or
deliver new accepted activity to that node. Blocking atomically closes both
directions, releases active Following/Follower capacity, clears renewal and
pending links, and advances generation fences without erasing historical
registration or remote high-water state. Unblock removes only the policy row;
it never revives either relationship.

### 2.3 Push, not peer polling

Wagyu must not periodically query peer backends to discover posts, replies,
shares, likes, follows, or withdrawals.

These operations are allowed and are not peer polling:

- querying the owner's local Wagyu backend for status and bounded pages;
- retrying a previously committed outbound message;
- fetching a visible remote profile or certified object;
- opening a visible post's certified direct-reply index;
- opening a post's certified Like head and immutable Like packages; and
- explicit user-driven recovery or verification.

The sending node owns fanout cost. The receiving node owns admission and local
retention. The browser owns remote cryptographic verification.

## 3. Trust Boundaries

Wagyu keeps distinct facts distinct:

| Evidence | Establishes | Does not establish |
| --- | --- | --- |
| Immediate IC caller | Which canister invoked a paid public-ingress route | That it runs honest Wagyu code or represents a particular human |
| Attached cycles | That the canister caller funded the configured receive floor | Identity, reputation, permission, or semantic validity |
| Certified HTTP response | That the expected canister certified the exact request/response tuple | Truth, confidentiality, completeness, or human review |
| Portable proof snapshot | Historical evidence for one immutable certified object | Current availability or current mutable state |
| Verified profile | Presentation data certified by one user ID at a generation/revision | A unique or trusted human name |

Payment is resource admission, never identity. A receiver acknowledgement means
that bounded local admission ran; it does not prove that the nested object is
valid, displayed, or still retained.

The local Motoko backend deliberately does not verify remote IC certificates or
HTTP witnesses. It binds the immediate caller, applies relationship and block
policy, validates cheap framing and bounds, deduplicates, and stores remote
bytes as quarantined candidates. The direct claimed-post index admits at most
64 candidates for one claimed `(author, post_id)` slot, so verification,
conflict quarantine, and withdrawal hiding never scan the global feed store.
A separate direct verified-slot index resolves the one canonical body, while
share attribution uses its ordered canonical-post prefix.

The browser verification Worker:

1. obtains its root key, gateway policy, expected local canister, and network
   identity from the kernel-certified runtime;
2. fetches the exact derived URL anonymously with credentials omitted and
   redirects rejected;
3. verifies the IC certificate, delegation, certified-data root, HTTP witness,
   expression path, method, status, fixed headers, body length, and digest;
4. validates the fixed Wagyu path and expected serving canister;
5. hashes exact received Candid bytes before decoding them;
6. validates action kind, actor, network, IDs, parent/original bindings, and
   mutable freshness/high-water rules; and
7. releases decoded content only from a terminal `verified` result.

No quarantined bytes are rendered. A pending verification is represented only
by a post-shaped skeleton. Every live fetch, HTTP status, header, body, proof,
and cryptographic failure is retryable `unavailable`: a gateway response,
including a certified wildcard `404`, is an observation of current
availability and never durable deletion authority. Only a cryptographically
verified semantic mismatch or terminal portable-evidence failure is `invalid`.
That terminal result removes the candidate, its visible indexes, retention
row, and quota charge atomically; only the bounded transport receipt remains
for replay deduplication.

Browser IndexedDB, CacheStorage, and in-memory results are rebuildable caches.
They are not canonical backend state or a substitute for re-verification.
Mutable high-water compare-and-write is atomic across resident contexts and
fails closed when its bounded store is full or malformed; security high-water
is never silently evicted. Optional immutable cache persistence does not delay
release of an already verified value, and every cache hit is reverified.
Raw Candid receives a bounded structural preflight before the Candid library
constructs its type graph or decodes values.
Cancellation is bound to the exact requesting endpoint and task and releases
the Worker slot, fetch lease, and keyed-serialization waiter.

## 4. Content and Actions

### 4.1 Exact bytes and identifiers

Exact Candid bytes are protocol identity. A verifier must hash received bytes
before decoding and must not decode and re-encode a value to recreate a hash
preimage.

Wagyu's semantic framing is:

```text
LP(x)  = u32be(byte_length(x)) || x
H(xs)  = SHA256(LP(xs[0]) || LP(xs[1]) || ...)
```

The first item is a fixed ASCII domain. Hashes and IDs are 32 bytes, nonces and
operation IDs are 16 bytes, and principal identity uses `Principal.toBlob`.
Lowercase hex is a path/UI representation only.

Current domains are frozen in `backend/protocol/Hash.mo` and
`src/protocol/constants.ts`: `neutron.network-id.v1`,
`wagyu.post-body.v1`, `wagyu.post-id.v1`, `wagyu.share-id.v1`,
`wagyu.like-id.v1`, `wagyu.tombstone-id.v1`, and
`wagyu.feed-candidate-id.v1`.

### 4.2 Posts and replies

A post is an immutable `PostBodyV1` containing the network and author header,
an author sequence, nonce, creation time, Markdown text, and an optional
`reply_to` locator. V1 text is at most 8 KiB of safe UTF-8. HTML, scripts,
remote previews, and post media attachments are outside V1.

A reply is not another wire action type. It is an ordinary post with a
non-null parent locator copied from a verified post reference:

```text
reply_to = {
  author;
  post_id;
  body_hash;
  body_length;
  object_digest;
}
```

The parent body is not embedded. The reader derives and verifies it when a
thread needs it.

The exact post body is the immutable certified response. Its object digest is
`SHA256(exact_post_body_candid)`. `post_id` is derived from the network ID,
author principal, and the domain-separated post body hash; certificate and
witness bytes never affect social identity.

Finalizing a normal post fans its compact certified reference to eligible
followers. Finalizing a reply does the same and also sends a small notice to
the parent author. Before either kind of post is fanned out, its author
publishes revision 1 of its own empty `ReplyIndexV1`. Zero replies therefore
has a certified representation; an HTTP 404 remains unavailable and is never
promoted into a verified zero count. The parent backend authenticates and
quarantines a reply notice without publishing its claimed locator. The owner's
browser verifies the exact reply from the claimed author, then submits a narrow
attestation bound to the stored notice. Only that promotion appends the locator
to the parent's mutable certified index. Local replies use the same verified
append helper.

The index is discovery evidence, not authority for another user's text. V1
publishes at most 100 direct reply locators per post. When a reader opens a
post, it verifies the index from the parent author, then fetches only the newest
25 listed direct-child bodies from the listed reply authors' immutable post
paths. The reader releases a reply only when that author's certified bytes
reproduce the listed identity and contain an exact `reply_to` binding to the
selected parent. Selecting a child loads that child's own index, so deeper
levels remain collapsed until requested. Withdrawing the parent removes its
mutable reply index before authored-state cleanup.

An author can omit or stop serving an index, just as an author can censor local
conversation discovery; certification does not prove completeness. It cannot
forge another author's reply because the reply body is independently fetched
and verified from that author.

Posts are immutable. V1 has no post edit.

### 4.3 Shares

A share is an immutable, add-only action pointing to the original post. It
preserves the original author's exact `CertifiedPostRefV1` bytes and adds the
sharer's separately certified action and proof.

Shares are flattened: sharing something discovered through a share still
shares the original post, never a share-of-share chain. One user ID can share
one original post once. Repeating it returns the existing action. V1 has no
unshare.

The sharer fans the certified share delivery to eligible followers and sends a
small notice to the original post author when remote. Likes and replies still
target the original post home.

### 4.4 Likes

A Like is an immutable, add-only action sent to the original post author. One
user ID can Like one post once. V1 has no unlike, re-like, or toggle.

The liker certifies the exact Like body, captures its proof, persists a
`CertifiedLikeReceiptV1`, and queues that exact receipt for the original
author. The post home performs cheap caller/post/deduplication checks and keeps
the receipt and notification in quarantine. Neither the accepted-Like set nor
a sealable segment changes until the owner's browser verifies the exact stored
receipt and promotes that notification. Invalid evidence is removed and frees
its pending capacity.

Successful browser verification and promotion of a Like arms one app-scoped
`like_seal` deferred timer for 60 seconds. Further verified Likes during that
window reuse the existing key without moving its deadline. The one-shot
callback walks the bounded circular authored-post cursor and publishes at most
eight Like packages, one per due post; each search examines at most 200 posts
and the callback stops when no due package is found. A ready 150-receipt
segment has priority and keeps the original immutable
`final_partial = false` representation. Otherwise, 1–149 browser-verified
receipts in the active segment may be published while the post remains open.
That immutable package uses `final_partial = true`; in V101 the frozen field
name is a package-size marker, not proof that the head has stopped accepting
Likes. Publishing the content-addressed package and advancing the mutable Like
head by exact CAS are one `certified_assets` commit, and a fresh empty active
segment receives later verified Likes.

The Like head points to the latest batch, records an author-declared cumulative
sealed count for chain validation, and says whether new Likes are accepted.
That declared total is never released as a verified UI count. Opening Likes
verifies the head, immutable predecessor chain, every package, and every nested
liker proof; visible people and counts include only receipts whose package and
nested proof succeeded. A failed or not-yet-loaded package is shown as
incomplete evidence, never as verified engagement or a false zero. One Worker
request verifies at most two packages and returns an opaque continuation for
older packages. Owner-local unsealed counts and liker IDs include only
browser-verified accepted rows awaiting a later seal pass. Pending quarantine
appears only as a pending notification; it never enters a segment, package,
public count, or liker list.

### 4.5 Withdrawal

Deleting a post creates a new immutable certified tombstone; it never mutates
or falsifies the original bytes.

Withdrawal is a resumable bounded state machine:

1. publish and prove the tombstone;
2. atomically stop new Likes in the certified head;
3. seal due and final partial Like batches;
4. suppress the post locally; and
5. durably queue the exact tombstone for the frozen eligible follower set.

Before fanout, the empty unsealed segments and sealed/accepted accounting prove
that every retained accepted Like belongs to a sealed package. Retention
reindexing then walks that post's sealed-batch number plus a bounded receipt
offset. It never searches the global accepted-Like index for rows belonging to
the post; a post with no Likes completes this phase in one bounded advance.
After the owner starts withdrawal, the open tile drives these bounded owner
calls to completion with an event-loop yield between calls. Closing rows resume
automatically when reopened. Cancellation or an error stops the UI loop and
leaves the durable cursor available for retry; a protocol-derived
100,008-call ceiling prevents a corrupt backend from returning an intermediate
stage forever. No backend call itself becomes unbounded.

A node that previously verified and shared the original may relay the exact
author tombstone along that verified share edge. Content is hidden only after
the author and post bindings verify. V1 has no undelete.

### 4.6 Profiles

The profile is one mutable certified Candid object at:

```text
/app/wagyu/_route/protocol/v1/profile
```

It contains the network ID, serving user ID, installation generation,
revision, update time, previous digest, display name, description, optional
capability tokens, and optional avatar.

Current bounds are:

- display name: 80 UTF-8 bytes;
- description: 1,024 UTF-8 bytes;
- avatar: JPEG, PNG, or WebP, at most 256 KiB and 1,024 × 1,024;
- no SVG, HTML, script, remote URL, or animation authority.

A fresh installation leaves this exact path absent. Local owner reads project a
revision-zero default from the trusted installation context without publishing
or persisting it. Wagyu binds that context lazily only while its managed memory
still matches the exact pristine schema state. The first accepted edit creates
revision one under an `absent` precondition; later edits use
generation/revision compare-and-swap and the kernel record identity. Missing
remote profiles are normal and presentation falls back to the user ID. Clients
verify present profiles for freshness and maintain a generation and revision
high-water mark. The profile name and avatar are display hints only; the user
ID remains visible and copyable.

## 5. Publish, Prove, Then Send

Posts, replies, shares, Likes, and tombstones use the same safety order:

1. An owner-authorized prepare update validates intent, encodes the exact
   Candid object, commits it through the Kernel certified-asset service, and
   records the authored action as `awaiting_proof`.
2. The browser fetches the exact public path and verifies the certified
   response locally.
3. The browser submits the exact bounded proof Candid as a `Blob` field to the
   matching finalize update.
4. Finalize binds the pending action ID and object digest, stores the portable
   proof/reference, and creates every required durable outbox or fanout record
   before any remote await.
5. Resident or scheduled work sends the committed payload.

Nothing is delivered before certification and proof finalization. A lost UI
continuation leaves an explicit authored recovery state; reopening Wagyu can
fetch the same immutable object and resume. Retrying prepare with the same
logical nonce or finalizing an already-finalized action returns the existing
state instead of creating another social action. Post nonce idempotency is a
direct durable nonce-to-post lookup; publication never scans authored history.

The backend validates proof shape and binding to its pending action, while the
source browser performs the cryptographic verification. A forged owner proof
cannot make a recipient render invalid bytes because each recipient performs
the full verification again.

Witness parsing is bounded by encoded bytes, total nodes, and embedded blob
bytes and uses iterative traversal. It has no independent tree-depth ceiling:
normal growth of the balanced certified forest must never become an authored
post-count quota.

## 6. Public Peer Protocol

All state-changing peer messages use Neutron `public_ingress` API 1 and the
one physical dispatcher:

```text
app_wagyu__wagyu_v1_update
```

The outer kernel wire is `PublicIngressRequestV1 { method; payload }`. The
payload is exact Candid for:

```text
WagyuIngressV1 {
  operation_id : Blob; // exactly 16 bytes
  body_candid  : Blob;
}
```

The logical routes and current manifest bounds are:

| Route | Request | Response | Shared/hour | Per caller/hour | Required cycles |
| --- | ---: | ---: | ---: | ---: | ---: |
| `follow` | 1,024 B | 256 B | 120 | 12 | 7,000,000,000 |
| `unfollow` | 512 B | 128 B | 240 | 24 | 50,000,000 |
| `deliver` | 16 KiB | 512 B | 1,800 | 240 | 200,000,000 |
| `like` | 8 KiB | 512 B | 1,080 | 120 | 250,000,000 |
| `notice` | 1,024 B | 256 B | 360 | 60 | 100,000,000 |

Every route accepts only a canister caller. The kernel binds and forwards the
real caller, enforces the static payment floor, shared and per-caller hourly
rates, byte, concurrency, reserve, lifecycle, and Settings policy, and invokes
the exact synchronous handler. A caller-rate rejection consumes no shared
route/app/global quota. Wagyu does not request supplemental cycles.

The receiver hashes `body_candid` before bounded decoding and deduplicates by
caller, route, operation ID, and payload digest. Exact replay returns the
stored outcome; reuse with different bytes is a conflict. An ambiguous remote
result must reconcile or retry the same durable operation rather than create a
new logical action blindly.

Normal resident and scheduled drains use the bounded automatic policy.
Definite pre-dispatch failures retry automatically. The one narrow semantic
exception is an unreceipted Like `full` rejection: it proves the receiver did
not commit that operation, so the exact Like may retry automatically after its
bounded delay. Any result that may have dispatched becomes exact
owner-selected recovery using the same durable operation and frozen bytes. It
is never retried by a normal batch. Retry jitter is deterministic from the
operation, target, and attempt.
Exhausting the kernel's UTC daily transfer allowance delays work until the next
budget window; it is not misclassified as a persistent low-balance pause.

Under Neutron's paid-ingress rules, a valid route floor is retained before
later app-level rejection. Underpayment traps. Unrequested surplus is refunded.
The sender separately pays IC request/response and byte charges.

### 6.1 Follow bond and delivery credits

A successful follow or renewal funds the publisher with 7,000,000,000 cycles
and renews a 400-day lease. Initial activation grants 32 delivery credits.
Every same-subscription renewal grants
`min(32, 128 - (available credits + outstanding restorable charges))`; it can
therefore grant fewer than 32 or renew only the lease at the cap. Credits are
accounting over the node balance, not escrow or a solvency guarantee.

Following uses a stable random subscription ID and compare-and-swap revision.
The follower records local receive intent before sending the paid registration,
so a fast first delivery can be admitted. UI may show `registering`,
`active`, `uncertain`, `conflicted`, or `incompatible`, but local intent remains
authoritative and stale async results cannot turn an unfollow back on.
Following capacity counts only live `on` intent; retained off rows preserve
generation/replay fences without occupying a live slot. A full notification
tray cannot reject an otherwise valid remote follower activation; the optional
new-follower notification is omitted.

Publisher-side follower admission uses the exact durable count of physically
active rows rather than traversing the follower map. An expired active lease can
therefore continue to occupy capacity until the bounded retention pass removes
it; renewing that same row does not consume another slot.

Unfollow disables local receive authority immediately and then sends a paid CAS
cleanup. Unused credits are not refunded.

One delivery attempt consumes one credit. The decrement and exact outbound
payload are committed before dispatch and restored only after a definite
pre-dispatch failure. A result that may have dispatched consumes the credit.
Expired, blocked, paused, or zero-credit followers are excluded. At four
remaining credits or fewer, a delivery requests renewal. The peer-controlled
hint remains diagnostic; it never authorizes local spending. V3 instead keeps
a sparse, durable, saturating counter for the current subscription. Only the
first successful promotion of a browser-verified delivery advances it; paid
ingress, replay, invalid evidence, and peer payload fields cannot. The 28th
promotion synchronously attempts to queue automatic renewal in that same
owner-authorized update, leaving a nominal four-credit delivery margin without
relationship discovery. Later verified promotions retry this direct trigger
if the outbox was full.

Accepted or duplicate acknowledgement of the current paid Follow resets the
counter. Failed or stale results preserve it; Unfollow and Block clear it.
Day 350 of the locally recorded paid epoch remains the independent resident
scan fallback. Before an automatically queued Follow can enter
7,000,000,000-cycle dispatch, direct lookups revalidate its frozen
subscription, current intent generation, pending outbox link, registering
status, and Block state. Stale work is superseded without dispatch.
Exact owner-selected recovery applies the same checks; a detached operation is
eligible only when its generation and subscription still match local
`uncertain` intent and its stored result may have dispatched.

The paid epoch is local authority: accepted or duplicate acknowledgement
anchors it to the operation's first durable local dispatch-start timestamp,
which is write-once across exact retries. A delayed duplicate callback cannot
move the epoch forward, and the peer's `local_receipt_time_ns` cannot choose an
automatic-spend deadline. Uncertain, rejected, and stale results preserve the
prior acknowledged paid anchor.

Fanout is paged in batches of at most 20 and freezes the follower registration
cutoff observed at finalization. A later follower does not receive an older
post simply because the job is still advancing. Creating a fanout job uses the
physical-active count only as a conservative, constant-time admission signal;
the job's public eligible and queued counts include only recipients actually
observed so far and become exact when the frozen scan completes. A population
with no eligible recipients can therefore create an empty job, which completes
and enters the seven-day terminal cleanup window on that bounded scan.

The debounced send-cost quote examines at most 512 registration-ordered
follower rows. When more physical active rows exist, registered and eligible
counts conservatively treat every unseen active row as eligible so the cycle
estimate cannot underquote; the ineligible count is then an observed lower
bound and the sorted recipient preview is a bounded sample. No public schema
field was added for saturation.

## 7. Certified Storage and Fetch

Wagyu's owner/backend calls are not an HTTP protocol. Separately, Wagyu uses
the Kernel's scoped `certified_assets` API-2 storage capability to publish
passive public Candid objects. The compiler derives the closed certified read
routes from those collection declarations; Wagyu does not author HTTP routes
or response policy. This is a kernel storage and response-certification
contract, not a second Wagyu self-call API and not an app-authored HTTP V2
calling protocol.

The manifest declares eight closed collections:

| Collection | Generic kind and addressing |
| --- | --- |
| posts | `immutable_blob`, body SHA-256 below its path prefix |
| shares | `immutable_blob`, body SHA-256 below its path prefix |
| tombstones | `immutable_blob`, body SHA-256 below its path prefix |
| Likes | `immutable_blob`, body SHA-256 below its path prefix |
| Like batches | `immutable_blob`, body SHA-256 below its path prefix |
| Like heads | `mutable_blob`, keyed path prefix with revision/content-tag CAS |
| reply indexes | `mutable_blob`, keyed path prefix with revision/content-tag CAS |
| profile | `mutable_blob`, one exact path, created lazily and then updated with revision/content-tag CAS |

The public base is:

```text
/app/wagyu/_route/protocol/v1
```

Immutable action paths are:

```text
/objects/<post|share|tombstone|like>/sha256/<object_digest_hex>
```

Like packages and heads use `/objects/like-batch/sha256/<digest>` and
`/heads/likes/<post_id_hex>`. Direct-reply indexes use
`/heads/replies/<post_id_hex>`. URLs contain no app-supplied host, absolute
URL, query, fragment, redirect, cookie, or credentials.

The kernel fixes `GET`, status, CORS, CSP, cache policy, content type, response
headers, digest, ETag, body length, certified absence, and certificate
expression. Immutable blobs receive immutable caching; every mutable blob,
including the profile, revalidates. Wagyu cannot invent response policy or
gain raw certificate-tree authority.

Portable objects are opaque exact Candid bytes to the kernel. The application
owns their semantic decoding. Certified HTTP proves serving-canister bytes and
policy, not confidentiality: these objects are public plaintext.

## 8. Owner Calls: One API, Nested Blobs

The tile and resident call the local Wagyu backend through Neutron's single
`preapproved_self_calls` API 1 using `querySelf()` and `updateSelf()`. The
transient tray has no backend or peer transport; it reads a closed snapshot
from the resident over the private app message bus.
The manifest lists each exact owner-authorized method and its query/update
mode. The kernel derives the source app, resolves the installed live Candid,
fixes the destination to the current Neutron, validates the complete value, and
signs with the current owner identity.

There is no preapproved-self-call API 2, binary attachment API, positional body
argument, attachment-direction declaration, generated signature repair, or
app-provided DID. Blob data is ordinary application data in the authored
Candid type and may appear many times or at any finite nested record, option,
variant, or vector position.

Examples include:

- `avatar.bytes : Blob` inside a profile edit record;
- exact original post-reference Candid inside share prepare;
- exact proof Candid inside finalize records; and
- exact feed, notification, and notification-evidence page bodies returned as
  nested `Blob` fields.

The browser representation is `Uint8Array`. Neutron snapshots and transfers
only Candid-typed binary leaves over the source-bound private message port,
with platform byte/leaf/depth/allocation limits. Wagyu then applies its tighter
protocol limits and hashes exact bytes before interpretation.

Local page and status methods are queries. Initial snapshot reads that do not
depend on one another are issued in parallel. Mutations are updates. A refresh
must not turn cheap local reads into peer polling.

## 9. Canonical State and Background Work

Managed Wagyu memory is canonical for:

- the optional owner-created profile and every present certified record
  identity;
- authored posts/actions and recovery stages;
- follower, following, block, lease, and delivery-credit state;
- quarantined and promoted feed records;
- notification summaries and Like evidence;
- Like heads, accepted receipts, sealed packages, and withdrawal state;
- certified direct-reply indexes for authored posts;
- direct authored-nonce, feed-slot, deduplication, and retention indexes; and
- the exact durable outbox, retry state, and fanout cursors.

All pages are bounded and cursor-based. Feed pages contain at most 25
candidates and notification pages at most 50. Either page examines at most 256
ordered rows in one query. When local Blocks hide a complete examined window,
the page may be empty but returns the last examined sequence as its exclusive
continuation, so later pages make progress without rescanning that window.
Backend adapters apply each documented multi-index state transition atomically
without an intervening `await`.

### 9.1 Resident browser service

Wagyu declares one persistent resident background. While the owner is logged
in it:

- reads bounded local status;
- reads the latest 20 local notification summaries while the tray is open;
- marks those displayed summaries read when the tray opens;
- owns the persistent verification Worker and mutable high-water cache;
- advances the durable outbox after foreground wake-ups;
- pages bounded local relationship rows for the day-350 fallback; the
  high-volume count path queues directly from matching verified promotions,
  and a remote low-credit hint is diagnostic and cannot spend;
- publishes app-local revision invalidations to open tiles;
- updates the kernel-owned tray badge from unread notifications only; and
- performs a normal status/recovery pass about once per minute, backing off on
  failure.

The once-per-minute time-fallback decision belongs to this browser resident,
not a backend scheduled task. Each conditional self-call rechecks canonical
local state before queueing, and the backend revalidates automatic Follow
authority again immediately before dispatch. At most four time-due
relationships are queued per pass; count-due relationships use the direct
promotion trigger instead of waiting behind the generic relationship union.

The resident never crawls peers. A live tile advances pending reply, Like, and
share notification evidence in bounded discarded pages even when Notifications
is not the selected view. Profile and feed hydration otherwise remains on
demand. While a tile is open, verified post cards in or just outside its
viewport refresh their certified Like evidence and direct-reply count every
10 seconds with at most four posts in flight; an open thread also reloads its
direct replies on that cadence. Hidden and unmounted cards do no peer work,
overlapping passes coalesce, and closing the tile cancels its continuations.
Resident failure degrades convenience and caching, not canonical safety.
The kernel gives a newly mounted authenticated resident 15 seconds to complete
its existing deployment-bound port handshake, remounts it once on timeout, and
then reports it blocked until a later valid handshake or deployment change.

The tile has one global refresh control in the top-right. It wakes bounded
outbound work and reloads the local snapshot. App-state invalidations trigger
the same local refresh path automatically; views do not each own a competing
refresh button.

### 9.2 Deferred batching and scheduled backend recovery

Verified Like promotion uses the declaration-free, kernel-bounded
`deferred_timers` backend interface. Its 60-second leading-edge key coalesces a
burst without paying for an idle recurring minute task. The timer is transient
across actor upgrades, while the accepted Like rows are durable.

The manifest retains a daily scheduled `outbox` task with `run_on_start` as a
bounded recovery and maintenance path. It receives a fresh invocation-scoped
backend-call capability, does bounded cleanup, attempts up to eight due Like
packages, and drains at most one outbox batch. Normal open-node progress comes
from the browser resident and event-armed Like timer rather than a permanent
one-minute backend loop.

Scheduled work can use only current install-approved backend reservations. It
cannot open a browser permission prompt. Outbox rows distinguish queued,
sending, accepted, duplicate, paused, failed, uncertain, and superseded
outcomes, and retain exact payloads for policy-approved retries.
After an accepted, duplicate, or superseded outbox row is fully reconciled,
its retention index is re-aged for cleanup seven days later. A detached
fanout target and then its terminal, targetless job receive the same bounded
seven-day window as each dependency is released; cleanup backlog can extend
physical residence. The current V3 schema has no compact operation-result
tombstone, so cleanup also removes the sender-local operation index and ends
sender-side audit/idempotency for that operation. A later replay may therefore
pay for another transport call, although the receiver's independently retained
ingress receipt can still return duplicate during its 400-day horizon
(1,825 days for Like receipts).

Status and drain summary projections inspect at most 512 outbox rows and 512
fanout jobs. Their counts are observed lower bounds when that limit is
saturated, and status conservatively reports pending work until a later
bounded pass proves otherwise; scheduling itself uses the ordered/circular
indexes rather than these diagnostic hints.
The scheduled backend task does not discover or initiate relationship
renewals; it may only deliver renewal work already queued by the UI resident.

### 9.3 Cross-app tools

The persistent resident owns Wagyu's generic cross-app tool surface. Agent is
not taught Wagyu methods: it discovers the live app, descriptors, closed JSON
Schemas, and tools through the ordinary kernel message bus. Every cross-app
call still requires the kernel's normal exact endpoint/tool permission and an
Agent Mode invocation does not broaden Wagyu authority.

The bounded surface covers:

- profile, Home, authored Posts/Replies, direct thread, Likes, and relationship
  reads; and
- Post, Reply, Like, Share, Follow, and Unfollow mutations.

The tool layer is an adapter over the same owner self-call service and resident
verification Worker used by the tile. It does not add backend methods,
certification rules, peer routes, or an alternate publication path. Scoped
owner calls retain the kernel-attested invocation context. The resident reuses
its deployment-bound trusted runtime and Worker rather than recursively
calling its own background endpoint.

Home returns at most 20 rows, authored Posts at most 25, relationships at most
20, and direct replies at most 25. Feed previews are text-bounded. Full remote
bytes stay quarantined unless exact verification and local promotion both
succeed. Peer profile and post text is labeled `external_untrusted`; it is
data, never authorization or an instruction to call another tool.

A verified read creates a random, short-lived, owner-bound opaque post target.
Thread, Likes, Reply, Like, and Share accept only such a target. They do not
accept caller-assembled authors, hashes, lengths, object digests, proof bytes,
or reply locators. Targets are rebuildable resident memory, capped at 256, and
expire after 15 minutes. Post and Reply additionally take a nonzero 16-byte
command ID, reused only for an exact retry, as their authored nonce.

Like remains add-only and rejects an owner-local target. Follow and Unfollow
accept only canonical canister user IDs and invoke the same relationship
state machine as People. After a durable mutation the resident wakes its normal
outbox and publishes its ordinary app-state invalidations; tool completion
does not claim remote acceptance.

## 10. Installation and Permissions

Wagyu declares only the authority it currently uses:

- managed private app memory;
- `public_ingress` API 1 for the five paid receiving routes;
- `backend_calls` API 1 for outbound peer calls;
- one method-scoped install reservation for
  `app_wagyu__wagyu_v1_update`;
- the declaration-free bounded `deferred_timers` backend interface;
- scheduled backend outbox work;
- `preapproved_self_calls` API 1;
- one persistent resident background plus a transient tray; and
- the scoped Kernel certified-asset service whose read routes are
  compiler-derived.

Accepting the app installation may create the declared peer-delivery
reservation as part of the same reviewed install. The owner does not need an
extra one-time setup step after a normal accepted install.

The runtime reservation request remains available because an older install may
not have created it and the owner may revoke it in Settings. Recovery remains
an explicit kernel/install action, not an approval banner above Home. Both
paths use the same kernel reservation model; Wagyu must not duplicate authority
state.

A reservation grants Wagyu's backend permission to call that method on
eligible non-system canisters within its concurrency and cycle ceilings. It
does not grant arbitrary raw calls, actor construction, another app's memory,
another method name, or trust in a destination.

## 11. User Interface

The primary UI is a normal social app. Cryptographic and economic details stay
under the hood except when the user must approve a permission, understand a
cost, or diagnose a failure.

### 11.1 Navigation and layout

Desktop uses three lanes:

1. a transparent left navigation lane;
2. a centered content lane, capped near 640 px; and
3. an empty right context lane of comparable width.

Only the two vertical hairlines separate the lanes. Home is first in
navigation, followed by Profile, Notifications, and People. The right side is
reserved for future use.

At narrow widths, the side lanes collapse into a five-position bottom
navigation. The colored Post action occupies the middle position. Desktop also
shows the colored Post action in the left navigation. The same composer
component opens from every page.

Lists are flat. Posts, threads, notifications, people, and empty states do not
sit in decorative cards. Horizontal hairlines separate timeline threads,
notification rows, and people rows. Responsive controls must remain readable
and must not wrap button labels into broken multi-line layouts.

### 11.2 Home and posts

Home is the feed. It does not contain a permanent composer at the top.

Home merges:

- the owner's current parent posts;
- verified parent posts and parent shares delivered by followed users.

Each Home row shows only the parent post. Verified and local replies remain in
the conversation index, but stay collapsed until the owner opens that post.
The visible direct-reply count comes from the parent author's certified reply
index. Opening the post adds its independently verified direct children. Home
rows are separated by a hairline. A newly received candidate occupies the same
basic avatar, text, and action-row geometry as a post while verification runs;
it exposes neither asserted profile text nor quarantined post text.

Each feed/authored lane mounts at most 60 social rows while retaining its
normalized cursor-backed data and scroll/window anchor. Notifications and Like
people mount at most 100 rows. Snapshot refreshes are singleflight and
coalesced; independent local slices settle separately, retain their last good
bounded page on failure, and show one degraded-state notice instead of blanking
unrelated views. Remote profile hydration is visible-only, singleflight, and
bounded by entry, byte, and short-time limits.

One shared live social-post renderer is used on Home, Profile, user profiles,
and thread pages. It owns author/profile presentation, body, reply context,
share context, and the Like, Reply, and Share action row. The row uses icons
and only counts available from evidence the current view has actually loaded,
never the author's declared cumulative Like total. The heart performs the Like
while the Like count opens Likes; the reply icon and count both open Reply;
Share is icon-only while no verified share count exists. The Likes drawer is
the complete presentation of the verified receipts loaded so far and labels
unavailable or remaining pages as incomplete. A count-only reply read verifies
the author's direct-reply index without fetching the reply bodies. It therefore
does not depend on whether the viewer follows each replying author. Opening the
thread verifies and releases the indexed direct children. The reply count does
not include deeper descendants. Visible-card refresh retains the greatest
verified Like lower bound observed by the tile because one bounded Worker page
may move older immutable packages behind its continuation; owner-local
authenticated receipts awaiting the next certified batch are additive only on
the owner's card. Starting a Like immediately marks the heart and raises a
session-local count floor by one. A failed durable handoff rolls that floor
back; later certified receipts meet or exceed the floor rather than being
added to it, so the optimistic Like cannot be counted twice.
An action may be disabled only when required verified evidence or permission
is unavailable. The action row aligns with the post body text, not the avatar
edge.

A reply shown outside its parent context has a small
`Reply to <name or user ID>` line with the resolved name in the accent color.
The line is omitted when the reply is already beneath that parent. The reply's
content area is the thread link, while action buttons remain separate controls.
The link has no background-changing hover effect.

### 11.3 Composer behavior

The modal composer is only for new parentless posts and prompts with “What's
happening?”. Replies never use a modal or popout. Choosing Reply opens the post
detail and uses the shared composer's inline form directly beneath the selected
post. Sending means completing the durable publication handoff, not waiting for
every remote recipient.

After a new parentless post is published, the composer closes and the app opens
Profile's Posts tab so the owner sees it. After a reply is published, the
inline form clears without changing the current page, refreshes authored/feed
state, and shows the reply under its parent.

### 11.4 Thread page

Selecting reply content replaces the center lane with an in-page detail view
named `Post`; it is not a modal or popout.

The available ancestor chain appears above the selected target. A compact
inline composer immediately below that target lets the owner reply without
leaving the thread; a successful durable publication refreshes the thread in
place. Only the selected target's direct replies appear below it in
chronological order. Deeper replies remain collapsed; selecting a direct reply
makes it the new target and reveals its own direct replies. Root, ancestors,
target, and direct replies use the exact same social-post renderer and action
implementation as Home. Conversation avatars share one vertical axis and render
above its straight connector; wrappers add no second horizontal indent. The
connector has no curved branches and its final 30 pixels are dashed.

### 11.5 Profile, People, and Notifications

Profile starts at the top of the content lane with a subtle full-width
background treatment and a bottom hairline. It shows avatar, display name,
description, copyable user ID, and an edit icon/button.

Profile has two authored tabs:

- **Posts** contains only parentless authored posts;
- **Replies** contains authored posts with a parent locator.

People provides Follow user, Following, Followers, and Blocked views. It
accepts an exact user ID, hydrates certified presentation data on demand, and
falls back to the ID when a profile is absent, unavailable, or unverified.
Follow direction is explicit. There is no manual Renew control; the persistent
UI background keeps active relationships funded from bounded local verified-
delivery accounting with a day-350 fallback. A peer-reported credit threshold
is display-only and cannot authorize the owner's cycles.

Selecting a verified post author or People-row identity opens that user's
certified profile and the verified posts or replies already present in the
owner’s local feed pages. Loading older entries continues the local feed query;
the profile view never crawls the peer for history. A compact follow icon in
the remote profile header uses the same relationship mutation as People and
changes to a non-destructive following state after success.

Notifications are local summaries for follows, Likes, replies, and shares.
Anonymous-looking users are shown by user ID until a verified profile is
available; the UI never says only “someone” when the authenticated caller ID is
known. Reply/share/Like content remains pending until its evidence verifies.
Verified reply/share/Like rows link to their loaded target post and open its
in-page thread; retry and verification controls remain separate actions.
Opening Notifications or the tray marks its loaded local summaries read and
refreshes the tray badge without deleting history; there is no manual
mark-read control. The tray is only a flat recent-notification list; it
contains no feed statistics, outbox projection, delivery controls, or
peer-fetched content.

## 12. Local Provisioning

Provisioning is architecture, not Wagyu runtime logic. The package contains no
installer hooks, repair scripts, or deployment extensions.

`wagyu-local.ndeploy.json` is the repository's format-3 local desired state for
three independent Neutrons labelled `alpha`, `bravo`, and `charlie`. One
provisioner command consumes the already-built kernel and Wagyu archives,
compiles the complete actor once, installs/reinstalls each node, binds each
canister's runtime configuration, restores certified package assets,
establishes configured authorization, verifies each node, and records their
labeled URLs in the config's private session.

A PocketIC path-only artifact declaration is sufficient for developer
iteration. The provisioner derives archive hashes and sizes internally during
reinstall; developers do not maintain digest/byte pins by hand. Production or
external release artifact sets remain exactly pinned.

The three labels are developer handles, not protocol identity. The three
canister principals are the actual Wagyu user IDs, and every node receives its
own state, runtime config, authorization, and URL.

## 13. Versioning, Tests, and Release Boundary

v0.3.6 is the current app release. The public protocol remains `wagyu_v1`, and
its checked-in `v101-v1` corpus is the frozen V1 baseline for the exact public
and owner DIDs, nested Candid fixtures, generated bindings, and golden
encodings. CI requires `didc`, compares generated bindings byte-for-byte, and
independently checks the ReplyIndex encoding in Motoko.

The current package uses memory schema V3 and does not import older
development state whose accepted Like rows lack durable browser-verification
evidence. Preproduction installations are destructively reinstalled. A fresh
V3 install starts the sparse local verified-delivery renewal counter empty.

Future supported releases must retain each published corpus and run explicit
previous/current Candid compatibility checks; a same-version local development
rebuild is not a published release identity.

The checked-in public DID and nested Candid fixtures freeze the V1 baseline.
Extensible variants are carried inside optional fields so an older decoder can
classify an unknown tag as unsupported without losing the surrounding record.
Unknown fields or variants must never be guessed.

The implementation must retain focused tests for:

- hash/path/Candid golden vectors and rolling decode compatibility;
- caller binding, route bounds, paid admission, dedupe, and replay;
- follow CAS, block policy, leases, credits, and frozen fanout;
- prepare/finalize publication order and recovery;
- feed quarantine, verification promotion, author-served reply indexes,
  notifications, Likes, and withdrawal;
- exact profile/avatar bounds and nested self-call Blob transport;
- verifier certificates, witnesses, paths, fixed headers, semantics,
  freshness, raw-Candid bounds, and atomic high-water rules;
- resident isolation, readiness remount, persistence, cancellation,
  retry/backoff, and scheduled recovery;
- package/manifest capability consistency; and
- responsive, accessible shared social UI behavior.

Passing unit tests or a three-node PocketIC smoke does not establish the
Kernel's production certified-asset, gateway, and browser envelope. Until
release-bound measurements are recorded, Wagyu remains a limited-release
candidate.

## 14. Frozen V1 Invariants

The following changes require an explicit protocol/version decision rather
than a silent UI or implementation shortcut:

1. One canister principal is one Wagyu user ID.
2. Kernel-authorized owner credentials are never social users.
3. Feed discovery is sender-push, not peer polling.
4. A receiver admits feed delivery only from a currently followed caller with
   the matching subscription.
5. Inter-canister updates are bounded, paid, caller-bound, and idempotent.
6. The author certifies and proves an action before any delivery is queued.
7. Exact Candid bytes, not reconstructed values, are hashed, certified,
   forwarded, and retried.
8. Remote bytes remain quarantined until browser verification succeeds.
9. Posts, shares, Likes, and tombstones are immutable action objects.
10. Replies are posts with verified parent locators.
11. Shares preserve the original reference and never form nested share chains.
12. Likes and shares are unique and add-only in V1.
13. A withdrawal is a certified tombstone and bounded closing flow, not
    deletion of history.
14. The backend is canonical; browser storage is a rebuildable cache.
15. Owner UI calls use preapproved self-calls API 1 with ordinary nested Candid
    `Blob` fields.
16. Kernel certified assets is a scoped publication substrate, not a Wagyu
    self-call API or app-authored HTTP calling protocol.
17. One shared social-post component and one action implementation render every
    live post and reply context.
18. The parent author serves direct-reply discovery; every reply body remains
    independently certified and verified from its actual author.
19. Cross-app tools reuse the same owner and verification paths and never
    accept caller-constructed certified-object metadata.
