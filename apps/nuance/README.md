# Nuance

A Neutron client for [Nuance](https://nuance.xyz), the on-chain blogging platform.
Browse, read, comment, and publish — plus a shared draft that a human and an agent
edit together.

This app is maintained in `apps/nuance`. The import preserves its released memory
schemas and the existing v1-to-v2 migration; no Kernel changes are required.
Research notes are kept outside the repository.

## What it does

- **Browse and read.** Latest and popular feeds, full-text search, related
  articles, comment threads with author names resolved. Cover images render as
  row thumbnails and as a capped cover in the reader; body images render inline.
- **Write.** A compact editor over a backend-held draft; publish to Nuance or save
  there as a private draft.
- **Revise.** Pull one of your own published articles back into the editor.
- **Collaborate.** The draft lives in the backend, so the tile and an agent edit
  the same document under compare-and-swap.
- **Agent tools.** Thirteen tools on the resident background, so all of the above
  works with no tile open.

## The identity to know about

This app calls Nuance as **the Neutron canister's own principal**, not the owner's
Internet Identity.

Internet Identity principals are scoped per origin, so an identity created at the
Neutron origin could never be the owner's nuance.xyz account anyway. The canister
principal is used instead because it is the only identity that lets an agent post
with no tile focused and no per-call dialog.

The practical consequence: **this is a separate Nuance account with its own
handle**, registered from the Account view. Articles published here are not
attributed to an existing nuance.xyz handle. The app says so in Account and in the
`nuance_whoami` tool rather than letting it be discovered later.

## Architecture

The app is split by **who pays for the call**.

```
                     free, anonymous queries
 tile (index.html) ──────────────────────────────────────────────────> Nuance
 background ─────────────────────────────────────────────────────────> Nuance
      │  │
      │  └── querySelf / updateSelf ──> Motoko backend ─> backend_calls ─> Nuance
      │      (preapproved, no dialog)   managed memory (drafts, reading list)
      │
      └── exposeTool(...)  <── Agent Mode, under the owner's normal grant
```

Nuance's entire read surface — feeds, articles, comments, search, tags, profiles —
is public `query`. Queries are free and are answered in about a tenth of a second,
so the tile and the resident background call Nuance **directly and anonymously**.
Routing those through this canister turned a free browser query into a replicated
inter-canister update the Neutron's owner paid for.

What is left in the backend is what the browser cannot do:

- **Writes** — publish, comment, vote, applaud, register.
- **Caller-scoped reads** — `nuance_my_posts`, which Nuance scopes to the caller.
- **Durable app state** — the shared draft, the reading list, the shard
  write-allowlist. Its reads are canister queries, which are also free.

Two honest consequences. Query replies are not certified, so the boundary node is
trusted for display data exactly as it is for any web page reading the IC; writes
still go through the backend and stay consensus-verified. And the reader's IP is
visible to the boundary node, where previously the canister made the request —
nothing else is sent: no identity, no credential, not even which Neutron is
asking.

Nuance shards posts across bucket canisters, so a feed is a two-phase read: the
index (PostCore) knows ids and counters, and each bucket knows titles. Reads need
no reservation at all. Writes do: shard principals are held in managed memory as
`Principal` values, never parsed from text at runtime — `Principal.fromText`
traps, and PostCore is free to return a shard id this app has never heard of. A
shard this app cannot write to is listed in Account with a Grant button, so
commenting on an article stored there fails visibly rather than mysteriously.

## Collaborative drafting

The draft is backend state with a monotonic `revision`.

- Every write is compare-and-swap on the revision the writer last read. A write
  that lost the race is rejected with the **current draft attached**, so the loser
  rebases without a second round trip.
- Agent patches are exact-substring ops applied atomically. An anchor that matches
  zero or more than one place is an error, not a guess — an agent that
  half-matches prose destroys the human's writing.
- After an agent write the background publishes a same-app invalidation. The
  editor re-reads and adopts silently, unless the human has unsaved keystrokes, in
  which case their text is kept and the external edit waits behind a banner.

No CRDT. Two actors on a short article do not justify one, and compare-and-swap
fails loudly instead of merging two prose edits into nonsense.

## Layout

```
backend/
  main.mo                  writes, caller-scoped reads, drafts, reading list
  memory/nuance/v1.mo      released schema, byte-frozen -- never edit
  memory/nuance/v2.mo      current schema
  memory/nuance/v1_to_v2.mo  forward migration: drops the old content cache
  nuance/Types.mo          Candid shapes: complete for sends, minimal for receives
  nuance/Client.mo         request builders and reply decoders
  nuance/Markup.mo         editor text -> article HTML (publish only)
  nuance/Draft.mo          the patch engine (pure, exhaustively tested)
src/
  nuance/idl.ts            Candid interfaces for the browser read path
  nuance/client.ts         direct anonymous reads from the Nuance canisters
  markup.ts                article HTML -> editor text
  api.ts                   the data layer: reads direct, writes via the backend
  index.tsx  views.tsx  editor.tsx  html.tsx  ui.tsx  format.ts
  service.ts               resident background: the agent tools
```

## Commands

Release 0.1.11 moves package updates to the Marketplace repository at
`sj2r4-haaaa-aaaay-aadgq-cai`, preserving drafts, bookmarks, and the complete
existing memory migration path.

Release 0.1.10 adds the production update source. Install this package once over
an older copy marked **Manual** to enable future Settings updates, using the
state-preserving [package update workflow](../../doc/package-updates.md).
Existing drafts, bookmarks and the complete memory migration path are retained.

```sh
npm --workspace neutron-nuance run package    # build the .neutron archive
npm --workspace neutron-nuance test           # package + all suites
npm --workspace neutron-nuance run verify:live # check projections against live Nuance
```

`verify:live` is deliberately outside `npm test`: it needs the network and depends
on a third party. It reads mainnet only — it never registers a handle, comments,
or publishes.

The release tests include an actual local-canister publish regression, retained
schema/closure checks against the imported 0.1.8 archive, and Chromium editor
workflows at 320, 360, 480, and 960 pixels. The browser and local-canister tests
use controlled replies; they do not publish to Nuance.

In 0.1.9, edits typed during a save stay dirty until saved, and a failed or
conflicting save stops publication. A publish response preserves edits made
while waiting and cannot recreate a discarded draft. Overlapping publications
of one draft submit once. Confirmed comments remain successful even if the
subsequent public refresh fails.

## Deliberate limitations

- **A lost publish reply needs reconciliation.** Check My posts before publishing
  again: Nuance may already have saved the article. The overlap guard lasts for
  the actor lifetime; it is not a durable idempotency guarantee across upgrades
  or uncertain network outcomes.

- **The text round trip is lossy.** `nuance_draft_load` flattens an imported
  article to plain text, so bold, italics, and inline links do not survive a
  revise-and-republish cycle. The editor says so before you overwrite a live
  article.
- **Links in the reader do not navigate.** The tile sandbox has no
  `allow-popups`, so `target="_blank"` is inert. Links render with a copy button
  instead of a dead affordance.
- **Third-party images are not loaded.** Only IC gateway hosts render. Nuance
  keeps its own media on one asset canister served from `.icp0.io`, so in practice
  every real article image loads; anything else would report every reader's IP to
  an arbitrary host on open, and shows as a captioned placeholder with a copy
  button instead.
- **Nuance's list titles are pre-truncated at 60 characters.** Feed rows show
  Nuance's truncation; the real title comes from opening the article.
- **Premium and members-only articles return an empty body** to accounts that are
  not entitled. That is shown as an explicit state, never as a blank article.
- **Nothing is pinned.** A Nuance interface change breaks decoding at runtime, not
  at compile time. Decode failures surface as visible errors, and `verify:live`
  is the early-warning check.
- **`nuance_recent_since` keeps no watermark.** Storing one would mean a canister
  write on every poll. The caller passes back the `newest` id from its last reply
  instead, and the tool says so when it has nothing to compare against.
