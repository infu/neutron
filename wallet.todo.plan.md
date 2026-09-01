# Wallet funding and approvals implementation plan

Status: implemented and release-qualified in the working tree across the SDK,
Kernel, Wallet backend/resident/UI, Kitchen Sink, tests, and documentation.
Exact Kernel, Wallet, and Kitchen Sink candidate archives have been built with
the repository's Nix toolchain and published to the production update source in
atomic batch 36. No package was installed into an existing Neutron, and this
plan remains release evidence rather than publication authority.

Final verification checkpoint (2026-09-01):

- Full repository gate passed under `nix develop`: `npm test`.
- Independent `npm run typecheck`, `npm run security:check`, and
  `npm run license:check` gates passed.
- Kernel tests passed: 699 Bun tests and all 31 Motoko programs. The exact
  Kernel candidate passed binding verification and the 12-sample certified
  assets qualification.
- Wallet tests passed: 65 Bun tests, the complete focused Motoko graph, and the
  production-memory release test. Fresh initialization and upgrade from the
  archived production Wallet retain `wallet` v1 and initialize only the
  additive `wallet_commands` v1 root.
- Compatibility tests cover ordinary existing tools/session grants, archived
  Wallet behavior on the new Kernel, new Wallet failure-before-effect on an old
  Kernel, and human/root-agent/nested-agent provider decisions.
- The pinned Chromium/PocketIC Kitchen Sink qualification passed against the
  ICP ledger, including a post-fix rerun against the exact final candidate
  bytes. It proved a direct 0.01 ICP transfer to Neutrinite governance and a
  short-lived allowance whose sole spender is Neutrinite governance, with
  exactly one `frontend-tool-dialog` and no call/backend dialog for each
  action. Kitchen Sink never called `transfer_from`.
- Kernel `0.3.23` candidate: 2,448,813 bytes, SHA-256
  `e2e5cea791af54a5052f227fcda57f07ecec1a5b4d11bfb5c79696c75d826334`.
  Its offered-source artifact is 3,007,430 bytes, SHA-256
  `7dd544994c3caab7954a470de37ccc960ede16f181976a30b55011ddedffcab8`.
- Wallet `0.3.6` candidate: 666,413 bytes, SHA-256
  `bea0d49e351bb8efa04bf03057b4f9175474a54bd198b382add790718b7b8aae`.
  Its offered-source artifact is 464,462 bytes, SHA-256
  `f4ddaa4d0d1f93b58276656f391764224a5d0ee1f38216b3fb3acbb94faa3d1e`.
- Kitchen Sink `0.3.5` candidate: 428,073 bytes, SHA-256
  `885fb6555d7a36e7856cad1c5ce31ad19922de1371ec26f81fc52052cf889602`.
  Its offered-source artifact is 398,027 bytes, SHA-256
  `5429bc579003b9eee58f06d0713b01960482998f4ceebfe55005e49fca62ea0e`.
- Repeat packaging produced identical archive and offered-source bytes for
  Wallet and Kitchen Sink. Kernel's final binding check also matched after its
  qualification and full test repeat.
- Kitchen Sink now contains the real fixed ICP consumer demo and replaces the
  disposable Swap package: direct transfer and short-lived allowance requests
  target Neutrinite governance through the installed Wallet provider.
- A low-risk display residual remains: a hostile ledger error can contain
  confusing Unicode control/bidirectional text. Errors are bounded and cannot
  bypass consent or cause another ledger effect; a later ASCII-safe error
  projector can remove the visual ambiguity.
- Production update-source batch 36 published only Kernel `0.3.23`, Kitchen
  Sink `0.3.5`, and Wallet `0.3.6` plus their exact offered-source objects. The
  repeated canonical catalog publication returned `batch_id: null` with all
  16 package and source rows `unchanged`. The Dispenser starter selection and
  installed canisters remain unchanged.

## Goal

Make the installed Wallet the trusted token-transaction provider for other
Neutron apps while keeping Kernel completely token-agnostic.

- A person clicks **Swap** and makes one decision in trusted Kernel chrome using
  details prepared by Wallet.
- Wallet then uses an exact preapproved self update to perform an ICRC-1
  transfer or an ICRC-2 approval through the Wallet backend.
- A direct root agent can make the same call without owner UI. A nested
  Swap-to-Wallet call is decided by the root agent, never by an owner dialog.
- Wallet shows outstanding approvals for selected/access-approved ledgers and
  lets the owner revoke them.
- Kitchen Sink is the executable consumer reference for Swap apps. It uses real
  Wallet calls without pretending to be a DEX or taking backend ledger
  authority.

## Final architecture decision

Use one generic **provider-mediated, one-shot review** mechanism.

The ordinary tool prompt alone is not sufficient: Kernel authorizes the call
before the target tool handler runs, so it can display only caller-supplied raw
arguments. Wallet must first read authoritative ledger metadata, decimals,
fees, and current allowance. A simple `exact_once` flag would remove reusable
session permission, but would not move review preparation to Wallet.

The minimal correct flow is:

```text
Human
Swap app
  -> app:wallet:background / wallet_fund_v1
  -> Wallet prepares authoritative ledger facts
  -> Wallet requests one invocation-scoped Kernel review
  -> owner approves once
  -> Wallet context.kernel.updateSelf(...)
  -> Wallet backend -> ledger
  -> receipt -> Swap

Agent Mode
root agent or agent-invoked Swap
  -> the same Wallet tool and Wallet-prepared review
  -> direct root auto-allows, or nested call is decided by the root agent
  -> no owner dialog
  -> the same preapproved Wallet backend path
```

This is intentionally not a Wallet-specific Kernel API. Kernel transports and
renders bounded inert JSON, identifies the installed caller and provider, and
routes the decision. It never interprets tokens, ledgers, ICRC standards,
symbols, decimals, fees, recipients, spenders, or swap semantics.

## Backward compatibility requirement

All previously released apps and their installed state must continue to work.
This is a release gate, not a best-effort goal.

| Combination | Required behavior |
| --- | --- |
| New Kernel + any existing app | Valid existing tools, queries, updates, session grants, Agent flows, attachments, control tools, and self calls behave as before. The new annotation/context field is optional. Malformed tool arguments now fail before permission UI. |
| New Kernel + old Wallet | Old Wallet works unchanged. The new funding tool and Approvals screen are simply absent. |
| Old Kernel + new Wallet | Existing Wallet functionality continues to work. The old Kernel may first apply its released ordinary cross-app prompt/grant route to the new tool, but once the handler runs it finds no scoped callback and fails before preparation/execution. It must never silently turn that generic grant into Wallet funding authority. |
| New Kernel + new Wallet | The one-review funding and approvals flow is enabled. |
| Existing custom-ledger installation | Existing balance, history, deposit, and transfer behavior remains usable. New allowance features show **permission required** until the owner grants the additional exact scopes. |

Compatibility rules:

- Do not change any existing tool envelope or required SDK context field. Add
  `requestApproval` as optional invocation metadata/context available only to
  annotated tools.
- Preserve ordinary cross-app authorization and session-grant behavior. The
  provider-mediated branch applies only to the exact new closed annotation.
- Keep every published Wallet Candid method and type compatible. In particular,
  retain the exact contact-only `wallet_transfer` signature and semantics; add
  new versioned named-record methods instead of overloading it.
- Preserve all released Kernel and Wallet managed-memory roots and lock
  lineage. The new Wallet command root is additive and initializes without
  rewriting existing Wallet state.
- Do not require existing apps to add capabilities, change manifests, rebuild,
  or adopt the new SDK to continue operating.
- Unknown/unsupported consent annotations must never grant authority. New
  Wallet code checks for the scoped callback before any new funding preparation
  or execution, which makes partial/rolling installation fail closed.
- The separately authorized release published the compatible Kernel, Wallet,
  and Kitchen Sink successors together. Partial-upgrade directions remain
  tested because Settings may install only one package.

## Trust boundary

The owner explicitly trusts the exact installed Wallet package, including its
tile, tray, resident service, backend methods, manifest, and upgrades. Listing
Wallet methods in `preapproved_self_calls` makes that trust explicit.

Kernel remains responsible for generic platform guarantees:

- authenticate and display the exact caller and Wallet endpoint;
- bind the review to one caller session, Wallet session/app scope, tool call,
  cancellation signal, and Agent invocation;
- preserve unforgeable root-agent provenance;
- provide trusted dialog chrome, fixed **Allow once**/**Reject** controls, timeout,
  attention admission, endpoint invalidation, and safe text rendering;
- ensure no exact or wildcard session grant substitutes for this decision.

Wallet owns all financial meaning and execution:

- ledger selection, metadata, symbols, decimals, fees, balances, and formatting;
- ICRC-1 transfer and ICRC-2 allowance semantics;
- exact recipient/spender accounts and short allowance expiration;
- preparation, durable idempotency, reconciliation, receipts, history, approval
  enumeration, and revocation;
- its narrow policy for authenticated Agent Mode requests.

Swap owns its quote, minimum output, deadline, DEX reservation, and post-funding
execution. Source-review agents are defense in depth; source inspection does not
replace runtime capability, amount, account, expiry, and retry bounds.

All app backends share the Neutron canister principal. A backend
`icrc2_transfer_from` caller therefore cannot consume an allowance owned by a
different canister principal. In the Kitchen Sink reference, the spender is
Neutrinite governance (`eqsml-lyaaa-aaaaq-aacdq-cai`), so only that canister can
consume the allowance. Kitchen Sink deliberately stops after approval and has
no ledger mutation reservation. Kernel remains unaware of these token
semantics.

Wallet rejects its own default source account as spender, treating an absent
(`null`) subaccount and the all-zero subaccount as equivalent. Direct-calling
Swap apps and fixtures must use a distinct exact spender subaccount because
ICRC-2 same-account `transfer_from` is not allowance-bounded.

## Existing code to reuse

| Need | Existing implementation to extend |
| --- | --- |
| Typed tools and argument validation | `packages/neutron-tools/src/app.ts` and `protocol.ts` |
| Caller, Agent Mode, cancellation, scoped self calls | `MsgBusToolContext` and `context.kernel.updateSelf()` |
| One-shot dialog lifecycle | `requestFrontendToolPermission`, its `onceOnly` state, owner attention, and `Requests.tsx` |
| Safe exact JSON display | `CanonicalJsonReview` / `canonicalJsonForDisplay` in `apps/kernel/src/Requests.tsx` |
| Existing trusted Wallet send | `apps/wallet/src/index.tsx` and contact-only `wallet_transfer` |
| ICRC transfer/approve request builders | `apps/wallet/backend/icrc1/Client.mo` and `Types.mo` |
| Token amount formatting | `apps/wallet/src/format.ts` |
| ICRC account JSON decoding | `packages/neutron-tools/src/icrc_account.ts` |
| Approval history parsing | Wallet ICRC/ICP history adapters and Wallet Activity components |
| Additive memory roots | compiler `initialize` planning and the multiple-root pattern in the memory migration docs |
| Full ledger fixtures | existing `full_protocol_fixtures` local profile |

Do not add a second dialog store, Wallet iframe/modal protocol, SDK-specific
Wallet client, token-shaped Kernel method, parallel ICRC approve implementation,
or a second Wallet UI for the tray.

## 1. Generic Kernel and SDK review primitive

- Add one closed tool descriptor annotation:

  ```json
  { "neutron:consent": "provider_once" }
  ```

- Validate the closed annotation value beside the existing `neutron:audit`,
  `neutron:control`, and `neutron:visibility` annotations.
- Move `validateToolArguments()` before authorization for ordinary tool calls,
  matching the attachment path. Invalid input must not create a prompt or run
  Wallet preparation.
- For a cross-app `provider_once` tool, skip the ordinary preliminary tool
  grant and dispatch the provider with a private random one-use capability.
- For a non-Agent call, capture and require the requesting focused tile's
  transient user activation before asynchronous descriptor/preparation work.
  Preserve the existing provenance-stripping check so an app inside an Agent
  turn cannot drop invocation metadata and redirect the decision to owner UI.
- Bind that capability to the original caller object/session/app scope, target
  endpoint/session/app scope, exact tool, current endpoint versions, abort
  signal, Agent invocation, and canonical digest of the validated original
  arguments. Do not place it in public tool arguments.
- Add an optional invocation-scoped callback to `MsgBusToolContext`:

  ```ts
  context.requestApproval(review: JsonObject): Promise<void>
  ```

- Expose the callback only for an active annotated invocation. It is private,
  non-discoverable, one-use, abort-aware, and accepts only a JSON object bounded
  to 16 KiB plus the ordinary depth/element limits.
- Human route: reuse `requestFrontendToolPermission` with `onceOnly: true` and
  the Wallet-authored review as its arguments. Fix `onceOnly` so it ignores
  existing exact and wildcard grants as well as preventing a new grant.
- Render the Wallet-authored review prominently with the existing canonical,
  bidi-safe JSON renderer. Keep technical endpoint details available, label the
  content as supplied by Wallet, and show Kernel-attested caller and Wallet
  identities. Do not offer **Allow session**.
- Agent route: direct root calls resolve automatically; nested calls send the
  complete Wallet-authored review to the existing root-agent challenge. Do not
  reduce it to argument count/byte count and never open owner UI.
- Reject replay, a second callback, wrong endpoint/tool/session, endpoint
  replacement, timeout, cancellation, or invocation completion. Recheck both
  endpoint versions after every await.
- Require every dispatched cross-app provider handler to complete the callback
  exactly once before it returns. A return without approval is an invalid
  request even when the Wallet command already has a durable terminal result;
  command idempotency never becomes reusable consent.
- Initially reject this annotation on attachment and control tools to keep the
  primitive narrow.
- An older Kernel must fail closed: the new Wallet handler checks that
  `context.requestApproval` exists before preparing or executing a new command.
  Kernel and Wallet remain one intended compatible release set, subject to the
  qualification and separate publication gates below.

This mechanism deliberately trusts the provider to request approval before a
preapproved effect. Kernel cannot prove ordering without adding token/provider
policy or a much larger gated-self-call system. That trust is acceptable here
because the user explicitly trusts the reviewed Wallet package.

No Kernel managed-memory change, Wallet-specific manifest field,
`background_ui_requests`, or Wallet `agent_entrypoints` capability is needed.

## 2. Wallet's public funding tool

Expose one stable resident tool at the exact known endpoint
`app:wallet:background`, named `wallet_fund_v1`. Swap callers use that exact
endpoint and name; they must not call cross-app `tools.list` first, because
listing itself crosses a permission boundary.

Use one closed tagged request. JSON integers remain strings:

```text
requestId: random bounded caller-scoped id, at least 128 bits
ledger: ledger principal
amountAtoms: base-unit Nat string to deliver/swap
validUntilNs: bounded freshness deadline
route:
  direct:
    to: exact ICRC Account
    memoHex: optional bounded memo
  allowance:
    spender: exact ICRC Account
    expiresAtNs: exact short expiration
```

Do not accept symbol, decimals, fee, Wallet identity, caller identity, Agent
identity, friendly recipient/spender labels, arbitrary method names, or
app-authored review prose as authoritative input. Kernel supplies caller and
Agent context; Wallet fetches and formats all token facts.

For an allowance request, `amountAtoms` is the amount the DEX intends to pull.
Wallet computes and displays:

- the swap amount;
- the current `transfer_from` fee;
- the exact absolute allowance, normally amount plus transfer fee;
- the separate approval fee;
- the maximum total source-account debit;
- the exact spender account and expiration;
- the ledger principal, raw atoms, command ID, and the current-to-replacement
  absolute allowance alongside formatted Wallet/ledger-supplied metadata.

Use a fixed Wallet maximum lifetime and reject stale requests. If a fee,
allowance, metadata value, or expiry changes between preparation and execution,
fail closed and require a fresh request/review; never silently increase a fee or
allowance.

Return a closed result distinguishing `transferred`, `approved`, `revoked`,
`pending`, and `rejected`, with Nat values represented as strings and the
Wallet command ID in every non-validation result. `revoked` belongs to the
shared Wallet command result used by its Approvals UI; the public funding input
still exposes only direct transfer and ICRC-2 allowance routes.

`pending` means that a value-moving call may have committed but Wallet does not
yet possess authoritative completion evidence. It is not a safe-to-retry error.
The caller must reuse the same immediate-caller/request-ID/intent tuple. After a
fresh one-shot provider decision, Wallet either reconciles authoritative state,
replays only the exact frozen arguments when that ledger protocol makes the
replay safe, or returns the same pending command. It never substitutes a new
request ID or rebuilds arguments after an ambiguous outcome.

The service handler must:

1. Require the scoped approval callback before doing new provider-mediated work.
2. Derive requester identity and Agent Mode only from `context`.
3. Call the backend only through `context.kernel.updateSelf()`, never the
   module-level helper, so invocation provenance and cancellation remain bound.
4. Prepare or load the exact command and build the Wallet-authored review from
   its authoritative durable response.
5. Await exactly one Kernel/root-agent decision, including for terminal or
   pending replays of a prior invocation.
6. Return an existing terminal result after that decision. For `prepared` or
   `pending`, call only `wallet_funding_execute_v1` with the same command key so
   the backend performs first dispatch or protocol-safe reconciliation.
7. Honor `context.signal` throughout. Cancellation prevents later work but
   cannot turn an already-dispatched update into a definite failure.

## 3. Existing Wallet send

- Add the existing exact `wallet_transfer` method to Wallet's
  `preapproved_self_calls` list.
- Change the current Wallet **Send/Withdraw** action from
  `createCanisterClient(...).callDialog("wallet_transfer", ...)` to
  `updateSelf("wallet_transfer", ...)`.
- Keep `wallet_transfer` contact-only, revision-bound, and otherwise
  backward-compatible. Do not add optional arbitrary-destination, allowance, or
  request-ID behavior to the published method.
- The Wallet button remains the one trusted approval. There is no second Kernel
  backend-call dialog.

## 4. Wallet backend protocol and shared execution

Add versioned named-record methods instead of changing the meaning of
`wallet_transfer`:

- `wallet_funding_prepare_v1`
  - receives only data supplied by the trusted Wallet handler, including its
    Kernel-attested immediate caller app ID/mode;
  - validates a selected/reserved ICRC ledger, default Wallet source account,
    exact full Account values, amount, freshness, and bounded expiration;
  - fetches live metadata, fee, and current allowance where applicable;
  - freezes the reviewed command and returns a bounded review DTO plus command
    key;
  - on an identical request key, returns the existing command and review; the
    same key with different intent is a conflict. Pending reconciliation occurs
    only through the execute method for that same key.
- `wallet_funding_execute_v1`
  - accepts only an existing command key; terminal commands return their
    durable result, while prepared and pending commands enter dispatch or
    recovery;
  - revalidates review-sensitive metadata before value movement;
  - persists exact ledger Candid arguments and `created_at_time` before the
    first value-moving await;
  - calls only `icrc1_transfer` or `icrc2_approve`, chosen by a closed stored
    kind; no arbitrary `(canister, method, args)` execution;
  - accepts an exact ledger `Duplicate` as the receipt for an exact replay;
  - classifies definite ledger rejection separately from ambiguous broker
    outcome and never rebuilds arguments for a retry;
  - for a pending ICRC command, first reconciles allowance state where
    applicable and otherwise reuses only the frozen Candid bytes and timestamp;
    a replay rejection without authoritative evidence remains pending;
  - for a pending ICP `remove_approval`, lists again and succeeds only if the
    exact approval disappeared. Because legacy ICP has no CAS/idempotency
    timestamp, it never automatically sends a second fee-bearing removal.
- `wallet_allowances_page_v1`
  - is a preapproved Wallet update because it must call remote ledger query
    methods in replicated execution;
  - returns a bounded page for one selected ledger/default Wallet account.

Use one internal transfer executor and one internal approval executor. Factor
the selected-ledger checks, fee handling, reply decoding, Duplicate handling,
history recording, balance invalidation, and errors out of the current path
instead of copying them.

Generalize the existing ICRC approval request builder to accept:

- a complete spender `Account`, including optional subaccount;
- exact amount and fee;
- `expected_allowance` CAS;
- exact expiration and fixed `created_at_time`.

Keep native Bitcoin, Dogecoin, Ethereum, ERC-20 withdrawals, standing
allowances, and arbitrary DEX calls outside this protocol. Cross-app funding is
ICRC-only in the first release.

## 5. Durable idempotency without migrating Wallet v1

The current heap-only `transferInFlight` flag and newly generated timestamp are
not enough for agent retries or lost replies. Add a new independent managed
memory root named `wallet_commands` at schema version 1. Leave
`memory/wallet/v1.mo`, its lock lineage, and all released schemas byte-for-byte
unchanged.

The upgrade plan is exactly:

```text
#keep wallet v1
#initialize wallet_commands v1
```

No Wallet v2 schema and no migration module are needed.

Keep the new root lean: one bounded map keyed by `(caller app id, request id)`.
Each record stores only:

- a canonical bounded intent/hash and freshness deadline;
- closed kind: ICRC-1 transfer, ICRC-2 approve, or revoke;
- ledger principal and exact Wallet-created Candid arguments;
- prepared review facts needed for comparison/audit;
- state: `prepared`, `pending`, `succeeded(receipt)`, or
  `rejected(definite error)`;
- immediate caller app/role and whether the request was in Agent Mode.

Kernel remains the authoritative durable/diagnostic source for the full root
invocation chain; do not expand the Wallet protocol merely to copy it.

Use a small fixed capacity. Expired `prepared` and old terminal records may be
cleaned by bounded scans; never evict `pending` work. At capacity with no safe
entry to remove, fail closed. Exact idempotency is guaranteed through the
request deadline plus the documented retention window. An expired `prepared`
command is rejected before dispatch. A command which became `pending` after
dispatch stays potentially committed across deadline, cancellation, browser
loss, and upgrade; never prune it or relabel it rejected merely because time
passed. After expiry Wallet may perform read-only authoritative reconciliation,
but it must not issue a fresh mutation. Once a terminal tombstone is pruned, an
intentionally reused ID is no longer distinguishable, so require a canonical
random ID of at least 128 bits; permanent replay protection would require
unbounded/permanent tombstones.

## 6. Approvals screen and revocation

Add **Approvals** beside Assets and Activity in the existing shared
`WalletApp`; reuse the current tile/tray app, token marks, amount formatter,
copy buttons, activity list/detail patterns, loading/error states, and
invalidation path.

“All approvals” means all approvals discoverable on the Wallet's selected and
backend-access-approved ledgers. There is no global registry that can discover
arbitrary ledgers the owner never selected.

- ICRC ledgers: call draft `icrc103_get_allowances` from the Wallet backend.
  Isolate its draft types/adapter so later standard changes do not spread.
- Start at the Wallet's exact default Account. Paginate with both the last
  `from_account` and `to_spender`, treat null and all-zero subaccount as the
  same default account, return only that source, and stop when results move to
  another Wallet-owned subaccount.
- Enforce page/entry/reply caps, strict cursor progress, valid Accounts, owner
  equality, nonzero allowances, and sane expirations.
- ICP: use its existing paginated `get_allowances` adapter and
  `remove_approval`, reusing the Wallet account-identifier codec.
- The legacy ICP adapter is selected only for the reviewed ICP principal and is
  used for listing/removal, not creation of a new Swap allowance. A custom
  ledger uses the ICRC path even if it exposes similarly named methods.
- A custom ledger without a complete ICRC-103 enumeration path shows
  **enumeration unsupported**. Do not invent a history-derived or known-spender
  list and call it complete.
- Standard ICRC-2 revoke: call
  `icrc2_approve(amount = 0, expected_allowance = displayed current)` and
  refresh. `AllowanceChanged` requires a refresh rather than an unconditional
  retry.
- ICP revoke has no CAS/idempotency timestamp. After an unknown result, list
  again before deciding whether any retry is safe.
- Display ledger/symbol, formatted remaining allowance, exact spender ICRC
  account or ICP account identifier, expiration, and the approval fee charged
  for revoke. The Wallet revoke button is the trusted approval and uses the
  same prepared/idempotent backend core; it needs no Kernel dialog.

Preset ledgers already use whole-principal backend reservations. Extend custom
ledger reservations only with the exact methods needed:

```text
icrc2_allowance
icrc2_approve
icrc103_get_allowances
```

Existing installations do not gain these reservations automatically. Reuse the
current ledger-settings reservation flow and show **permission required** until
the owner grants the missing exact scopes; do not introduce a surprise prompt
inside Swap or Approvals.

## 7. Swap consumer contract

Provide a fixed executable integration page in Kitchen Sink:

- Call exact `app:wallet:background` / `wallet_fund_v1`; do not discover tools
  through wildcard listing.
- Pin the example to ICP ledger `ryjl3-tyaaa-aaaaa-aaaba-cai`, requested value
  1,000,000 e8s (0.01 ICP), and Neutrinite governance
  `eqsml-lyaaa-aaaaq-aacdq-cai` as both direct destination and allowance
  spender.
- Direct route: Wallet performs the ICRC-1 transfer and returns the receipt.
- Allowance route: Wallet creates the exact five-minute allowance, including
  the live transfer fee. Approval itself moves no ICP, and Kitchen Sink cannot
  call `transfer_from` for a spender owned by Neutrinite governance.
- Retain the same request ID after pending or ambiguous outcomes so a retry
  cannot silently create another transfer.

Another token standard can be implemented by another trusted Wallet exposing
an analogous app-level tool. Kernel needs no new standard-specific support.

## 8. Tests and qualification

### SDK and Kernel

- Run the compatibility matrix above with representative previously released
  app packages, including an old Wallet on the new Kernel and the new Wallet on
  the old Kernel.
- Run the existing all-apps Kernel/tool/Agent test suites unchanged; no existing
  valid call path may gain an extra prompt or lose an existing grant.
- Annotation normalization accepts only `provider_once`.
- Invalid tool arguments fail before handler dispatch or review.
- Provider call has no preliminary prompt and no reusable grant.
- Exact and wildcard session grants cannot bypass provider review.
- Approval capability is one-use and bound to exact caller/target/tool/session,
  endpoint versions, cancellation, and Agent invocation.
- Reject, timeout, Escape, endpoint replacement, abort, and replay fail closed.
- Dialog shows Kernel-attested caller/provider, one **Allow once** action, no
  session action, and prominent canonical escape-safe Wallet JSON.
- Direct root agent produces zero owner dialogs. Nested Swap-to-Wallet sends the
  full Wallet review to the root and honors allow/deny.
- Ordinary tools retain their current grant behavior.

Extend the existing tool tests, `msg_bus.isolated.ts`, Agent Mode tests,
permission-dialog component tests, Playwright permission fixture, and scoped
self-call tests instead of building parallel harnesses.

### Wallet backend and memory

- Clean initialization of both roots and exact production Wallet v1 restoration.
- Upgrade an exact archived production Wallet package with representative
  selected ledgers, balances, metadata, history, native-deposit progress, and
  configuration, then prove all data and existing methods are preserved.
- Upgrade planning proves `keep wallet v1` plus `initialize wallet_commands v1`
  with no destructive root.
- Same request/same intent replays; same key/different intent conflicts.
- Lost reply and upgrade-at-await preserve one exact pending command. A
  same-key replay must reach backend reconciliation, reuse only frozen
  arguments where safe, accept exact `Duplicate`, and never create another
  mutation. A terminal replay returns its durable result only after the new
  provider invocation completes its own one-shot decision.
- Pending recovery before and after the command deadline, including the rule
  that expiry stops new dispatch but does not make an already-dispatched
  outcome rejected or evictable; also cover capacity and unresolved-entry
  retention.
- Exact ICRC-1 transfer and ICRC-2 approve/revoke arguments, fee failures,
  metadata change, `expected_allowance` race, malformed replies, and no
  arbitrary target/method.
- ICRC-103 pagination/default-account filtering/bounds, ICP listing/removal,
  unsupported custom ledger behavior, and reservation-required behavior.

### Wallet frontend and end to end

- Existing Wallet send uses one Wallet button and zero Kernel backend-call
  dialogs.
- Human direct and allowance funding each show exactly one Kernel review and
  never send on reject.
- Approved direct funding transfers once.
- Installed Kitchen Sink direct and allowance buttons each use one human
  decision. The browser test proves the direct ICP balance delta and the exact
  live governance allowance without attempting a false Kitchen Sink
  `transfer_from`.
- Root and nested Agent Mode flows create no owner prompt.
- Approvals render exact accounts, decimal amounts, fees, expirations, errors,
  loading, empty, incomplete, and unsupported states.

Run at minimum:

```sh
npm --workspace neutron-tools test
npm --workspace neutron-kernel test
npm --workspace neutron-wallet test
npm --workspace neutron-compiler test
npm run typecheck
npm run security:check
npm run license:check
```

Then run the complete Kernel and Wallet package commands and their release
qualification, including the Kernel certified-assets candidate binding and
final-candidate state-preserving PocketIC upgrade test.

## 9. Documentation

Update the existing docs rather than adding a competing architecture document:

- `apps/wallet/README.md`: trusted Wallet provider, funding contract,
  approvals/revoke support, custom-ledger limitations, and Agent behavior.
- `doc/app-method-access-and-call-consent.md`: provider-one-shot route,
  preapproved Wallet execution, no session-grant bypass, and Agent routing.
- `doc/kernel-app-communication.md`: annotation, private scoped callback,
  caller/provider attribution, cancellation, and complete review payload.
- `doc/app-developer-guide.md`: provider recipe and Swap consumer example.
- `doc/product-model-and-user-story.md`: explicit user trust in an installed
  Wallet while Kernel remains the platform trust root.
- `doc/open-questions-and-design-gaps.md`: resolve/narrow the current statement
  that every value-moving adapter requires immediate owner presence. Raw
  chain-key signing remains a separate stricter boundary.
- Update custom-ledger reservation examples and relevant testing/security docs.

## 10. Release order

- Preserve Kernel `kernel` v3 and `kernel_activation` v1 memory unchanged.
- Preserve Wallet `wallet` v1 unchanged and add only `wallet_commands` v1.
- Only after the state-compatible implementation and release tests are ready,
  set Kernel strictly above 322 (minimum 323) and Wallet strictly above 305
  (minimum 306). App versions and memory versions remain independent. A number
  present in a working-tree manifest is not evidence that its package passed.
- Keep production `update_source` as `233tv-xiaaa-aaaay-aacta-cai`.
- Package through the complete workspace commands; do not call pack scripts
  directly or rewrite historical archives, schemas, lock entries, fixtures, or
  release evidence. Packaging creates candidate bytes, not a qualification or
  publication claim.
- Kernel, Wallet, and Kitchen Sink became one compatible **Upgrade all** set
  only after the matrix and package qualification passed. The explicitly
  requested publication used one catalog transaction (batch 36), followed by
  the exact-byte receipt-v2 no-op with `batch_id: null` and every item
  `unchanged`.
- Publication occurred only after the explicit request and completed release
  qualification.
- Do not update the Dispenser starter package set unless that separate rollout
  is explicitly requested.

## Explicitly deferred

- Fully unattended/background roots beyond the current live Agent Mode turn.
  Current Agent Mode still starts from an enabled exact agent version, focused
  tile, and transient user activation; once live, funding needs no owner dialog.
- Wallet-controlled swap/DEX orchestration.
- Standing or unlimited allowances, caller-selected long lifetimes, per-agent
  budgets, spender reputation/attestation, and automatic post-swap revoke.
- Native-chain and ERC-20 cross-app withdrawals.
- Global allowance discovery for ledgers the Wallet cannot know or access.
- Generic wallet-provider discovery or wildcard tool listing.

These can be considered later without putting token or app-specific knowledge
into Kernel.
