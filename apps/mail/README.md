# Neutron Mail

Mail is a ciphertext-only, one-recipient messaging app for Neutron canisters.
The product and security contract is in [todo.mail.md](todo.mail.md); the
generic app-isolated key subsystem is in
[the platform documentation](../../doc/app-isolated-vetkeys.md), with its
implementation checklist in
[../kernel/todo.vetkeys.md](../kernel/todo.vetkeys.md).

## Implemented foundation

- immutable Mail memory V1 with bounded Inbox, Sent/Outbox, unread indexes,
  rolling admission queues, dedupe, permits, command ledgers, and tombstones;
- strict fixed-width `mail_receive_v1` envelopes, authenticated caller binding,
  exact unknown/known throttles, ciphertext quotas, and atomic commits;
- fixed 50-row encrypted owner pages, exact get/mark/delete, and
  revision-bound cleanup APIs;
- outbound recipient preparation and send/retry state with server-issued,
  single-use permits, command idempotency, and commit-before-await Outbox state;
- Contacts V2 Neutron-address lookup/search and encrypted sender-settings CAS;
- list/get reprojects the current Contacts name and trust for each exact
  canister address; `known_at_receipt` remains immutable quota/admission
  history and is never treated as current trust;
- an unknown Inbox sender has one add-to-Contacts icon that opens a validated,
  unsaved Contacts draft with the sender-supplied name and authenticated
  canister principal; one normal kernel tool approval gates the handoff and
  Contacts remains responsible for the explicit Save;
- deterministic CBOR, AES-256-GCM envelope/AAD code, recipient and sender CEK
  wraps, safe Markdown, and no plaintext fallback;
- the shared `vetkeys` manifest/compiler/SDK capability, Mail's pinned official
  vetKeys browser adapter, public-key setup, focused-tile slot reservation,
  dedicated-origin crypto worker, non-extractable WebCrypto AES keys,
  app-isolated key recovery, bounded volatile key custody, and a fixed seven-day
  encrypted VetKey cache in worker-only IndexedDB;
- install-reviewed delivery access for the shared public-ingress dispatcher
  `app_mail__mail_v1_update`; its `key_info` and `receive` route ids share one
  method-wide backend reservation, fresh installs need no later access dialog,
  and Send never opens a persistent backend-access prompt; key discovery transfers
  `50_000_000` cycles and each delivery or retry transfers `250_000_000`
  cycles to the recipient Neutron;
- private tile/tray projections and constant-cost authoritative unread polling
  of this same Neutron every 30 seconds while healthy; Mail never polls another
  Neutron for messages, unchanged local pulses do not fetch full status, list
  rows, or decrypt headers, and 60/120/240/300-second failure delays reset after
  a successful pulse;
- bounded decrypted resident list/get/search projections, encrypted sender
  settings, compose/send/reply, and current/previous local-wrap migration, with
  key handles confined to the resident worker and bounded plaintext projected
  only to same-app tile/tray views and kernel-authorized tool callers;
- contextual post-await supersession: an initial Send returns
  `delivery_state_changed`, retains its draft, and makes no safe-replacement
  claim, while an explicit Outbox retry returns `not_retryable`;
- a closed, bounded 14-tool resident agent contract: 12 operation tools for
  Contacts recipients, list/search/get, send/reply/retry, mark/delete, cleanup,
  and sender settings, plus `mail_help` and `mail_status`. Every cross-app call
  uses Neutron's kernel-owned tool permission path; inbound content is labeled
  `external_untrusted`, and nested backend calls retain invocation scope.

Activation is no longer blocked on a shared-key placeholder. Installation
grants the reviewed Mail V1 update-dispatcher scope. First-run setup reserves
Mail's declared `mailbox` slot and caches its public information in the Mail
backend without a second access dialog. Existing or manually revoked
installations missing that scope show `Finish Mail setup`; reading and composing
remain available, while Send stays disabled until the dispatcher scope is present.
After setup, Send never asks for persistent backend access. A stronger
whole-canister reservation can still make one recipient unavailable; Mail
preserves the draft and directs the user to Backend Access instead of requesting
access during Send. Resident startup only synchronizes public lifecycle state;
it never restores or derives a private key. When private data is needed, Mail
restores each required current or retained previous generation from its exact
encrypted cache entry or derives it into the resident crypto worker on a miss.
Read-only `mail_status` polling may observe an already-live or authenticated
cached handle, but never starts a paid derivation.
Every principal currently authorized for
the Neutron may read the same Mail history. The slot key manager alone controls
lifecycle operations; it is not the only authorized reader. The tile, tray,
and resident tools use the same on-demand decrypted reader/composer, encrypted
delivery, Reply, sender settings, and rotation migration workflows. Neutron
authenticates cross-app callers and obtains tool permission before invoking
Mail; Mail does not maintain a second per-app plaintext grant. Mail's active
installed-product smoke opens and configures the primary local Neutron selected
by the shared schema-3 provision session.
Cross-canister delivery, privacy,
cleanup, and rotation invariants remain in the Bun and Motoko suites; the old
test-owned multi-canister release environment is retired.

Compose is one activation: if a cold resident still needs the Mail key, the
composer route remains selected while `Preparing private Mail…` is shown and
opens automatically when recovery completes. There is no unlock action or
second Compose click.

Key recovery coalesces concurrent requests for the same generation inside one
resident and uses one origin-wide lock to coalesce cache misses across tabs.
The lock holder rechecks the live lifecycle binding and worker-only cache before
paying for a derivation. Independent residents keep independent volatile
handles but share only the encrypted cache. The kernel applies no fixed-hour
vetKeys budget or client cooldown; bounded pending work, concurrency, attached
cycles, and the low-cycle reserve remain. A remote mailbox's inbound junk
throttle is a separate Mail protocol policy for unauthenticated external
senders.

Mail has no attachments or HTML mail. Markdown links are displayed and copied;
they are never fetched, previewed, redirected, or opened by the app.
Hostile Markdown is bounded by deterministic tree, depth, text, link, code, and
table budgets and fails closed to one inert notice before React rendering.

## Security boundary

Message headers, bodies, and the sender display name are never accepted by a
backend in plaintext. Backend state stores ciphertext plus visible routing and
quota metadata. The authenticated inter-canister caller is always the From
address. A saved Contact means `In Contacts`; it is not a claim that the remote
canister runs official or immutable software.

Mail is a paid push protocol. The sender fetches the recipient's current public
key with a funded update and pushes each ciphertext with another funded update;
the recipient never polls senders. The route base charges are static Mail V1
protocol constants declared in the manifest and transferred only through the
kernel-owned, app-bounded backend-call broker. An underfunded public call traps
before Mail runs. Mail does not request a supplemental charge in V1: senders
attach exactly the static base. The delivery base is a conservative estimate
for dispatch and validation work plus retaining one maximum-size ciphertext for
several months; it is not a promise that every message consumes exactly that
amount.

Outbound command and retry tombstones retain the newest 2,048 entries for
lost-response idempotency and diagnostics. That bounded history is not a
security boundary: a deleted or cleaned local id cannot dispatch again,
consumed permit ids are never reissued, and every safe retry keeps the same
authenticated sender/message id for recipient-side deduplication.

A durable `Sending` attempt that loses its continuation during an upgrade has
a frozen five-minute recovery boundary. Fresh retry request ids coalesce before
that boundary; at or after it Mail advances the attempt and redispatches only
the exact stored envelope. Late callbacks are superseded, while the receiver's
authenticated `(sender, message_id)` dedupe makes an earlier remote commit safe.

The two inter-canister response methods use a frozen compact `NMK1`/`NMR1`
payload inside Motoko's exact canonical one-`blob` Candid wrapper. Delivery
parses that wrapper and payload with bounded byte arithmetic and never applies
`from_candid` to an untrusted reply. A malformed or semantically equivalent but
differently encoded outer Candid value fails closed as Recipient unavailable or
Delivery uncertain; V1 interoperability therefore requires this exact wrapper.

Mail uses the generic source-bound `vetkeys` capability; it has no Mail-only raw
management call, shared key area, browser-persisted plaintext key, or plaintext
compatibility mode. Production actors select `key_1`, while local provisioning
selects `test_key_1`; neither environment falls back to the other. A usable raw
VetKey is volatile browser-worker state, although its serialized bytes exist
briefly inside that worker while an authenticated encrypted cache record is
written or restored. This is not absolute secrecy from an active controller,
compromised browser/app version, or failure of the IC threshold protocol.
Disable, retirement, logout, and uninstall also cannot guarantee erasure of a
durable key record or plaintext already copied elsewhere. See the platform
vetKeys documentation for the exact threat and restore boundaries.

Mail declares
`capabilities.persistent_browser_storage: { "api": 1, "surface": "background" }`
so the
resident runs on its verified, dedicated app origin. That real but app-isolated
origin makes its Blob crypto worker a secure context, which is required for
non-extractable WebCrypto AES-256-GCM keys. The install dialog discloses the
resulting ability to use origin-scoped storage. Only the crypto worker opens
Mail's IndexedDB. It stores one non-extractable AES-256-GCM wrapping
`CryptoKey` and authenticated ciphertext for the serialized current and, while
retained, previous VetKey. Cache AAD binds the exact installed instance,
dedicated-origin authority, generation, environment key name, and live public
fingerprint. The authenticated ciphertext contains the full context public key
and effective IBE identity. Restore revalidates the live backend and enabled
kernel slot with the exact generation, key name, and fingerprint, checks that
the cached public key hashes to that fingerprint, then re-verifies the VetKey's
BLS signature against the authenticated public information. The kernel
namespace makes that public information deterministic for one installation,
slot, and generation. Expired, corrupt, mismatched, and
no-longer-current/previous records are pruned. Each valid record has a fixed,
non-sliding expiry exactly seven days after the successful derivation that
created it.

Mail does not put a VetKey or wrapping key in `localStorage`,
`sessionStorage`, Cache Storage, VFS, a backend, or a worker message, and it
never persists a CEK, transport secret, plaintext, or decrypted index. The
strict resident CSP still permits no network connection or form action, the
kernel targets the resident's exact app origin, and the app-prefixed HTTP host
cannot serve kernel or sibling-app assets. There is no JavaScript AES fallback:
if secure `SubtleCrypto` is unavailable, private Mail fails closed.

The wrapping key and ciphertext nevertheless belong to the same app origin.
Non-extractability prevents `exportKey` from returning the AES key; it does not
prevent current or future same-origin Mail code from asking WebCrypto to use
that key. A compromised controller/app update, injected same-origin script,
browser, extension, or operating system is therefore outside this cache
boundary. Honest Mail refuses cache restore while the slot is disabled or its
binding differs and prunes stale records when it can run, but Disable and logout
clear live handles rather than cryptographically revoking or synchronously
erasing the durable record. It can remain until observed and pruned, its fixed
seven-day expiry, or browser-site-data clearing. Re-enable within that period
may reuse it. Reinstall/origin rotation prevents the new origin from reading the
old record, but does not promise physical browser/OS erasure.

## Validation

From the repository root:

```sh
npm --workspace neutron-mail run validate
npm --workspace neutron-mail run typecheck
npm --workspace neutron-mail test
npm --workspace neutron-mail run package
npm run provision -- MAIL-E2E.ndeploy.json serve
npm run provision -- MAIL-E2E.ndeploy.json reinstall
npm --workspace neutron-mail run test:e2e:typecheck
NEUTRON_NDEPLOY_CONFIG=MAIL-E2E.ndeploy.json \
  npm --workspace neutron-mail run test:e2e
```

The normal Mail test command includes browser/unit tests and the Motoko
protocol, memory, receive, store, Contacts-recipient, and encrypted-settings
suites. `MAIL-E2E.ndeploy.json` above means a separately named archive-only
format-3 config whose closed artifact pins include Mail. The tracked
`local.ndeploy.json` is also format 3. The active Playwright smoke resolves the
canister, gateway, and local developer identity from the selected config and
its one matching schema-3 provision session. It performs no canister creation,
installation, snapshot, clock, or fixture-state operation of its own. Set
`NEUTRON_NDEPLOY_CONFIG` to select that provision config; direct runtime
overrides and older config/session formats are not supported.

The source manifest currently declares 19 logical methods and every ordinary
method wrapper requires Neutron owner authorization. The synchronous
`mail_key_info_v1` and `mail_receive_v1` handlers are additionally bound to the
declared `mail_v1` public-ingress routes `key_info` and `receive`, both reached
through `app_mail__mail_v1_update`. They are not anonymous
APIs: the kernel preserves the real IC caller and the `caller: "canister"`
routes require `50_000_000` cycles for `key_info` and `250_000_000` cycles for
`receive`. The sender attaches those exact amounts, including on an
exact-envelope retry. The kernel accepts the positive base before dispatch;
because ordinary user ingress cannot attach cycles, that payment is the proof
of canister-mediated transport. Mail does not reclassify the principal. It
uses the captured immediate caller as the sender and retains its separate
self-mail rejection.
Remote Mail canisters are normally outside the recipient kernel's authorized
principal set, so accepted delivery/key-info updates consume the declared
public-ingress external-traffic windows. Kernel authorization never substitutes
for the required cycle attachment or changes the captured caller. This kernel
protection is separate from Mail's own known/unknown-sender and storage
admission policy.
The package test verifies that the rebuilt `mail.v0.3.3.neutron`, distribution
manifest, and generated schema contain the same complete method set. The
historical full release-evidence archive
`f94f42e52e4dab4dfc47d3abf37c2e3b48ac568cdc1cd39d95e6a32a794e6e52`
records 223 Bun tests with 2,063 assertions across 36 files, all 16 Motoko
suites, typecheck, E2E typecheck, package validation, and twenty
installed-product Playwright flows without skips in 10.9 minutes. That retired
browser run covered real two-Neutron encryption/decryption, complete plaintext
sentinels, external-delivery throttling, accessibility/performance, cleanup
races, and key rotation. Hash-bound raw evidence, including its stopped
disposable network log, remains under
`e2e/evidence/f94f42e52e4dab4dfc47d3abf37c2e3b48ac568cdc1cd39d95e6a32a794e6e52/20260716T020435Z/`.
