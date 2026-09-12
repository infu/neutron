# Feedback protocol

A private support inbox for Neutron. Users send support tickets, feedback, app
ideas, and feature ideas through the separate `apps/feedback` application.
Messages contain text and links. Images stay in the user's shared Files; this
protocol does not fetch those links or store image uploads.

Tickets are conversations between their author and the assigned support team.
Feedback and suggestions can also receive replies, but do not enter the
**Needs reply** ticket queue. Authors can resolve or reopen their own support
tickets. Moderators can read conversations and add replies; they cannot edit or
delete messages, change the author's ticket status, or assign other moderators.

## Identity and access

Mutation callers are Neutron canisters, following the established Marketplace
caller convention. Caller identity is authenticated by ICP; the opaque-principal
check is not an attestation of which code that canister runs. The app's backend
pins the protocol target and exposes only the six application mutation methods.
No protocol fee or attached cycles are required for these calls.

Each Neutron authorizes one browser read identity through `read_delegate_set`.
The app keeps its Ed25519 seed in its managed memory root and restores it in
each browser. Replacing that identity updates the owner's row and removes the
old browser binding. After an app reinstall, registering the new seed restores
access to the same Neutron-owned remote history. Delegation authorizes queries
only; creating tickets, replying, and acknowledging responses still travel
through the Neutron. Every moderator query and update checks the current role,
so revocation takes effect for an already-connected app immediately.

All four conversation kinds are private to their author and the assigned
support team, as approved for this release. A user's ordinary queries
return only their own conversations, even if that user is also a moderator.
The separate moderation methods require an active assignment.

## API

The canonical types are in `mo/API.mo`; the build emits the public Candid
interface at `build/feedback.wasm.did`. All methods return `{ ok; err }` variants
with a `code` and readable `message` on errors, except `feedback_info`, which
returns public protocol metadata directly.

| Surface | Methods |
| --- | --- |
| Connection | `feedback_info`, `session`, `read_delegate_set` |
| Author queries | `my_threads`, `thread`, `messages` |
| Author updates | `thread_create`, `reply`, `mark_read`, `issue_status_set` |
| Moderator queries | `moderation_threads`, `moderation_thread`, `moderation_messages` |
| Moderator update | `moderation_reply` |
| Administrator | `moderators`, `moderator_set` |

`my_threads` filters by optional kind and unread replies; `moderation_threads`
filters by optional kind and **Needs reply**. The latter means an unresolved
issue whose last message came from its author. Reopening an answered ticket
does not change who wrote its last message: adding details requests another
support response. Resolving a ticket does not erase its discussion or replies.

Conversation cursors are activity numbers in newest-first order. Message
cursors are IDs in oldest-first order. Cursors continue the current ordered
view; refreshing the first page reveals new activity. Callers choose a positive
page size; requests above 30 are returned as pages of at most 30 rows, with a
continuation cursor when more remain. This applies to author, moderator,
discussion, and administrator-assignment pages.

Titles accept at most 160 Unicode codepoints, and each message accepts at most
16,000. A non-BMP emoji counts as one character. Overlong new content returns
`title_too_long` or `message_too_long` without changing the conversation. These
user-approved bounds apply to initial messages and both author and moderator
replies. Successful prior request IDs are reconciled before length validation,
so a retry can still recover a previously accepted response after an upgrade.

Create and reply requests carry durable caller-scoped request IDs. Repeating an
identical request returns the same conversation or message. Reusing an ID for
different content returns `request_conflict` and changes nothing. Create and
reply IDs have separate namespaces; author and moderator reply IDs share a
namespace for the same caller, and changing the role is also a conflict.
Clients retain an unresolved request's exact contents and ID until the outcome
is known.

`mark_read` takes the last **displayed** message ID, not an unseen final message
from the thread summary. Each stored message carries the cumulative moderator
reply sequence at that point. Read markers advance monotonically, and only the
newly read delta is removed from the owner's aggregate unread count. A later
response arriving before acknowledgment stays unread. Reading one page cannot
silently acknowledge later pages. Read acknowledgment does not reorder history.

## Moderator administration with Blast identity 0

The production administrator is:

```text
y7t6r-gtsqz-45ogs-2k3gk-l6hic-2h7wm-zosg6-uldzf-l4ams-2jaky-wqe
```

The operator wrapper uses Blast identity 0, verifies its public principal and
the target protocol's administrator, then performs the requested assignment:

```sh
npm --workspace neutron-feedback-protocol run operator -- grant --canister <feedback-id> --neutron <neutron-id>
npm --workspace neutron-feedback-protocol run operator -- revoke --canister <feedback-id> --neutron <neutron-id>
npm --workspace neutron-feedback-protocol run operator -- list --canister <feedback-id>
```

`list` returns a page and optional `nextCursor`; continue with `--cursor <id>`.
The wrapper does not export or copy the Blast signing secret. The same public
contract is available directly through Blast:

```sh
blast principal --id 0
blast schema <feedback-id> moderator_set --id 0
blast call <feedback-id> moderator_set '[{"neutron":"<neutron-id>","active":true}]' --id 0
blast call <feedback-id> moderator_set '[{"neutron":"<neutron-id>","active":false}]' --id 0
```

An assignment grants support access to that Neutron, not to the CLI identity or
a browser principal. The app discovers the role through `session` and displays
its support section. No Neutron is assigned automatically.

## Storage and build inputs

Storage uses Ashroot revision
`4f38466b3cef32c41e157383b2001921a531b771` and Motoko core v2.6.0.
`ashroot.json`, generated `.ashroot/`, and `.private/` follow the repository's
private database-input convention. Restore the reviewed private build inputs
before building. The schema has five tables and one singleton:

| Root content | Stored purpose |
| --- | --- |
| `threads` | Ownership, kind, immutable initial intent, issue state, discussion totals, read sequence, activity |
| `messages` | Append-only messages and permanent reply request IDs |
| `delegates` | One active browser principal for each Neutron |
| `moderators` | Neutron assignments including revoked records |
| `owners` | Exact aggregate unread reply count per Neutron |
| singleton | Administrator and next activity number |

Each combined list filter has an explicit indexed selector. The author tree
contains `(owner, selector, activity)` and the moderator tree contains
`(selector, activity)`. A row emits its all-kind and specific-kind selectors,
plus unread or needs-reply selectors when applicable. No list filter scans
another owner's rows or a whole conversation table. Discussion pages use the
`(threadId, messageId)` index; tray counts use a single owner lookup.

For initial private-input preparation, the installed Ashroot CLI provides:

```sh
ashroot validate ashroot.json
ashroot generate ashroot.json
ashroot runtime deploy .private/ashroot
ashroot runtime verify .private/ashroot
mops install
```

The reviewed `.private/storage-inputs.json` receipt records SHA-256 hashes of
the schema, generated ownership manifest, and runtime ownership manifest. Build
verifies each manifest's owned file size and hash, then uses the repository's
pinned Motoko compiler. Ordinary builds do not regenerate private storage.

```sh
npm --workspace neutron-feedback-protocol run build
npm --workspace neutron-feedback-protocol test
```

The test harness pins PocketIC 10.0.0, `@dfinity/pic` 0.16.1, and `didc` 0.5.3
with binary hashes. It tests actual installed canisters and emits
`build/test/qualification-bounds.json`, binding the Wasm hash, test-source hash, test
results, and installation metrics. Coverage includes clean initialization, all
four private kinds, author isolation, delegate replacement, moderator grant and
revocation, idempotent requests, unread races, indexed pagination, author-only
ticket status, Unicode length boundaries, page clamping, and a populated **keep**
upgrade followed by new writes. The previous unbounded candidate's qualification
remains archived unchanged; an additional exact-predecessor upgrade checks that
its longer accepted content and successful request retries survive these bounds.

## Production installation and future upgrades

The production protocol canister is `ld53o-fyaaa-aaaai-ax54q-cai`. Its initial
module was installed on 12 September 2026 after the user's 30 trillion cycle
top-up. The production postflight verified module SHA-256
`007dd539b527a8416de605c1d16b317e21d542aec3aa9f13308e0f42213bb20b`,
protocol/schema version 1, and the explicit Blast identity 0 administrator.
Deployment and exact module evidence are retained in
`.neutron/release-receipts/feedback-v101-2026-09-12T18-07-26Z`.

The original qualified inputs remain unchanged in
`.neutron/release-receipts/feedback-2026-09-12T17-21-35Z/protocol-build-inputs.tar.gz`.
The approved-bounds qualification and new archive belong to the separate receipt
directory named by `.neutron/feedback-next-release-path`. The original local
`build/test/qualification.json` is also retained; the current run writes
`build/test/qualification-bounds.json`. The original receipt's rejected install
and empty-canister status are historical. The current receipt records the
successful installation of the approved-bounds Wasm; preserve both sets of
evidence and do not repeat completed funding or canister creation transactions.

The one-time initialization used this explicit administrator record:

```candid
(record { administrator = principal "y7t6r-gtsqz-45ogs-2k3gk-l6hic-2h7wm-zosg6-uldzf-l4ams-2jaky-wqe" })
```

At the user's request, Blast identity 0 assigned moderator access to
`3rurp-vyaaa-aaaay-aacua-cai`. The current receipt's
`moderator-list-postflight.json` verifies active assignment row 1. Further
assignments use the operator commands above.

Production installation requires an up-front execution reserve in addition to
the default 30-day freezing reserve and ingress cost. The local measured
installation charge does not describe the liquidity needed to admit the call.
Check live status before future upgrades and retain exact transaction receipts.

Use ICP CLI's explicit `--mode install` only for a verified empty canister.
Archive the exact compiled Wasm, Candid, stable signature, application sources,
schema, generated files, runtime, dependency sources, compiler identity, and
qualification evidence. Record the installed module hash and controller set in
the release receipt before pinning the canister in the app.

Future releases retain the `memory` root and use explicit
`--mode upgrade --wasm-memory-persistence keep`. Test the exact archived
production predecessor with representative data before installing its successor.
A code-only release retains schema version 1 and restores the same root.
Storage changes need a new schema and explicit migration using frozen prior
generated inputs; never replace released schema or runtime evidence in place.

Ashroot's `archive` and `deploy-check` commands currently integrate with DFX;
they do not automatically protect an ICP CLI install. Follow the repository's
state-preserving protocol upgrade process and bind the exact before/after bytes
to the tested transition. App publication and Dispenser starter staging remain
separate from deployment of this shared protocol.

Primary references: the installed `ashroot docs guide`, `ashroot docs migration`,
and `ashroot docs performance`; the
[ICP interface specification](https://docs.internetcomputer.org/references/ic-interface-spec/);
and [Motoko data persistence](https://docs.internetcomputer.org/languages/motoko/fundamentals/actors/data-persistence/).
