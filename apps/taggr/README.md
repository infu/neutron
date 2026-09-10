# Taggr

A Neutron client for [Taggr](https://taggr.link), the decentralised social
network running on the Internet Computer at `6qfxa-ryaaa-aaaai-qbhsq-cai`.

Browse the feed, follow conversations, discover realms and tags, search, read
profiles, and publish — from inside your own Neutron, with a resident
background that exposes the same surface to agents.

## Shape

The network side is **frontend-only**: nothing in this app's backend talks to
Taggr, and it asks the kernel for no authority to do so. The backend exists for
one thing — keeping the account key — and the resident background makes every
call itself:

```
tile (React)  ──same-app message bus──►  resident background
                                              │  Ed25519 identity
                                              │  @dfinity/agent
                                              ▼
                                  Taggr canister (icp-api.io, or a local gateway)

                          resident background ──self call──►  this app's own
                                                              canister memory
                                                              (the account key)
```

Three things follow, and all three are visible in Settings.

**Taggr's API is not Candid.** Almost every endpoint is exported as
`canister_query <name>` / `canister_update <name>` and reads raw UTF-8 JSON
argument bytes, replying with raw UTF-8 JSON (`serde_json` on both sides). Only
a handful of methods — `add_post` among them — use Candid. The client speaks
both, the same way Taggr's own frontend does.

**Reads are ordinary queries.** They are not replicated, cost the owner
nothing, and return in milliseconds. That also makes them safe against the
Taggr read endpoints that call `mutate(...)` internally to avoid cloning
(`user`, `realms`, `all_realms`, `realm_search`): a query method's state
changes are always discarded.

**The account is this app's own key, not your Neutron's principal.** Taggr
identifies users by caller, so whatever signs the calls is the account. Keeping
a separate key means the account is portable between clients and the kernel is
never asked to sign anything on Taggr's behalf — but it also means this app
makes network calls the kernel does not mediate. The key is backed up in this
app's own managed memory, as described below.

### Where the key lives

**In this app's own canister memory, inside your Neutron.** The key is the
account, and an account that lives in one browser is an account a cleared cache
destroys — Taggr's own principal-change flow needs the *old* key to authorise a
move, so there is no recovery from that.

The backend (`backend/main.mo`, one store, `backend/memory/identity/v1.mo`)
keeps the raw 32-byte Ed25519 seed; the public key and the principal derive from
it, so there is nothing else to hold. Five owner-authorized methods reach it,
listed in `preapproved_self_calls` so this app's own background calls them with
no per-call dialog and no other app can call them at all:

| Method | | |
| --- | --- | --- |
| `taggr_state_read` | query | the key, deployment, and domain, in one round trip |
| `taggr_identity_initialize` | update | save the first key, returning the existing key if another browser initialized first |
| `taggr_identity_write` | update | replace the saved key when the owner imports or starts a new identity |
| `taggr_identity_clear` | update | forget it, when the owner starts a new identity |
| `taggr_settings_write` | update | the deployment and domain, so a restore returns to the same view |

The background's browser origin — the `persistent_browser_storage` capability —
still holds a **cache** of that key so an existing account remains available if
a self-call fails. Each background start first tries to restore the canister's
copy. A tile frame is credentialless and cannot hold it at all, which is why
the background is the only surface with either the key or a network call.

`identity_sync.ts` reconciles the two, and every case is about not losing an
account:

1. The canister has a key — adopt it. **A browser that has never seen this
   account lands here**, which is what makes clearing site data survivable.
2. The canister has none and the browser does — adopt the browser's and push it
   up. Installations that predate this store land here exactly once.
3. Neither — create one and initialize the store atomically. Concurrent cold
   browsers adopt the same saved key before caching it.

A canister that cannot be reached never causes a *new* key to replace a
reachable old one. The app falls back to an existing cache and Settings reports
the failed synchronization. A browser without a saved key must reconnect before
it can restore or create its identity.

Settings still offers **export**, **restore**, and **start a new identity**.
Export is two steps — reveal, then copy — because the kernel accepts a clipboard
write only from a focused tile with live transient user activation, and the
backup has to come from the background first. It is now for portability, not
for survival: the account is usable from another client only if you have the
string.

What this does not protect against: a destructive reinstall of the Neutron wipes
app memory along with everything else, and anyone who can read the canister's
stable memory can read the key. Both are properties of where you chose to put
it.

### What the tile can and cannot reach

The tile drives the background over the same-app message bus, which needs no
owner consent. The background exposes two families of tools:

- `taggr_*` — agent-facing. Cross-app invocation passes through the kernel's
  consent dialog.
- `ui_*` — this app's own tile, annotated `same_app` so the kernel filters them
  out of other apps' catalogs and rejects cross-app invocation. `ui_configure`
  and `ui_identity` additionally check the caller, because those two can move
  the account.

The five `taggr_*` backend methods are not tools at all: they are
owner-authorized methods on this app's own backend, reachable from this app's
own surfaces through `preapproved_self_calls` and from nowhere else.

The background checks every method name against a read or a write allowlist
before it builds a call. The write list is deliberately small: no editing,
deleting, moderation, credit transfers, proposals, or governance.

## Registration

Taggr accepts a new account only with an invite code, or after an ICP payment
has been credited to the principal's Taggr invoice. This app cannot create an
account without one of the two, and Settings offers both.

### Paying the invoice through Wallet

The invoice is an ordinary ICRC account on the ICP ledger:

```
{ owner: <taggr canister>, subaccount: principal_to_subaccount(<this app's principal>) }
```

`principal_to_subaccount` is Taggr's own derivation from `env::invoices` — one
length byte, the principal, zero-padded to 32 — so the destination is fixed by
Taggr and by which key this installation holds. No other account can be funded
by mistake, and no other principal's invoice can be paid by this one.

**Check the price** calls `mint_credits_with_icp(0)`, which creates the invoice
at Taggr's current XDR rate if there is none and returns it *unpaid* rather than
erroring — so the exact amount can be shown before anything is committed to.
**Pay … ICP and register** then hands that destination and amount to Wallet's
`wallet_fund_v1`.

That tool is annotated `"neutron:consent": "provider_once"`. The kernel suspends
this app's call, opens **Wallet's own tile**, and Wallet prepares the
authoritative facts, renders its own review, and moves the value under its own
reviewed authority. This app never sees a balance, a ledger handle, or the
owner's approval — it names a destination and an amount and learns afterwards
whether the transfer happened. A session grant cannot stand in for that
decision; it resumes only this one call.

Once Wallet reports `transferred`, `mint_credits_with_icp(1)` settles the funded
balance into the paid invoice that `create_user` checks, and the account is
created. Anything other than a completed transfer stops there with Wallet's own
reason, and Wallet's reply is checked against the request it answers — Wallet
stamps each one `"<caller app>:<requestId>"` — so a stale or mismatched reply
cannot be read as this payment's outcome.

Before calling Wallet, the background saves the exact funding request in a
versioned browser record, scoped to the Taggr canister and account principal.
An interrupted reply or background reload reuses that request, including its
original ID. A confirmed transfer proceeds to invoice settlement without
another payment. Taggr's invoice check also recognizes funds already credited
to the account. A confirmed registration remains successful if a later refresh
or tile notification fails.

The payment record survives a normal reload but is not synchronized between
browsers. If browser storage was cleared while a transfer is still pending,
reconcile its original request in Wallet before initiating another payment.
The account key has a separate durable canister backup.

Wallet may not be installed, which is an ordinary situation rather than a
defect: its absence is reported as a choice, with the invite-code route still
open. The invite route needs no payment and no Wallet at all.

## Agent tools

| Tool | Purpose |
| --- | --- |
| `taggr_status` | Deployment, feed domain, the principal it posts under, account state |
| `taggr_feed` | Hot, new, personal, or realm feed, paged |
| `taggr_thread` | A post in context: its ancestor chain plus its direct replies |
| `taggr_search` | Full-text search |
| `taggr_tags` | Trending tags |
| `taggr_realms` | List or filter realms |
| `taggr_user` | One profile by handle |
| `taggr_user_posts` | A user's posts |
| `taggr_post` | Publish a post or reply |
| `taggr_react` | React to a post |

Both writing tools check for a registered account first, and every reading tool
bounds its payload well under the 1 MiB message-bus ceiling.

## Images

Taggr posts embed attachments as ordinary Markdown, `![alt](/blob/<id>)`, and
keep the bytes in per-user **bucket canisters**. The post's `files` map keys
each attachment `"<id>@<bucket>"` with a `[offset, len]` byte range, and the
bucket serves it over raw HTTP:

```
https://<bucket>.raw.icp0.io/image?offset=<offset>&len=<len>
```

So an `<img>` renders them with no canister call — the app frame's CSP sets no
`default-src`, leaving `img-src` unconstrained. `/blob/<id>` resolves against
the owning post's own file map; an id the post does not carry renders a marked
placeholder rather than a broken image. Any attachment the body never
references is shown in a row beneath it, so nothing is silently dropped.
External `![](https://…)` images render too, with `referrerpolicy="no-referrer"`.

**Realms** carry a logo, which Taggr stores as bare base64 PNG bytes; the realm
browser shows it, falling back to the realm's initials. The base64 is validated
before it becomes a `data:` URL, so a malformed record cannot choose some other
URL scheme.

**Users have no avatars.** Taggr's `User` record carries no image field and its
own client renders handles alone. The monogram beside each handle here is
derived locally from the handle — a stable letter and hue so a dense feed has
something to scan by — not data from the network.

## Conversations

Taggr splits a conversation in two, and the client rebuilds it. `thread(id)`
returns the **ancestor chain** — `State::thread` walks `parent` upwards and
reverses — not the replies, and a post carries only the ids of its children. The
conversation view issues `thread(id)` followed by `posts(children)`, and
`taggr_thread` returns the same combined view with a `focusPostId`.

## Domains

Taggr serves one canister under many hostnames, and each one is a different
view of the network. `state.domains` gives every hostname a realm blacklist or
whitelist, an optional journal owner, and a downvote ceiling — mainnet currently
registers a dozen, from the DAO-managed canonical name to community domains that
whitelist a single realm.

A browser front end uses its own `location.hostname`. This app has no Taggr
hostname, so it resolves one: `<canister>.icp0.io` — what Taggr's own client
calls the canonical domain — then `<canister>.ic0.app`, then `localhost`, which
every `State::init()` inserts and which is all a local deployment has. It never
picks a community domain on its own, because those carry someone else's policy.
Settings lists them all if you want one.

`localhost` was the old default here and was the wrong one on mainnet: it is a
local-development artefact that happens to exist there, and its `max_downvotes`
is **0**, which makes it *stricter* than the canonical domain, not the wildcard
it looks like.

The domain filter runs in two places, and this client applies both, as Taggr's
own does:

- **The backend** applies the realm scope (`domain_realm_post_filter`) — an
  unregistered hostname yields an empty feed rather than an error, which is why
  the empty state says so.
- **The client** applies the rest (`postAllowed`): the realm's own downvote
  ceiling from `meta.max_downvotes_reached`, then the domain's ceiling, then the
  realm scope again. A suppressed post is replaced by a line saying where it is
  suppressed and a button to show it anyway — Taggr renders its own `NotAllowed`
  notice the same way — rather than vanishing. `taggr_feed` and `taggr_thread`
  report the same thing in a `suppressed` field, so an agent does not conclude a
  post does not exist.

## Settings

- **Taggr canister** — mainnet by default. Point it at another deployment to
  browse a local or staging Taggr; nothing else needs changing, because the app
  signs its own calls.
- **Reading as** — the hostname above, or "follow this deployment". The picker
  shows what each domain does: who runs it, which realms it carries, and where
  it draws the downvote line.

## Known limitations

- Polls are read-only.
- An image hotlinked from outside Taggr is loaded when the post is shown, which
  tells that host the viewer fetched it. Taggr's own client behaves the same
  way; gating it behind a click would be a reasonable follow-up.
- No editing or deleting. `edit_post` replaces a post's file references
  wholesale, and this client has none to send, so offering it would risk
  dropping another client's attachments.
- External links in post bodies are marked text with the destination in a
  tooltip, not anchors: a tile frame is sandboxed without `allow-popups`, so a
  real link could only navigate the tile away from the app.
- Reads are single-replica queries, like every other Taggr client's. They are
  not certified.

## Build

Release 0.1.7 adds the production update source. Install this package once over
an older copy marked **Manual** to enable future Settings updates, using the
state-preserving [package update workflow](../../doc/package-updates.md).
The existing identity and browser storage are retained.

```sh
cd apps/taggr
npm run package        # validate, build, mopack, schema, metadata, pack
npm test               # package, Bun suites, and Motoko memory tests
```

`npm test` covers:

- `test/client.test.ts` — argument encoding against Taggr's own convention, the
  Candid `add_post` encoder and reply decoder, replica-host selection, and the
  method allowlists;
- `test/api.test.ts` — the request each typed call emits, the Rust `Result`
  unwrapping that keeps a failed write from looking like a success, and the
  two-read conversation view;
- `test/identity.test.ts` — key creation, stability, export/restore, reset, the
  corrupt-storage and no-storage paths, and the settings migration off the old
  literal `localhost` default;
- `test/identity_store.test.ts` — the self-call wire to the backend store: the
  Candid option and variant shapes, a key of the wrong length refused rather
  than signed with, and a failed call surfaced rather than swallowed;
- `test/identity_sync.test.ts` — the reconciliation, case by case: restoring an
  account into a browser that has never seen it, adopting the key an older
  installation already had, and never minting a new account when the Neutron is
  unreachable;
- `test/domain.test.ts` — domain resolution against the entries mainnet Taggr
  actually returns, and the suppression rules from Taggr's own `postAllowed`;
- `test/wire.test.ts` — reply parsers against `serde_json`-shaped fixtures;
- `test/markdown.test.ts` — block parsing and the inline tokenizer;
- `test/images.test.ts` — bucket URL construction on both networks, the
  `"<id>@<bucket>"` split including malformed keys, image tokenisation, realm
  logo validation, and handle monograms;
- `test/tools.test.ts` — loads the background with the SDK stubbed, runs the
  kernel's own `normalizeToolDescriptor` over every descriptor it registers, and
  drives `ui_register_with_icp` against a stubbed Taggr and a recorded Wallet:
  the funding request it builds, the settle-then-create ordering, that a paid or
  already-registered account spends nothing, and that a decline, a mismatched
  reply, or a missing Wallet each stop the flow;
- `test/wallet.test.ts` — Taggr's invoice subaccount derivation and its ICRC
  encoding, and the funding request validated against Wallet's own published
  `walletFundingInputSchema` rather than a copy of it;
- `test/package.test.ts` — manifest shape, the absence of every kernel
  capability this app does not need, that every preapproved method is one the
  backend declares and that the read stays a query, tool visibility, archive
  paths, the remote resource scan, and that the tile bundle carries neither the
  key nor a network host.

```sh
npm run test:motoko
```

`test/backend.test.mo` drives the real `Init` class: a short seed refused, a
32-byte one stored and read back, settings written without disturbing the key, a
rejected write changing nothing, and `taggr_identity_clear` forgetting the key
and only the key.

## Browser coverage

```sh
npm --workspace neutron-taggr run test:browser
```

The app-local Playwright fixture runs the real UI and parsers in a sandboxed
frame, with controlled same-app tool replies. It checks pagination recovery,
late reads, publishing while the draft changes, identity import/export,
registration state, search routing, and layouts at 320, 360, 480, and 960 pixels.
The browser suite is part of `npm test`; it performs no network writes.

## Contract verification

`npm run verify:contract` checks the **shipped client** against a **real Taggr
canister**. It starts its own PocketIC instance on free ports, so it neither
needs nor disturbs the provisioner's fixed gateway on 8000:

```sh
TAGGR_WASM=/tmp/taggr/target/wasm32-unknown-unknown/release/taggr.wasm.gz \
  npm --workspace neutron-taggr run verify:contract
```

The verifier uses the repository's pinned PocketIC binary by default.
`POCKET_IC` overrides that binary. An older server can fail while creating the
NNS needed by the local ICP ledger.

It drives `src/taggr_client.ts` behind `src/taggr_api.ts` with a real Ed25519
identity — exactly what the background does in a browser — and checks that
`config` still reports the `feed_page_size`, reaction ids, and post cost the UI
hard-codes; that onboarding works from ICP invoice through credits to an
account; that `add_post` encodes as Taggr's Candid signature expects for both a
root post and a reply; that the conversation view lines up with Taggr's split
thread model; and that a rejected write surfaces Taggr's own reason instead of
reporting success.

It also walks the whole Wallet registration route with Wallet's part played by a
plain ledger transfer, which is the only way to know the price is real: that an
untouched invoice can be **priced** without paying anything, that the ICRC
account the client would hand Wallet is the one Taggr credits — the destination
is built by `src/wallet.ts` itself, not a copy of its derivation — and that
paying exactly the quoted amount settles the invoice `create_user` checks.

`npm --workspace neutron-taggr run verify:mainnet` checks anonymous production
queries through the shipped client. It reads feeds, domains, realms, tags,
search results, conversations, and a public profile. It performs no updates;
registration and write coverage belongs to the isolated contract test.

## Local development and upgrades

Keep the upstream [Taggr checkout](https://github.com/TaggrNetwork/Taggr) outside
this repository. Build its bucket and Taggr canisters with `FEATURES=dev`, then
pass the resulting Wasm to `verify:contract` above. The verifier creates its own
isolated local instance; it does not need an old repository's Neutron provision
configuration.

`local:taggr` is an optional helper for an existing local replica. Inspect its
configuration before using `install` or `fund <principal>`; the latter pays a
local Taggr invoice for the identity shown in Settings.

The app retains the `identity` memory root at version 1. The release lineage
test compares the candidate archive to the exact imported version-105 schema
and lock; the Motoko tests cover fresh state and restoring a populated root.
Use Neutron's checked in-product install transaction to update an existing app.
Reinstalling an existing Neutron would destroy the stored key and other data.

## Licence

`LicenseRef-Neutron-Sovereign-Application-Use-License-1.0`. See `NOTICE` and the
repository `LICENSE.APP.USE`.

Taggr itself is a separate GPL-3.0 project; this client contains none of its
code and speaks to it only over its public canister interface.
