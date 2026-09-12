# Feedback implementation and release plan

## Product

Build a small Feedback app in `apps/feedback` and a separate persistent Ashroot
protocol in `support/feedback`. A submission belongs to its Neutron canister,
independently of the browser or an app reinstall. The user confirmed that every
submission is private to the sender and assigned moderators.

Four choices share the same compact flow:

- Report a problem: request help with Neutron or an app.
- Share feedback: leave a comment without an expectation of a reply.
- Suggest an app: describe something the user would like to use.
- Suggest a feature: describe an improvement to Neutron or an existing app.

The tile has My messages, New message, discussion, and a role-gated moderator
inbox. Moderators can view and reply, but cannot edit or delete user content or
assign other moderators. Blast CLI identity 0 is the protocol administrator and
assigns moderators by Neutron principal. No uploads: messages can contain links
to images published in Files → Shared.

The resident owns a tray badge and exposes user and moderator Agent tools.
Agent reads do not implicitly acknowledge replies. Reading an actual discussion
acknowledges only the last message displayed, preserving later replies.

## Architecture

- Ashroot tables and indexes retain submissions, messages, moderator roles,
  per-Neutron unread state, read delegates, and idempotent request identities.
- App writes go through its Neutron backend, which pins the protocol and exact
  allowed methods. The protocol checks the actual caller for every operation.
- Browser queries use a durable app-local read identity registered by that
  Neutron. The delegate cannot create submissions, reply, or assign moderators.
- A single resident client serves the tile, tray, and Agent tools. Protocol
  errors remain distinct from empty results; interrupted sends retain their
  request ID and draft for safe retry.
- Use the shared Neutron design system with compact rows, plain wording,
  accessible controls, narrow-tile layouts, and explicit empty/error states.

## Confirmed decisions and moderator setup

- All four kinds are private to the sending Neutron and assigned moderators.
- At the user's request, Blast identity 0 assigned moderator access to
  `3rurp-vyaaa-aaaay-aacua-cai`. The production operator postflight verified
  active assignment row 1 on 12 September 2026.
- The user approved 160 Unicode code points per title, 16,000 per message,
  and 30 results per page. The protocol and UI enforce the text bounds; larger
  protocol page requests return at most 30 rows with a continuation cursor.
  No other bounds were added.

## Validation and release

1. Implement protocol authorization, indexed pagination, idempotency and unread
   behavior; test fresh initialization and a state-preserving upgrade with data.
2. Implement app managed memory v1 and test initialization/restoration, typed
   transport, both sets of Agent tools, tray/read races, and retry behavior.
3. Exercise all UI pages at narrow and wide sizes, including empty, loading,
   failure, unread, user discussion and moderator discussion states.
4. Deploy a new empty protocol canister with reviewed Wasm and public Candid
   metadata. Retain exact artifact digests and deployment evidence. Reconcile
   deployment-account funding before creation. Never replace existing canisters.
5. Build Feedback 0.1.1 with the complete workspace package command and shared
   `LICENSE.APP.USE`/offered-source workflow. Publish it free under the existing
   aae publisher through Marketplace, then verify receipt-v2 no-op publication.
6. Add the same verified Feedback archive to the existing lean Dispenser set,
   run its checks, stage once, and verify the new live starter receipt.

## Repository references

- [App developer guide](app-developer-guide.md)
- [Design system](design-system.md)
- [App tray](app-tray.md)
- [Managed memory](memory-migrations-and-uninstall.md)
- [Package publication](package-updates.md)
- [Marketplace operator workflow](../support/marketplace/OPERATIONS.md)
- Ashroot's installed `ashroot docs guide`, `migration`, and `performance`.
- [Motoko persistence](https://docs.internetcomputer.org/languages/motoko/fundamentals/actors/data-persistence/): retain the actor memory root and verify representative data after an upgrade.
- [IC principal model](https://docs.internetcomputer.org/concepts/principals/): authenticate the sending canister and resolve read delegates without treating a principal as code attestation.
- [IC cycle costs](https://docs.internetcomputer.org/references/cycle-costs/): size the new protocol's initial balance against measured installation and idle-memory cost on a current public application subnet.

## Qualification status — 12 September 2026

Feedback 0.1.1 passed 40 TypeScript tests, the Motoko managed-memory restoration
test, and real-protocol integration covering automatic first-use registration,
user/moderator discussion, unread acknowledgment, role revocation and recovery
of a lost response after reload. The final browser run passed 23 check groups
with 72 screenshots across 320–1280px, no browser errors, and no horizontal
overflow. It includes Unicode limits, both reply roles, saved sends and editing
a fresh copy of an earlier oversized submission.

The approved-bounds Ashroot protocol passed 11 PocketIC suites, including clean
initialization, privacy, authorization, idempotency, unread races, indexed
pagination, Unicode boundaries and page clamping. Both a populated keep upgrade
and an upgrade from the exact archived initial Wasm preserve data and permit
subsequent writes. The latter also preserves previously accepted oversized
messages and successful retries. Protocol schema version 1 remains unchanged.
The operator wrapper passed 15 tests with 74 assertions using actual Blast
result projections; its documented command was also verified against production.

The frozen `feedback.v0.1.1.neutron` archive is 435,617 bytes, SHA-256
`f2bd2a40b95554425e0803c1550b806256be40198f0bc28b84d3e7e5087671bb`.
The complete package command passed. The existing 19 Dispenser tests, license
checks and security checker passed; a separate combined-starter qualification
compiled this exact archive with Kernel, Marketplace, Files, Contacts, Wallet,
EVM Wallet and Agent. The seven existing package hashes match the preceding
selection. Local compilation does not itself stage the production starter.

The current release receipt is
`.neutron/release-receipts/feedback-v101-2026-09-12T18-07-26Z`, also named by
`.neutron/feedback-next-release-path`. It retains the frozen app and offered
source, final app/browser tests, `protocol-bounds-build-inputs.tar.gz`, protocol
qualification, `operator-cli-fix/`, and `starter-local-qualification/`.

## Production status and initial release history

The protocol was installed successfully on 12 September 2026 at
`ld53o-fyaaa-aaaai-ax54q-cai` after the user's 30 trillion cycle top-up.
The production postflight verified module SHA-256
`007dd539b527a8416de605c1d16b317e21d542aec3aa9f13308e0f42213bb20b`,
protocol/schema version 1, and Blast identity 0 as administrator. Installation,
module/controller evidence and the confirmed moderator assignment are retained
in the current receipt. Future protocol changes use state-preserving upgrades.

Marketplace publication succeeded as batch 16: Feedback 0.1.1 and its matching
offered source were published atomically, free under aae. Repeating the exact
publication command against the same bytes returned receipt-v2 `batch_id: null`;
all 28 packages and 28 offered sources were unchanged and matched their local
versions, paths, sizes and digests. The production catalog now includes Feedback.
The icon and two screenshots were published at listing revision 2; repeating the
media command verified unchanged media with zero update calls and preserved the
free aae listing and release.

The Dispenser starter was staged once and committed as revision 8, deployment
`94e213ce3992e78cd23d4f15b8786a0c`. Its read-only postflight matched the exact
eight qualified packages, compressed Wasm, 480-file commitment and backend
targets. Newly dispensed Neutrons receive Kernel, Marketplace, Files, Contacts,
Wallet, EVM Wallet, Agent and Feedback. Existing Neutrons can update Feedback to
0.1.1 through Settings → Installed Apps; publication does not install updates
automatically. The current receipt retains publication/media no-op results,
`starter-postflight.json` and the completed `release-state.json`.

The initial 0.1.0 history remains unchanged in
`.neutron/release-receipts/feedback-2026-09-12T17-21-35Z`. It retains successful
mint/create arguments and ledger blocks, the initial qualified Wasm and private
build-input archive, and the installation rejection for insufficient up-front
cycle reserve. Its empty-canister status is historical, superseded by the
successful installation recorded in the 0.1.1 receipt. Never repeat the completed
mint or creation. Preserve both receipts and the original qualification as
evidence of the tested transition.

## First-launch fix and retained state

The user installed 0.1.0 and reported “Your saved Feedback identity is
unavailable.” The Kernel omits absent optional record fields; Feedback wrongly
required `seed` to be present before initializing it. Version 0.1.1 fixes that
boundary and the equivalent absent final-page cursor handling. Regression tests
now exercise the actual Candid-to-Kernel-to-SDK projection, including a fresh
absent seed, an existing seed, saved-request results and broker replies.

The app retains managed-memory schema version 1, the existing seed and saved
requests; no migration or reset is introduced. Version 0.1.0 package bytes,
schema source and lock lineage remain archived unchanged. Protocol authorization
still precedes private access, and successful request IDs are reconciled before
new-content length validation so retries survive the approved bounds.
